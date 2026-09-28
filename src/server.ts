/**
 * MCP server wiring. One tool per catalog entry and nothing else: there is no
 * tool that accepts SQL, and no code path that turns an argument into SQL text.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AuditLog } from './audit.js';
import { CATALOG, type CatalogEntry } from './catalog.js';
import { runQuery, type Executor } from './executor.js';
import { MAX_ROWS } from './policy.js';
import { validateCatalog } from './validateCatalog.js';

export const SERVER_NAME = 'guarded-sql-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  readonly catalog?: readonly CatalogEntry[];
  readonly audit?: AuditLog;
  readonly maxRows?: number;
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
  const maxRows = options.maxRows ?? MAX_ROWS;

  // A server is never built from a catalog that has not passed validation.
  validateCatalog(catalog);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only access to an IT asset inventory through a fixed set of queries. ' +
        `Each tool returns at most ${maxRows} rows as JSON.`,
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
      const hasDrops = result.dropped.undeclared.length > 0 || result.dropped.sensitive.length > 0;
      audit.toolCall({
        tool: entry.name,
        args,
        rowCount: result.rowCount,
        durationMs: elapsedMs(started),
        outcome: 'ok',
        hasMore: result.hasMore,
        ...(hasDrops ? { dropped: result.dropped } : {}),
      });
      const body = { rowCount: result.rowCount, hasMore: result.hasMore, rows: result.rows };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
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
