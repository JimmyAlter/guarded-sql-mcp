/**
 * Shapes projected rows into the body that is sent to the model, and enforces
 * the response size limits. This is the last step before a result leaves the
 * server: every cell becomes a JSON scalar, long strings are cut, and trailing
 * rows are dropped until the serialized body fits in the byte budget.
 */
import type { Row } from './executor.js';
import { DEFAULT_MAX_CELL_CHARS, DEFAULT_MAX_RESPONSE_BYTES } from './policy.js';

/** What a cell can hold once it leaves the server. */
export type Cell = string | number | boolean | null;
export type OutputRow = Record<string, Cell>;

/** The JSON body of a successful tool call (text content and structuredContent). */
export interface ToolResultBody {
  /** Rows in this response. */
  readonly rowCount: number;
  /** More rows matched than this response contains: narrow the filters or lower the limit. */
  readonly hasMore: boolean;
  /** The size limits changed this response: at least one cell was cut or row dropped. */
  readonly truncated: boolean;
  readonly rows: OutputRow[];
}

export interface ResponseLimits {
  readonly maxResponseBytes: number;
  readonly maxCellChars: number;
}

export const DEFAULT_RESPONSE_LIMITS: ResponseLimits = {
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  maxCellChars: DEFAULT_MAX_CELL_CHARS,
};

export interface ShapedResponse {
  readonly body: ToolResultBody;
  /** `JSON.stringify(body)`, guaranteed to be at most `maxResponseBytes` UTF-8 bytes. */
  readonly text: string;
  readonly bytes: number;
  /** Cells whose string value was cut to `maxCellChars`. */
  readonly cellsTruncated: number;
  /** Rows dropped from the end to fit `maxResponseBytes`. */
  readonly rowsDropped: number;
}

/**
 * Cuts `value` to at most `maxChars` UTF-16 code units (never splitting a
 * surrogate pair) and appends a marker saying how much was removed.
 */
export function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let cut = maxChars;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut)}…[truncated ${value.length - cut} chars]`;
}

/**
 * Converts a value from the driver to a JSON scalar. Dates become ISO strings,
 * bigints and other non-JSON numbers become strings, and objects or arrays
 * (json/jsonb, arrays, bytea) are serialized to a JSON string, so the size
 * limits and the declared output schema apply to them too.
 */
function toCell(value: unknown, maxCellChars: number): { cell: Cell; cut: boolean } {
  let cell: Cell;
  if (value === null || value === undefined) {
    cell = null;
  } else if (typeof value === 'string' || typeof value === 'boolean') {
    cell = value;
  } else if (typeof value === 'number') {
    cell = Number.isFinite(value) ? value : String(value);
  } else if (typeof value === 'bigint') {
    cell = value.toString();
  } else if (value instanceof Date) {
    cell = Number.isNaN(value.getTime()) ? null : value.toISOString();
  } else if (typeof value === 'object') {
    cell = JSON.stringify(value);
  } else {
    // Functions and symbols cannot come from the driver and have no JSON form.
    cell = null;
  }
  if (typeof cell === 'string' && cell.length > maxCellChars) {
    return { cell: truncateString(cell, maxCellChars), cut: true };
  }
  return { cell, cut: false };
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

export function shapeResponse(
  rows: readonly Row[],
  hasMore: boolean,
  limits: ResponseLimits = DEFAULT_RESPONSE_LIMITS,
): ShapedResponse {
  let cellsTruncated = 0;
  const shaped: OutputRow[] = rows.map((row) => {
    const entries = Object.entries(row).map(([key, value]): [string, Cell] => {
      const { cell, cut } = toCell(value, limits.maxCellChars);
      if (cut) cellsTruncated += 1;
      return [key, cell];
    });
    return Object.fromEntries(entries);
  });

  // Upper bound on everything except the rows: the widest rowCount this body
  // can have and the longer spelling of both flags.
  const envelope = byteLength(JSON.stringify({ rowCount: shaped.length, hasMore: false, truncated: false, rows: [] }));
  const budget = limits.maxResponseBytes - envelope;
  let used = 0;
  let kept = 0;
  for (const row of shaped) {
    const cost = byteLength(JSON.stringify(row)) + (kept > 0 ? 1 : 0); // +1 for the comma
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }

  const rowsDropped = shaped.length - kept;
  const body: ToolResultBody = {
    rowCount: kept,
    hasMore: hasMore || rowsDropped > 0,
    truncated: cellsTruncated > 0 || rowsDropped > 0,
    rows: shaped.slice(0, kept),
  };
  const text = JSON.stringify(body);
  return { body, text, bytes: byteLength(text), cellsTruncated, rowsDropped };
}
