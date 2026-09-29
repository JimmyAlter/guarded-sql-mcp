/**
 * Protocol-level tests: a real MCP SDK client talks to createServer() over an
 * in-memory transport. The database is replaced by a FakeExecutor, so these
 * tests prove what the MCP layer exposes regardless of what the database does.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditLog } from '../../src/audit.js';
import { CATALOG, type CatalogEntry } from '../../src/catalog.js';
import type { Executor, Row } from '../../src/executor.js';
import { DEFAULT_MAX_RESPONSE_BYTES, FREEFORM_PARAMETER_PATTERN, SENSITIVE_COLUMN_PATTERN } from '../../src/policy.js';
import { createServer, type ServerOptions } from '../../src/server.js';
import { CatalogValidationError } from '../../src/validateCatalog.js';
import { FakeExecutor } from '../helpers/fakeExecutor.js';

interface Harness {
  client: Client;
  auditRecords: () => Array<Record<string, unknown>>;
}

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function connect(executor: Executor, options: Omit<ServerOptions, 'audit'> = {}): Promise<Harness> {
  const lines: string[] = [];
  const server = createServer(executor, { ...options, audit: new AuditLog((line) => lines.push(line)) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'protocol-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, auditRecords: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

function textOf(result: unknown): string {
  const content = (result as CallToolResult).content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * Calls a tool and reports whether it was refused. The SDK currently answers
 * refusals with an `isError` result; a thrown protocol error counts too, so the
 * assertion is about the property (refused, executor untouched), not the shape.
 */
async function callRefused(client: Client, name: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return result.isError === true ? textOf(result) : undefined;
  } catch (err) {
    return String(err);
  }
}

describe('tool listing', () => {
  it('exposes exactly one tool per catalog entry and nothing else', async () => {
    const { client } = await connect(new FakeExecutor());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(CATALOG.map((q) => q.name).sort());
  });

  it('exposes no free-form SQL parameter, and every schema is closed and bounded', async () => {
    const { client } = await connect(new FakeExecutor());
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const schema = tool.inputSchema as {
        additionalProperties?: unknown;
        properties?: Record<string, { type?: string; enum?: unknown; maxLength?: number; maximum?: number }>;
      };
      expect(schema.additionalProperties, tool.name).toBe(false);

      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        expect(key, `${tool.name}.${key}`).not.toMatch(FREEFORM_PARAMETER_PATTERN);
        if (prop.type === 'string' && prop.enum === undefined) {
          expect(prop.maxLength, `${tool.name}.${key} maxLength`).toBeLessThanOrEqual(80);
        }
        if (prop.type === 'integer') {
          expect(prop.maximum, `${tool.name}.${key} maximum`).toBeLessThanOrEqual(365);
        }
      }
    }
  });

  it('marks every tool read-only and closed-world', async () => {
    const { client } = await connect(new FakeExecutor());
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });
});

describe('structured output', () => {
  interface ObjectSchema {
    type?: string;
    additionalProperties?: unknown;
    required?: string[];
    properties?: Record<string, { type?: string; items?: ObjectSchema }>;
  }

  it('declares an output schema per tool, derived from its declared columns', async () => {
    const { client } = await connect(new FakeExecutor());
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const entry = CATALOG.find((q) => q.name === tool.name)!;
      const schema = tool.outputSchema as ObjectSchema | undefined;
      expect(schema, tool.name).toBeDefined();
      expect(schema!.additionalProperties, tool.name).toBe(false);
      expect(schema!.required?.sort(), tool.name).toEqual(['hasMore', 'rowCount', 'rows', 'truncated']);
      const row = schema!.properties!['rows']!.items!;
      expect(row.additionalProperties, tool.name).toBe(false);
      expect(Object.keys(row.properties ?? {}), tool.name).toEqual([...entry.columns]);
    }
  });

  it('returns structuredContent identical to the JSON text, with dates as ISO strings', async () => {
    const seen = new Date('2026-09-01T10:00:00Z');
    const executor = new FakeExecutor(() => [
      { hostname: 'nb-lt-001', site: 'north-branch', os: 'Windows 11', status: 'online', ip: '10.0.0.5', last_seen_at: seen },
      { hostname: 'nb-lt-002', site: 'north-branch', os: 'Ubuntu', status: 'offline', ip: null, last_seen_at: null },
    ]);
    const { client } = await connect(executor);
    await client.listTools(); // lets the client cache and enforce the output schemas
    const result = await client.callTool({ name: 'search_devices', arguments: { limit: 1 } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(JSON.parse(textOf(result)));
    expect(result.structuredContent).toEqual({
      rowCount: 1,
      hasMore: true,
      truncated: false,
      rows: [
        {
          hostname: 'nb-lt-001',
          site: 'north-branch',
          os: 'Windows 11',
          status: 'online',
          ip: '10.0.0.5',
          last_seen_at: '2026-09-01T10:00:00.000Z',
        },
      ],
    });
  });

  it('returns no structuredContent on errors', async () => {
    const { client } = await connect(
      new FakeExecutor(() => {
        throw new Error('boom');
      }),
    );
    const result = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('argument handling', () => {
  it.each([
    ['get_device', { hostname: "x'; DROP TABLE devices;--" }],
    ['get_device', {}],
    ['get_device', { hostname: 'nb-lt-001', sql: 'SELECT * FROM api_tokens' }],
    ['search_devices', { limit: 1000 }],
    ['search_devices', { limit: 0 }],
    ['search_devices', { status: 'deleted' }],
    ['find_people', { name_or_email: 'x'.repeat(81) }],
    ['stale_devices', { days: 3650 }],
    ['list_sites', { query: 'SELECT 1' }],
  ])('refuses %s with %j and never reaches the executor', async (name, args) => {
    const executor = new FakeExecutor();
    const { client } = await connect(executor);
    expect(await callRefused(client, name, args)).toBeDefined();
    expect(executor.calls).toHaveLength(0);
  });

  it.each(['run_sql', 'query', 'execute', 'api_tokens'])('refuses unknown tool %s', async (name) => {
    const executor = new FakeExecutor();
    const { client } = await connect(executor);
    const message = await callRefused(client, name, { sql: 'SELECT token_hash FROM api_tokens' });
    expect(message).toMatch(/not found/i);
    expect(executor.calls).toHaveLength(0);
  });

  it('passes valid arguments to the executor as bind parameters only', async () => {
    const executor = new FakeExecutor();
    const { client } = await connect(executor);
    await client.callTool({ name: 'find_people', arguments: { name_or_email: "o'brien%" } });
    const findPeople = CATALOG.find((q) => q.name === 'find_people')!;
    expect(executor.calls).toEqual([{ sql: findPeople.sql, params: ["%o'brien\\%%", 26] }]);
  });
});

describe('results', () => {
  const leakyRows: Row[] = [
    {
      full_name: 'Sam Rivera',
      email: 'sam.rivera@example.com',
      department: 'IT',
      site: 'north-branch',
      password_hash: '$argon2id$v=19$m=65536,t=3,p=4$LEAKED-HASH',
      mfa_secret: 'LEAKED-MFA-SECRET',
      token_hash: 'LEAKED-TOKEN',
    },
  ];

  it('never returns sensitive columns, even when the executor hands them over', async () => {
    const { client, auditRecords } = await connect(new FakeExecutor(() => leakyRows));
    const result = await client.callTool({ name: 'find_people', arguments: { name_or_email: 'rivera' } });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toMatch(SENSITIVE_COLUMN_PATTERN);
    expect(text).not.toContain('LEAKED');
    expect(JSON.parse(text)).toEqual({
      rowCount: 1,
      hasMore: false,
      truncated: false,
      rows: [{ full_name: 'Sam Rivera', email: 'sam.rivera@example.com', department: 'IT', site: 'north-branch' }],
    });

    const [record] = auditRecords();
    expect(record).toMatchObject({
      event: 'tool_call',
      tool: 'find_people',
      outcome: 'ok',
      dropped: { sensitive: ['mfa_secret', 'password_hash', 'token_hash'] },
    });
    expect(JSON.stringify(record)).not.toContain('LEAKED');
  });

  it('returns JSON text and writes one audit record per call', async () => {
    const executor = new FakeExecutor(() => [{ code: 'north-branch', name: 'North Branch', city: 'Northfield', active_devices: 4 }]);
    const { client, auditRecords } = await connect(executor);
    const result = await client.callTool({ name: 'list_sites', arguments: {} });

    expect(JSON.parse(textOf(result))).toMatchObject({ rowCount: 1, rows: [{ code: 'north-branch' }] });
    const records = auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      ts: expect.any(String),
      event: 'tool_call',
      tool: 'list_sites',
      args: {},
      rowCount: 1,
      durationMs: expect.any(Number),
      outcome: 'ok',
      hasMore: false,
      truncated: false,
      responseBytes: Buffer.byteLength(textOf(result)),
    });
  });

  it('caps rows at 100 regardless of what the executor returns', async () => {
    const executor = new FakeExecutor(() => Array.from({ length: 250 }, (_, i) => ({ hostname: `h-${i}` })));
    const { client } = await connect(executor);
    const result = await client.callTool({ name: 'search_devices', arguments: { limit: 100 } });
    const body = JSON.parse(textOf(result)) as { rowCount: number; rows: unknown[]; hasMore: boolean };
    expect(body.rowCount).toBe(100);
    expect(body.rows).toHaveLength(100);
    expect(body.hasMore).toBe(true);
  });

  it('keeps a response with huge rows under the byte cap, cuts long cells and audits the truncation', async () => {
    // 100 rows of ~1 MB each: without the cap this would be a ~100 MB tool result.
    const huge = 'x'.repeat(1_000_000);
    const executor = new FakeExecutor(() =>
      Array.from({ length: 101 }, (_, i) => ({ full_name: `Person ${i}`, email: huge, department: huge, site: 'hq' })),
    );
    const { client, auditRecords } = await connect(executor);
    const result = await client.callTool({ name: 'find_people', arguments: { name_or_email: 'person', limit: 100 } });
    const text = textOf(result);
    const body = JSON.parse(text) as { rowCount: number; hasMore: boolean; truncated: boolean; rows: Array<Record<string, string>> };

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_BYTES);
    expect(body.truncated).toBe(true);
    expect(body.hasMore).toBe(true);
    expect(body.rowCount).toBe(body.rows.length);
    expect(body.rowCount).toBeGreaterThan(0);
    expect(body.rowCount).toBeLessThan(100);
    expect(body.rows[0]!['email']).toBe(`${'x'.repeat(1000)}…[truncated 999000 chars]`);
    expect(body.rows[0]!['full_name']).toBe('Person 0');

    const [record] = auditRecords();
    expect(record).toMatchObject({
      tool: 'find_people',
      outcome: 'ok',
      rowCount: body.rowCount,
      hasMore: true,
      truncated: true,
      responseBytes: Buffer.byteLength(text),
      truncation: { cellsTruncated: body.rowCount * 2 + (100 - body.rowCount) * 2, rowsDropped: 100 - body.rowCount },
    });
  });

  it('applies custom response limits', async () => {
    const executor = new FakeExecutor(() =>
      Array.from({ length: 50 }, (_, i) => ({ hostname: `host-${i}`, os: 'o'.repeat(300) })),
    );
    const { client } = await connect(executor, { limits: { maxResponseBytes: 4096, maxCellChars: 100 } });
    const text = textOf(await client.callTool({ name: 'search_devices', arguments: { limit: 50 } }));
    const body = JSON.parse(text) as { rowCount: number; rows: Array<Record<string, string>> };
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(body.rows[0]!['os']).toBe(`${'o'.repeat(100)}…[truncated 200 chars]`);
    expect(body.rowCount).toBeLessThan(50);
  });

  it('turns database errors into a generic message; details go to the audit log only', async () => {
    const dbError = Object.assign(new Error('permission denied for table api_tokens'), { code: '42501' });
    const { client, auditRecords } = await connect(
      new FakeExecutor(() => {
        throw dbError;
      }),
    );
    const result = await client.callTool({ name: 'open_tickets', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The open_tickets query failed. Details were recorded in the server log.');
    expect(textOf(result)).not.toMatch(/api_tokens|permission|42501/);
    expect(auditRecords()[0]).toMatchObject({
      tool: 'open_tickets',
      outcome: 'error',
      rowCount: 0,
      error: { code: '42501', message: 'permission denied for table api_tokens' },
    });
  });
});

describe('startup', () => {
  it.each([
    [{ maxRows: 101 }, /maxRows must be an integer between 1 and 100/],
    [{ maxRows: 10_000 }, /maxRows/],
    [{ maxRows: 0 }, /maxRows/],
    [{ maxRows: 2.5 }, /maxRows/],
    [{ limits: { maxResponseBytes: 10 * 1024 * 1024, maxCellChars: 1000 } }, /limits.maxResponseBytes/],
    [{ limits: { maxResponseBytes: 65_536, maxCellChars: 10 } }, /limits.maxCellChars/],
  ])('rejects options that would loosen the policy: %j', (options, message) => {
    expect(() => createServer(new FakeExecutor(), options)).toThrow(message);
  });

  it('accepts a lower row cap and applies it', async () => {
    const executor = new FakeExecutor(() => Array.from({ length: 50 }, (_, i) => ({ hostname: `h-${i}` })));
    const { client } = await connect(executor, { maxRows: 5 });
    const text = textOf(await client.callTool({ name: 'search_devices', arguments: { limit: 100 } }));
    expect(JSON.parse(text)).toMatchObject({ rowCount: 5, hasMore: true });
  });

  it('refuses to build a server from a catalog that fails validation', () => {
    const leaky: CatalogEntry = {
      ...CATALOG[0]!,
      name: 'dump_tokens',
      input: z.strictObject({}),
      sql: 'SELECT t.token_hash FROM api_tokens t LIMIT 10',
      params: () => [],
      tables: ['api_tokens'],
      columns: ['token_hash'],
      example: {},
    };
    expect(() => createServer(new FakeExecutor(), { catalog: [...CATALOG, leaky] })).toThrow(CatalogValidationError);
  });
});
