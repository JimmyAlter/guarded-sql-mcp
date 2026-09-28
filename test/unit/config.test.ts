import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const DATABASE_URL = 'postgres://mcp_readonly:x@localhost/inventory';

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      statementTimeoutMs: 5_000,
      maxResponseBytes: 65_536,
      maxCellChars: 1_000,
    });
  });

  it('reads values inside the bounds', () => {
    expect(
      loadConfig({ DATABASE_URL, STATEMENT_TIMEOUT_MS: '250', MAX_RESPONSE_BYTES: '4096', MAX_CELL_CHARS: '100000' }),
    ).toMatchObject({ statementTimeoutMs: 250, maxResponseBytes: 4_096, maxCellChars: 100_000 });
  });

  it.each([
    ['STATEMENT_TIMEOUT_MS', '0'],
    ['STATEMENT_TIMEOUT_MS', '600001'],
    ['MAX_RESPONSE_BYTES', '1024'],
    ['MAX_RESPONSE_BYTES', '10485760'],
    ['MAX_RESPONSE_BYTES', '64k'],
    ['MAX_RESPONSE_BYTES', '1e5'],
    ['MAX_CELL_CHARS', '-1'],
    ['MAX_CELL_CHARS', '99'],
    ['MAX_CELL_CHARS', '1.5'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ DATABASE_URL, [name]: value })).toThrow(name);
  });
});
