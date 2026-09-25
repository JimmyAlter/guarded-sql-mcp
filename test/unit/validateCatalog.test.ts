import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATALOG, type CatalogEntry } from '../../src/catalog.js';
import { CatalogValidationError, validateCatalog, type RuleId } from '../../src/validateCatalog.js';

/** A minimal entry that passes validation. Each bad case changes one thing. */
const good: CatalogEntry = {
  name: 'test_query',
  title: 'Test query',
  description: 'A valid entry used as the base for bad variants.',
  input: z.strictObject({ limit: z.number().int().min(1).max(100).default(10) }),
  sql: 'SELECT s.code, s.name FROM sites s ORDER BY s.code LIMIT $1',
  params: (i) => [i.limit],
  tables: ['sites'],
  columns: ['code', 'name'],
  example: {},
};

const noInput = { input: z.strictObject({}), params: () => [], example: {} };

function variant(overrides: Partial<CatalogEntry>): CatalogEntry {
  return { ...good, ...overrides };
}

function rulesOf(catalog: readonly CatalogEntry[]): RuleId[] {
  try {
    validateCatalog(catalog);
    return [];
  } catch (err) {
    if (err instanceof CatalogValidationError) return err.problems.map((p) => p.rule);
    throw err;
  }
}

describe('validateCatalog', () => {
  it('accepts the real catalog', () => {
    expect(() => validateCatalog(CATALOG)).not.toThrow();
  });

  it('accepts the base entry used by the bad variants below', () => {
    expect(rulesOf([good])).toEqual([]);
  });

  it('accepts a CTE over allowlisted tables', () => {
    const entry = variant({
      sql: `WITH recent AS (SELECT d.site_id FROM devices d WHERE d.status = 'online')
            SELECT s.code, s.name FROM sites s JOIN recent r ON r.site_id = s.id LIMIT $1`,
      tables: ['devices', 'sites'],
    });
    expect(rulesOf([entry])).toEqual([]);
  });

  describe('tables', () => {
    const cases: Array<[string, Partial<CatalogEntry>, RuleId]> = [
      [
        'a declared table outside the allowlist',
        { ...noInput, sql: 'SELECT t.person_id FROM api_tokens t LIMIT 10', tables: ['api_tokens'], columns: ['person_id'] },
        'table-not-allowed',
      ],
      [
        'a JOIN to a table that is not declared',
        { sql: 'SELECT s.code, s.name FROM sites s JOIN devices d ON d.site_id = s.id LIMIT $1' },
        'table-undeclared',
      ],
      [
        'a JOIN with no alias in front of it (FROM a JOIN b)',
        { sql: 'SELECT code, name FROM sites JOIN api_tokens ON true LIMIT $1' },
        'table-undeclared',
      ],
      [
        'a declared table the SQL never reads',
        { tables: ['sites', 'devices'] },
        'table-unreferenced',
      ],
      [
        'a comma-separated FROM list',
        { sql: 'SELECT s.code, s.name FROM sites s, api_tokens t LIMIT $1' },
        'unsupported-table-ref',
      ],
      [
        'a schema-qualified table',
        { sql: 'SELECT s.code, s.name FROM public.sites s LIMIT $1' },
        'unsupported-table-ref',
      ],
      [
        'the TABLE shorthand, which has no FROM',
        { sql: 'SELECT s.code, s.name FROM sites s WHERE s.id IN (TABLE api_tokens) LIMIT $1' },
        'unsupported-table-ref',
      ],
      [
        'IS DISTINCT FROM (the guard fails closed instead of guessing)',
        { sql: 'SELECT s.code, s.name FROM sites s WHERE s.code IS DISTINCT FROM s.name LIMIT $1' },
        'unsupported-table-ref',
      ],
    ];

    it.each(cases)('rejects %s', (_label, overrides, rule) => {
      expect(rulesOf([variant(overrides)])).toContain(rule);
    });
  });

  describe('sensitive columns', () => {
    it('rejects a declared output column that matches the sensitive pattern', () => {
      const entry = variant({
        sql: 'SELECT p.full_name, p.password_hash FROM people p LIMIT $1',
        tables: ['people'],
        columns: ['full_name', 'password_hash'],
      });
      expect(rulesOf([entry])).toContain('sensitive-column');
    });

    it('rejects a sensitive column hidden behind an innocent alias', () => {
      const entry = variant({
        sql: 'SELECT p.full_name, p.mfa_secret AS note FROM people p LIMIT $1',
        tables: ['people'],
        columns: ['full_name', 'note'],
      });
      expect(rulesOf([entry])).toEqual(['sensitive-identifier']);
    });

    it.each(['password', 'token_hash', 'API_KEY', 'salt', 'otp_seed'])(
      'rejects a column named %s',
      (column) => {
        expect(rulesOf([variant({ columns: ['code', column] })])).toContain('sensitive-column');
      },
    );

    it('rejects an entry with no declared columns', () => {
      expect(rulesOf([variant({ columns: [] })])).toContain('no-columns');
    });
  });

  describe('statement shape', () => {
    const cases: Array<[string, string, RuleId]> = [
      ['a non-SELECT statement', 'DELETE FROM sites WHERE id = $1', 'not-select'],
      ['a second statement after ;', 'SELECT s.code, s.name FROM sites s LIMIT $1; DROP TABLE sites', 'multi-statement'],
      ['a trailing semicolon', 'SELECT s.code, s.name FROM sites s LIMIT $1;', 'multi-statement'],
      [
        'a data-modifying CTE',
        'WITH gone AS (DELETE FROM sites RETURNING id) SELECT g.id AS code, g.id AS name FROM gone g LIMIT $1',
        'write-keyword',
      ],
      ['SELECT INTO', 'SELECT s.code, s.name INTO copy_of_sites FROM sites s LIMIT $1', 'write-keyword'],
      ['a row lock', 'SELECT s.code, s.name FROM sites s FOR SHARE LIMIT $1', 'write-keyword'],
      ['pg_sleep()', 'SELECT s.code, pg_sleep(30)::text AS name FROM sites s LIMIT $1', 'forbidden-function'],
      [
        'query_to_xml(), which runs SQL passed as a string',
        "SELECT s.code, query_to_xml('SELECT 1', true, false, '')::text AS name FROM sites s LIMIT $1",
        'forbidden-function',
      ],
      ['SELECT *', 'SELECT * FROM sites s LIMIT $1', 'wildcard-select'],
      ['alias.*', 'SELECT s.* FROM sites s LIMIT $1', 'wildcard-select'],
      ['a line comment', 'SELECT s.code, s.name FROM sites s -- note\n LIMIT $1', 'unsupported-syntax'],
      ['a block comment', 'SELECT s.code, s.name /* x */ FROM sites s LIMIT $1', 'unsupported-syntax'],
      ['dollar quoting', 'SELECT s.code, $$x$$ AS name FROM sites s LIMIT $1', 'unsupported-syntax'],
      ['a quoted identifier', 'SELECT s.code, s."name" FROM sites s LIMIT $1', 'unsupported-syntax'],
      ['a missing LIMIT', 'SELECT s.code, s.name FROM sites s WHERE s.id < $1', 'missing-limit'],
      ['a LIMIT literal above the row cap', 'SELECT s.code, s.name FROM sites s WHERE s.id < $1 LIMIT 5000', 'missing-limit'],
    ];

    it.each(cases)('rejects %s', (_label, sql, rule) => {
      expect(rulesOf([variant({ sql })])).toContain(rule);
    });

    it('does not mistake count(*) for a wildcard select', () => {
      const entry = variant({
        sql: 'SELECT s.code, count(*)::text AS name FROM sites s GROUP BY s.code LIMIT $1',
      });
      expect(rulesOf([entry])).toEqual([]);
    });
  });

  describe('placeholders and params', () => {
    it('rejects a gap in placeholder numbering', () => {
      const entry = variant({
        input: z.strictObject({ id: z.number().int().min(1).max(10), limit: good.input.shape['limit']! }),
        sql: 'SELECT s.code, s.name FROM sites s WHERE s.id = $3 LIMIT $1',
        params: (i) => [i.limit, null, i.id],
        example: { id: 1 },
      });
      expect(rulesOf([entry])).toEqual(['placeholder-gap']);
    });

    it('rejects params() returning fewer values than placeholders', () => {
      const entry = variant({ sql: 'SELECT s.code, s.name FROM sites s WHERE s.id = $2 LIMIT $1' });
      expect(rulesOf([entry])).toEqual(['param-count']);
    });

    it('rejects params() returning more values than placeholders', () => {
      const entry = variant({ params: (i) => [i.limit, 'extra'] });
      expect(rulesOf([entry])).toEqual(['param-count']);
    });

    it('rejects an optional input mapped to undefined instead of null', () => {
      const entry = variant({
        input: z.strictObject({ city: z.string().max(40).optional(), limit: good.input.shape['limit']! }),
        sql: 'SELECT s.code, s.name FROM sites s WHERE ($1::text IS NULL OR s.city = $1) LIMIT $2',
        params: (i) => [i.city, i.limit],
      });
      expect(rulesOf([entry])).toEqual(['param-undefined']);
    });

    it('rejects an example that does not satisfy the input schema', () => {
      expect(rulesOf([variant({ example: { limit: 1000 } })])).toEqual(['invalid-example']);
    });
  });

  describe('input schemas', () => {
    it('rejects a non-strict object (unknown keys would be silently stripped)', () => {
      const entry = variant({ input: z.object({ limit: z.number().int().min(1).max(100).default(10) }) });
      expect(rulesOf([entry])).toEqual(['non-strict-input']);
    });

    it.each(['sql', 'query', 'statement', 'raw_sql', 'where_clause'])(
      'rejects a parameter named %s',
      (key) => {
        const entry = variant({
          input: z.strictObject({ [key]: z.string().max(10).optional(), limit: good.input.shape['limit']! }),
        });
        expect(rulesOf([entry])).toContain('forbidden-param-name');
      },
    );

    const unbounded: Array<[string, z.ZodType]> = [
      ['a string without max length', z.string().optional()],
      ['an integer without explicit bounds', z.number().int().optional()],
      ['a number with only a minimum', z.number().min(0).optional()],
      ['a nested object', z.strictObject({ x: z.string().max(3) }).optional()],
      ['an array', z.array(z.string().max(3)).max(3).optional()],
    ];

    it.each(unbounded)('rejects %s', (_label, field) => {
      const entry = variant({
        input: z.strictObject({ extra: field, limit: good.input.shape['limit']! }),
      });
      expect(rulesOf([entry])).toContain('unbounded-input');
    });
  });

  describe('names', () => {
    it('rejects duplicate tool names', () => {
      expect(rulesOf([good, variant({})])).toEqual(['duplicate-name']);
    });

    it('rejects a tool name outside the naming pattern', () => {
      expect(rulesOf([variant({ name: 'Run-SQL' })])).toEqual(['invalid-name']);
    });
  });

  it('reports every problem at once, with the entry name, in the error message', () => {
    const entry = variant({ name: 'leaky', sql: 'SELECT * FROM api_tokens', tables: ['api_tokens'] });
    let error: unknown;
    try {
      validateCatalog([entry]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CatalogValidationError);
    const { problems, message } = error as CatalogValidationError;
    expect(problems.map((p) => p.rule)).toEqual(
      expect.arrayContaining(['wildcard-select', 'missing-limit', 'table-not-allowed', 'sensitive-identifier']),
    );
    expect(problems.every((p) => p.query === 'leaky')).toBe(true);
    expect(message).toContain('[leaky] table-not-allowed');
  });
});
