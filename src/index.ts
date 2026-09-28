#!/usr/bin/env node
/**
 * stdio entrypoint. stdout carries MCP JSON-RPC; all logging goes to stderr.
 *
 * Environment:
 *   DATABASE_URL          required, e.g. postgres://mcp_readonly:...@localhost:5432/inventory
 *   STATEMENT_TIMEOUT_MS  optional, default 5000
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLog } from './audit.js';
import { CATALOG } from './catalog.js';
import { PgExecutor } from './executor.js';
import { DEFAULT_STATEMENT_TIMEOUT_MS } from './policy.js';
import { checkConnectedRole } from './roleCheck.js';
import { createServer } from './server.js';
import { validateCatalog } from './validateCatalog.js';

async function main(): Promise<void> {
  const audit = new AuditLog();

  // Refuse to start with a bad catalog, before any connection is attempted.
  validateCatalog(CATALOG);

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }
  const statementTimeoutMs = parseTimeout(process.env['STATEMENT_TIMEOUT_MS']);

  const executor = PgExecutor.connect(databaseUrl, {
    statementTimeoutMs,
    onPoolError: (err) => {
      audit.event('pool_error', { message: err.message });
    },
  });
  const server = createServer(executor, { audit });
  await server.connect(new StdioServerTransport());
  audit.event('startup', { tools: CATALOG.map((q) => q.name), statementTimeoutMs });

  // Non-blocking: the server stays up if the database is not reachable yet.
  checkConnectedRole(executor)
    .then((warnings) => {
      for (const warning of warnings) audit.event('privilege_warning', { warning });
    })
    .catch((err: unknown) => {
      audit.event('role_check_failed', { message: err instanceof Error ? err.message : String(err) });
    });

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    audit.event('shutdown', { reason });
    await server.close().catch(() => undefined);
    await executor.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin closed'));
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_STATEMENT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 600_000) {
    throw new Error(`STATEMENT_TIMEOUT_MS must be an integer between 1 and 600000, got '${raw}'`);
  }
  return value;
}

main().catch((err: unknown) => {
  process.stderr.write(`guarded-sql-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
