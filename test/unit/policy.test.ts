import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/catalog.js';
import { ALLOWED_TABLES, isSensitiveColumn } from '../../src/policy.js';

describe('policy', () => {
  it('does not allowlist api_tokens', () => {
    expect(ALLOWED_TABLES).not.toContain('api_tokens');
  });

  it.each(['password_hash', 'mfa_secret', 'token_hash', 'PASSWORD', 'api_key', 'apikey', 'salt', 'otp'])(
    'treats %s as sensitive',
    (name) => {
      expect(isSensitiveColumn(name)).toBe(true);
    },
  );

  it('is stable across repeated calls (no global-flag lastIndex state)', () => {
    expect([1, 2, 3].map(() => isSensitiveColumn('password_hash'))).toEqual([true, true, true]);
  });

  it('does not flag any column the catalog declares', () => {
    const flagged = CATALOG.flatMap((q) => q.columns.filter(isSensitiveColumn));
    expect(flagged).toEqual([]);
  });
});

describe('server identity', () => {
  it('reports the version from package.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const { SERVER_VERSION } = await import('../../src/server.js');
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
