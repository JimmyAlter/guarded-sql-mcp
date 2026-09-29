/**
 * MCP server wiring. One tool per catalog entry and nothing else: there is no
 * tool that accepts SQL, and no code path that turns an argument into SQL text.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AuditLog } from './audit.js';
import { CATALOG, type CatalogEntry } from './catalog.js';
import { runQuery, type Executor } from './executor.js';
import { MAX_CELL_CHARS_BOUNDS, MAX_RESPONSE_BYTES_BOUNDS, MAX_ROWS } from './policy.js';
import { DEFAULT_RESPONSE_LIMITS, outputSchemaFor, shapeResponse, type ResponseLimits } from './response.js';
import { validateCatalog } from './validateCatalog.js';

export const SERVER_NAME = 'guarded-sql-mcp';
/**
 * Read from package.json, the single source of the version. The relative path
 * is the same from src/ (tests) and dist/ (the published build), and npm always
 * ships package.json.
 */
export const SERVER_VERSION = readPackageVersion();

function readPackageVersion(): string {
  const pkg: unknown = createRequire(import.meta.url)('../package.json');
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  throw new Error('package.json has no version');
}

export interface ServerOptions {
  readonly catalog?: readonly CatalogEntry[];
  readonly audit?: AuditLog;
  /** Row cap per call: an integer from 1 to MAX_ROWS (100). It can only lower the cap. */
  readonly maxRows?: number;
  /**
   * Response size limits. Defaults to 64 KiB per response and 1000 characters
   * per cell; values outside the bounds accepted from the environment are rejected.
   */
  readonly limits?: ResponseLimits;
}

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createServer(executor: Executor, options: ServerOptions = {}): McpServer {
  const catalog = options.catalog ?? CATALOG;
  const audit = options.audit ?? new AuditLog();
  // Options can only tighten the policy. A caller passing maxRows: 10_000
  // gets an error, not a server that returns 10,000 rows.
  const maxRows = checkedInteger('maxRows', options.maxRows ?? MAX_ROWS, { min: 1, max: MAX_ROWS });
  const limits: ResponseLimits = {
    maxResponseBytes: checkedInteger(
      'limits.maxResponseBytes',
      options.limits?.maxResponseBytes ?? DEFAULT_RESPONSE_LIMITS.maxResponseBytes,
      MAX_RESPONSE_BYTES_BOUNDS,
    ),
    maxCellChars: checkedInteger(
      'limits.maxCellChars',
      options.limits?.maxCellChars ?? DEFAULT_RESPONSE_LIMITS.maxCellChars,
      MAX_CELL_CHARS_BOUNDS,
    ),
  };

  // A server is never built from a catalog that has not passed validation.
  validateCatalog(catalog);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only access to an IT asset inventory through a fixed set of queries. ' +
        `Each tool returns at most ${maxRows} rows as JSON, and at most ${limits.maxResponseBytes} bytes. ` +
        'hasMore: true means more rows matched than were returned; narrow the filters. ' +
        'truncated: true means long values were cut or rows were dropped to fit the size limit.',
    },
  );

  for (const entry of catalog) {
    server.registerTool(
      entry.name,
      {
        title: entry.title,
        description: entry.description,
        // The SDK validates arguments against this strict schema before the
        // handler runs; runQuery parses them again before touching the database.
        inputSchema: entry.input,
        // Derived from the declared columns. Results carry the same body as
        // structuredContent and, for older clients, as JSON text.
        outputSchema: outputSchemaFor(entry.columns),
        annotations: TOOL_ANNOTATIONS,
      },
      (args) => callTool(entry, args),
    );
  }

  return server;

  async function callTool(entry: CatalogEntry, args: unknown): Promise<CallToolResult> {
    const started = performance.now();
    try {
      const result = await runQuery(executor, entry, args, maxRows);
      const response = shapeResponse(result.rows, result.hasMore, limits);
      const hasDrops = result.dropped.undeclared.length > 0 || result.dropped.sensitive.length > 0;
      audit.toolCall({
        tool: entry.name,
        args,
        rowCount: response.body.rowCount,
        durationMs: elapsedMs(started),
        outcome: 'ok',
        hasMore: response.body.hasMore,
        truncated: response.body.truncated,
        responseBytes: response.bytes,
        ...(response.body.truncated
          ? { truncation: { cellsTruncated: response.cellsTruncated, rowsDropped: response.rowsDropped } }
          : {}),
        ...(hasDrops ? { dropped: result.dropped } : {}),
      });
      return { content: [{ type: 'text', text: response.text }], structuredContent: { ...response.body } };
    } catch (err) {
      // Database errors can name tables, columns, constraints or values. The
      // model gets a generic message; the details go to the audit log only.
      audit.toolCall({
        tool: entry.name,
        args,
        rowCount: 0,
        durationMs: elapsedMs(started),
        outcome: 'error',
        error: describeError(err),
      });
      return {
        isError: true,
        content: [{ type: 'text', text: `The ${entry.name} query failed. Details were recorded in the server log.` }],
      };
    }
  }
}

function checkedInteger(name: string, value: number, bounds: { readonly min: number; readonly max: number }): number {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new RangeError(`${name} must be an integer between ${bounds.min} and ${bounds.max}, got ${value}`);
  }
  return value;
}

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

function describeError(err: unknown): { code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? { code, message: err.message } : { message: err.message };
  }
  return { message: String(err) };
}
