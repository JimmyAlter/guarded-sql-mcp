import { describe, expect, it } from 'vitest';
import { findPeople, getDevice, searchDevices } from '../../src/catalog.js';
import { PgExecutor, projectRows, runQuery, type PoolLike, type Row } from '../../src/executor.js';
import { FakeExecutor } from '../helpers/fakeExecutor.js';

describe('projectRows', () => {
  it('keeps only declared columns, in declared order, and reports what it dropped', () => {
    const rows = [{ email: 'a@example.com', full_name: 'Sam Rivera', site_id: 3, internal_note: 'x' }];
    const { rows: out, dropped } = projectRows(rows, ['full_name', 'email']);
    expect(out).toEqual([{ full_name: 'Sam Rivera', email: 'a@example.com' }]);
    expect(Object.keys(out[0]!)).toEqual(['full_name', 'email']);
    expect(dropped).toEqual({ undeclared: ['internal_note', 'site_id'], sensitive: [] });
  });

  it('strips everything undeclared when a query returns whole rows (the SELECT * scenario)', () => {
    const wholeRow: Row = {
      id: 7,
      full_name: 'Sam Rivera',
      email: 'sam.rivera@example.com',
      department: 'IT',
      site_id: 1,
      password_hash: '$argon2id$v=19$fake',
      mfa_secret: 'SEEDONLY',
    };
    const { rows, dropped } = projectRows([wholeRow], findPeople.columns);
    expect(rows).toEqual([{ full_name: 'Sam Rivera', email: 'sam.rivera@example.com', department: 'IT' }]);
    expect(JSON.stringify(rows)).not.toMatch(/argon2|SEEDONLY/);
    expect(dropped.sensitive).toEqual(['mfa_secret', 'password_hash']);
  });

  it('drops a sensitive column even if an entry declares it (validator bypassed)', () => {
    const { rows, dropped } = projectRows([{ code: 'a', api_key: 'k' }], ['code', 'api_key']);
    expect(rows).toEqual([{ code: 'a' }]);
    expect(dropped.sensitive).toEqual(['api_key']);
  });

  it('drops sensitive keys nested inside JSON values', () => {
    const row = {
      owner: {
        email: 'sam.rivera@example.com',
        password_hash: 'x',
        sessions: [{ token: 't', started: 1 }],
      },
    };
    const { rows, dropped } = projectRows([row], ['owner']);
    expect(rows).toEqual([{ owner: { email: 'sam.rivera@example.com', sessions: [{ started: 1 }] } }]);
    expect(dropped.sensitive).toEqual(['owner.password_hash', 'owner.sessions[].token']);
  });

  it('omits declared columns the row does not have instead of inventing values', () => {
    expect(projectRows([{ code: 'a' }], ['code', 'name']).rows).toEqual([{ code: 'a' }]);
  });

  it('keeps Date values intact and cannot be tricked by a __proto__ key', () => {
    const seen = new Date('2026-01-01T00:00:00Z');
    const row = JSON.parse('{"__proto__": {"polluted": true}, "code": "a"}') as Row;
    row['last_seen_at'] = seen;
    const [out] = projectRows([row], ['__proto__', 'code', 'last_seen_at']).rows;
    expect(out!['last_seen_at']).toBe(seen);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('runQuery', () => {
  it('enforces the row cap even if the executor returns more', async () => {
    const executor = new FakeExecutor(() => Array.from({ length: 500 }, (_, i) => ({ hostname: `h-${i}` })));
    const result = await runQuery(executor, searchDevices, {});
    expect(result.rowCount).toBe(100);
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('honours a lower cap and reports no truncation when under it', async () => {
    const executor = new FakeExecutor(() => [{ hostname: 'a' }, { hostname: 'b' }, { hostname: 'c' }]);
    expect((await runQuery(executor, searchDevices, {}, 2)).rowCount).toBe(2);
    expect((await runQuery(executor, searchDevices, {}, 5)).truncated).toBe(false);
  });

  it('sends the static SQL and bound parameters, never interpolated text', async () => {
    const executor = new FakeExecutor();
    await runQuery(executor, searchDevices, { os_contains: "50%'; DROP TABLE devices;--" });
    const [call] = executor.calls;
    expect(call!.sql).toBe(searchDevices.sql);
    expect(call!.params).toEqual([null, null, "%50\\%'; DROP TABLE devices;--%", 25]);
  });

  it('re-validates input, so invalid arguments never reach the executor', async () => {
    const executor = new FakeExecutor();
    await expect(runQuery(executor, getDevice, { hostname: "x'; DROP TABLE devices;--" })).rejects.toThrow();
    await expect(runQuery(executor, getDevice, { hostname: 'a', sql: 'SELECT 1' })).rejects.toThrow();
    expect(executor.calls).toHaveLength(0);
  });
});

describe('PgExecutor', () => {
  function fakePool(fail: (sql: string) => Error | undefined = () => undefined) {
    const statements: Array<{ text: string; values: unknown[] | undefined }> = [];
    const released: Array<Error | boolean | undefined> = [];
    const pool: PoolLike = {
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          statements.push({ text, values });
          const error = fail(text);
          if (error) throw error;
          return { rows: text.startsWith('SELECT s.code') ? [{ code: 'north-branch' }] : [] };
        },
        release: (destroy?: Error | boolean) => {
          released.push(destroy);
        },
      }),
      end: async () => {},
    };
    return { pool, statements, released };
  }

  const SQL = 'SELECT s.code FROM sites s LIMIT $1';

  it('wraps each query in a READ ONLY transaction with a local statement timeout', async () => {
    const { pool, statements, released } = fakePool();
    const rows = await new PgExecutor(pool, { statementTimeoutMs: 1234 }).query(SQL, [10]);

    expect(rows).toEqual([{ code: 'north-branch' }]);
    expect(statements.map((s) => s.text)).toEqual([
      'BEGIN READ ONLY',
      "SELECT set_config('statement_timeout', $1, true)",
      SQL,
      'COMMIT',
    ]);
    expect(statements[1]!.values).toEqual(['1234']);
    expect(statements[2]!.values).toEqual([10]);
    expect(released).toEqual([undefined]);
  });

  it('rolls back and rethrows when the query fails, and returns the connection', async () => {
    const boom = Object.assign(new Error('relation "api_tokens" does not exist'), { code: '42P01' });
    const { pool, statements, released } = fakePool((sql) => (sql === SQL ? boom : undefined));

    await expect(new PgExecutor(pool).query(SQL, [10])).rejects.toBe(boom);
    expect(statements.map((s) => s.text)).toEqual([
      'BEGIN READ ONLY',
      "SELECT set_config('statement_timeout', $1, true)",
      SQL,
      'ROLLBACK',
    ]);
    expect(released).toEqual([undefined]);
  });

  it('destroys the connection if the rollback also fails', async () => {
    const { pool, released } = fakePool((sql) =>
      sql === SQL || sql === 'ROLLBACK' ? new Error('connection lost') : undefined,
    );
    await expect(new PgExecutor(pool).query(SQL, [10])).rejects.toThrow('connection lost');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it.each([0, -5, 1.5, 600_001, Number.NaN])('rejects statementTimeoutMs %s', (statementTimeoutMs) => {
    expect(() => new PgExecutor(fakePool().pool, { statementTimeoutMs })).toThrow(RangeError);
  });
});
