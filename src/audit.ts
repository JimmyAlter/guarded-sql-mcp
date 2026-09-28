/**
 * JSON-lines audit log. Written to stderr by default because stdout is the
 * MCP stdio channel: anything else printed there would corrupt the protocol.
 */

export type LineWriter = (line: string) => void;

export const stderrWriter: LineWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

export interface ToolCallRecord {
  readonly tool: string;
  readonly args: unknown;
  readonly rowCount: number;
  readonly durationMs: number;
  readonly outcome: 'ok' | 'error';
  /** More rows matched than were returned. */
  readonly hasMore?: boolean;
  /** The response size limits cut a cell or dropped rows. */
  readonly truncated?: boolean;
  /** UTF-8 size of the JSON body sent to the model. */
  readonly responseBytes?: number;
  /** What the size limits removed, when truncated is true. */
  readonly truncation?: { readonly cellsTruncated: number; readonly rowsDropped: number };
  /** Keys removed by output projection. Sensitive drops indicate a catalog or schema problem. */
  readonly dropped?: { readonly undeclared: readonly string[]; readonly sensitive: readonly string[] };
  /** Internal error details. Never sent to the model. */
  readonly error?: { readonly code?: string; readonly message: string };
}

export interface AuditOptions {
  /**
   * Replace every string argument with "[redacted]" before it is logged.
   * Search text (for example a person's name in find_people) is personal data
   * that the log would otherwise keep verbatim. Numbers and booleans are kept.
   */
  readonly redactArgs?: boolean;
}

export const REDACTED = '[redacted]';

/** Returns a copy of `value` with every string, at any depth, replaced by REDACTED. */
export function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactStrings(inner)]));
  }
  return value;
}

export class AuditLog {
  constructor(
    private readonly write: LineWriter = stderrWriter,
    private readonly now: () => Date = () => new Date(),
    private readonly options: AuditOptions = {},
  ) {}

  toolCall(record: ToolCallRecord): void {
    const args = this.options.redactArgs === true ? redactStrings(record.args) : record.args;
    this.emit({ event: 'tool_call', ...record, args });
  }

  event(event: string, data: Record<string, unknown> = {}): void {
    this.emit({ event, ...data });
  }

  private emit(fields: Record<string, unknown>): void {
    // JSON.stringify escapes newlines inside values, so one record is one line.
    this.write(JSON.stringify({ ts: this.now().toISOString(), ...fields }));
  }
}
