/**
 * Integration tests against a real PostgreSQL loaded with db/schema.sql,
 * db/roles.sql and db/seed.sql, connected AS mcp_readonly.
 *
 * Skipped unless DATABASE_URL is set. Set REQUIRE_INTEGRATION=1 (CI does) to
 * turn a missing DATABASE_URL into a failure instead of a silent skip.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit.js';
import { CATALOG } from '../../src/catalog.js';
import { PgExecutor } from '../../src/executor.js';
import { isSensitiveColumn } from '../../src/policy.js';
import { checkConnectedRole } from '../../src/roleCheck.js';
import { createServer } from '../../src/server.js';

const DATABASE_URL = process.env['DATABASE_URL'];

if (process.env['REQUIRE_INTEGRATION'] === '1' && !DATABASE_URL) {
  throw new Error('REQUIRE_INTEGRATION=1 but DATABASE_URL is not set');
}

/** Values planted in db/seed.sql that must never appear in any tool output. */
const SEEDED_SECRETS = /argon2id|SEED-ONLY|seed-only-token/;

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...allKeys(inner)]);
  }
  return [];
}

async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? `no code: ${String(err)}`;
  }
}

describe.skipIf(!DATABASE_URL)('PostgreSQL, connected as mcp_readonly', () => {
  let raw: pg.Client;
  let executor: PgExecutor;
  let mcp: Client;
  let closeServer: () => Promise<void>;
  const audit: string[] = [];

  beforeAll(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    const { rows } = await raw.query<{ role: string; rolsuper: boolean }>(
      'SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    if (rows[0]?.rolsuper) {
      throw new Error(
        `Connected as superuser '${rows[0].role}'. Use the mcp_readonly role: permission tests are meaningless otherwise.`,
      );
    }

    executor = PgExecutor.connect(DATABASE_URL!, { statementTimeoutMs: 5_000 });
    const server = createServer(executor, { audit: new AuditLog((line) => audit.push(line)) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'integration-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    closeServer = () => server.close();
  });

  // beforeAll may have failed part-way, so any of these can still be unset.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  afterAll(async () => {
    await mcp?.close();
    await closeServer?.();
    await executor?.close();
    await raw?.end();
  });
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return { result, text, body: result.isError ? undefined : (JSON.parse(text) as { rowCount: number; rows: object[] }) };
  }

  describe('catalog tools over MCP', () => {
    it.each(CATALOG.map((entry) => [entry.name, entry] as const))(
      '%s returns rows for its example input, with only declared, non-sensitive keys',
      async (name, entry) => {
        const { result, text, body } = await call(name, entry.example);
        expect(result.isError, text).toBeFalsy();
        expect(body!.rowCount).toBeGreaterThan(0);
        // Validated against the tool's outputSchema by the SDK on both ends.
        expect(result.structuredContent).toEqual(body);

        const keys = allKeys(body!.rows);
        expect(keys.filter(isSensitiveColumn)).toEqual([]);
        for (const row of body!.rows) {
          expect(entry.columns).toEqual(expect.arrayContaining(Object.keys(row)));
        }
        expect(text).not.toMatch(SEEDED_SECRETS);
      },
    );

    it('get_device includes the assigned person but none of their credentials', async () => {
      const { body, text } = await call('get_device', { hostname: 'NB-LT-001' });
      expect(body!.rows).toEqual([
        expect.objectContaining({
          hostname: 'nb-lt-001',
          site: 'north-branch',
          assigned_to: 'Sam Rivera',
          assigned_email: 'sam.rivera@example.com',
        }),
      ]);
      expect(text).not.toMatch(SEEDED_SECRETS);
    });

    it('reports hasMore only when more rows matched than the limit', async () => {
      expect((await call('find_people', { name_or_email: 'example.com', limit: 1 })).body).toMatchObject({
        rowCount: 1,
        hasMore: true,
      });
      expect((await call('find_people', { name_or_email: 'example.com', limit: 9 })).body).toMatchObject({
        rowCount: 9,
        hasMore: false,
      });
      expect((await call('list_sites', {})).body).toMatchObject({ rowCount: 3, hasMore: false });
    });

    it('find_people treats % and _ as literal characters', async () => {
      expect((await call('find_people', { name_or_email: '__' })).body!.rowCount).toBe(0);
      expect((await call('find_people', { name_or_email: '%%' })).body!.rowCount).toBe(0);
      expect((await call('find_people', { name_or_email: 'example.com' })).body!.rowCount).toBe(9);
    });

    it('handles a quote in search text as data', async () => {
      const { body } = await call('find_people', { name_or_email: "o'neil" });
      expect(body!.rows).toEqual([expect.objectContaining({ full_name: "Drew O'Neil" })]);
    });

    it.each([
      ['find_people', { name_or_email: "%' OR '1'='1" }],
      ['find_people', { name_or_email: "'; DROP TABLE people;--" }],
      ['find_people', { name_or_email: "x' UNION SELECT password_hash, email, department, 'x' FROM people--" }],
      ['search_devices', { os_contains: "' OR 1=1 --" }],
      ['device_software', { hostname: 'nb-lt-001', name_contains: "'; SELECT token_hash FROM api_tokens;--" }],
    ])('%s with injection-looking input %j returns zero rows, not an error', async (name, args) => {
      const { result, body, text } = await call(name, args);
      expect(result.isError, text).toBeFalsy();
      expect(body!.rowCount).toBe(0);
    });

    it('left every table intact after the injection attempts', async () => {
      expect((await call('list_sites', {})).body!.rowCount).toBe(3);
      expect((await call('find_people', { name_or_email: 'example.com', limit: 100 })).body!.rowCount).toBe(9);
    });

    it('audited every call without writing any seeded secret to the log', () => {
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.join('\n')).not.toMatch(SEEDED_SECRETS);
    });
  });

  describe('executor transaction', () => {
    it.each([
      "INSERT INTO sites (code, name, city) VALUES ('rogue-site', 'Rogue', 'Nowhere')",
      "UPDATE devices SET status = 'retired'",
      'DELETE FROM tickets',
    ])('rejects a write inside the READ ONLY transaction: %s', async (sql) => {
      // 25006 = read_only_sql_transaction, raised before the permission check.
      expect(await pgErrorCode(executor.query(sql, []))).toBe('25006');
    });

    it('runs with transaction_read_only = on and the configured statement_timeout', async () => {
      const [row] = await executor.query(
        "SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout",
        [],
      );
      expect(row).toEqual({ ro: 'on', timeout: '5s' });
    });

    it('cancels a statement that exceeds the timeout', async () => {
      const fast = PgExecutor.connect(DATABASE_URL!, { statementTimeoutMs: 200 });
      try {
        // 57014 = query_canceled (statement timeout)
        expect(await pgErrorCode(fast.query('SELECT pg_sleep(3)', []))).toBe('57014');
        // The connection was rolled back and is usable again.
        expect(await fast.query('SELECT 1 AS ok', [])).toEqual([{ ok: 1 }]);
      } finally {
        await fast.close();
      }
    });
  });

  describe('database role (db/roles.sql)', () => {
    it.each([
      'SELECT token_hash FROM api_tokens',
      'SELECT count(*) FROM api_tokens',
      'SELECT password_hash FROM people',
      'SELECT mfa_secret FROM people',
      'SELECT * FROM people',
      'SELECT row_to_json(p) FROM people p',
      'SELECT p FROM people p',
    ])('is denied: %s', async (sql) => {
      // 42501 = insufficient_privilege. Proves the objects exist and are refused.
      expect(await pgErrorCode(raw.query(sql))).toBe('42501');
    });

    it('can read the granted columns of people', async () => {
      const { rows } = await raw.query('SELECT full_name, email, department FROM people ORDER BY full_name LIMIT 1');
      expect(rows).toHaveLength(1);
    });

    it('has read-only sessions and bounded timeouts by default (ALTER ROLE ... SET)', async () => {
      // A fresh session, without the executor's BEGIN READ ONLY / SET LOCAL.
      const fresh = new pg.Client({ connectionString: DATABASE_URL });
      await fresh.connect();
      try {
        const show = async (setting: string) =>
          (await fresh.query<Record<string, string>>(`SHOW ${setting}`)).rows[0]?.[setting];
        expect(await show('default_transaction_read_only')).toBe('on');
        expect(await show('statement_timeout')).toBe('5s');
        expect(await show('idle_in_transaction_session_timeout')).toBe('10s');
        // 25006 = read_only_sql_transaction: even autocommit writes are refused.
        expect(await pgErrorCode(fresh.query("UPDATE sites SET name = 'x'"))).toBe('25006');
      } finally {
        await fresh.end();
      }
    });

    it('cannot write even in an explicit READ WRITE transaction (grants, not just the session default)', async () => {
      // default_transaction_read_only is a default the role can override, so
      // the grants have to hold on their own.
      for (const sql of [
        "UPDATE sites SET name = 'x'",
        'CREATE TABLE scratch (id int)',
        'CREATE TEMP TABLE scratch (id int)',
      ]) {
        await raw.query('BEGIN READ WRITE');
        try {
          expect(await pgErrorCode(raw.query(sql)), sql).toBe('42501');
        } finally {
          await raw.query('ROLLBACK');
        }
      }
    });

    it('passes the startup privilege check with no warnings', async () => {
      // Covers superuser, BYPASSRLS, pg_read_all_data/pg_write_all_data,
      // CREATE on a schema, TEMP, writable tables, any privilege on api_tokens
      // and SELECT on people.password_hash / mfa_secret.
      expect(await checkConnectedRole(executor)).toEqual([]);
    });
  });
});

// The role check must also fire when it should. OWNER_DATABASE_URL (CI sets it)
// connects as the database owner, a superuser that can do all of the above.
const OWNER_DATABASE_URL = process.env['OWNER_DATABASE_URL'];

describe.skipIf(!OWNER_DATABASE_URL)('startup privilege check, connected as the owner', () => {
  it('warns about superuser, writes, api_tokens and sensitive columns', async () => {
    const owner = PgExecutor.connect(OWNER_DATABASE_URL!);
    try {
      const warnings = (await checkConnectedRole(owner)).join('\n');
      expect(warnings).toMatch(/connected as superuser/);
      expect(warnings).toMatch(/BYPASSRLS/);
      expect(warnings).toMatch(/member of pg_read_all_data, pg_write_all_data/);
      expect(warnings).toMatch(/can CREATE objects in schema public/);
      expect(warnings).toMatch(/can write to tables in schema public: .*people/);
      expect(warnings).toMatch(/outside ALLOWED_TABLES: api_tokens/);
      expect(warnings).toMatch(/SELECT sensitive columns: .*api_tokens\.token_hash.*people\.mfa_secret, people\.password_hash/);
    } finally {
      await owner.close();
    }
  });
});
