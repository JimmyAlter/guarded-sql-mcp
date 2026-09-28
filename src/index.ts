#!/usr/bin/env node
/**
 * stdio entrypoint. stdout carries MCP JSON-RPC; all logging goes to stderr.
 *
 * Environment (see src/config.ts and .env.example):
 *   DATABASE_URL          required, e.g. postgres://mcp_readonly:...@localhost:5432/inventory
 *   STATEMENT_TIMEOUT_MS  optional, default 5000
 *   MAX_RESPONSE_BYTES    optional, default 65536
 *   MAX_CELL_CHARS        optional, default 1000
 *   AUDIT_REDACT_ARGS     optional, default off: log string arguments as "[redacted]"
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLog } from './audit.js';
import { CATALOG } from './catalog.js';
import { loadConfig } from './config.js';
import { PgExecutor } from './executor.js';
import { checkConnectedRole } from './roleCheck.js';
import { createServer } from './server.js';
import { validateCatalog } from './validateCatalog.js';

async function main(): Promise<void> {
  // Refuse to start with a bad catalog, before any connection is attempted.
  validateCatalog(CATALOG);

  const config = loadConfig();
  const audit = new AuditLog(undefined, undefined, { redactArgs: config.auditRedactArgs });

  const executor = PgExecutor.connect(config.databaseUrl, {
    statementTimeoutMs: config.statementTimeoutMs,
    onPoolError: (err) => {
      audit.event('pool_error', { message: err.message });
    },
  });
  const server = createServer(executor, {
    audit,
    limits: { maxResponseBytes: config.maxResponseBytes, maxCellChars: config.maxCellChars },
  });
  await server.connect(new StdioServerTransport());
  audit.event('startup', {
    tools: CATALOG.map((q) => q.name),
    statementTimeoutMs: config.statementTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxCellChars: config.maxCellChars,
    auditRedactArgs: config.auditRedactArgs,
  });

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

main().catch((err: unknown) => {
  process.stderr.write(`guarded-sql-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
