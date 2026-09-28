/**
 * Startup validation of the query catalog.
 *
 * Scope, stated plainly: this is a guard over a small, static, code-reviewed
 * catalog. It is NOT a SQL parser and must never be used to vet SQL that comes
 * from a user or a model. It uses regular expressions to catch the mistakes a
 * reviewer might miss when a query is added or edited (a table outside the
 * allowlist, a password column in the select list, a stray `;`, a placeholder
 * gap). Where the regexes cannot be sure, they fail closed: the entry is
 * rejected and the author rewrites the SQL in a simpler form.
 *
 * The layers that do not depend on this file: parameters are always bound
 * (never concatenated), every call runs in a READ ONLY transaction with a
 * statement timeout, rows are projected to declared columns on the way out,
 * and the database role only has column-level SELECT on what it needs.
 */
import { z } from 'zod';
import type { CatalogEntry } from './catalog.js';
import {
  ALLOWED_TABLES,
  FREEFORM_PARAMETER_PATTERN,
  MAX_ROWS,
  SENSITIVE_COLUMN_PATTERN,
} from './policy.js';

export type RuleId =
  | 'invalid-name'
  | 'duplicate-name'
  | 'unsupported-syntax'
  | 'multi-statement'
  | 'not-select'
  | 'write-keyword'
  | 'forbidden-function'
  | 'wildcard-select'
  | 'missing-limit'
  | 'table-not-allowed'
  | 'table-undeclared'
  | 'table-unreferenced'
  | 'unsupported-table-ref'
  | 'no-columns'
  | 'sensitive-column'
  | 'sensitive-identifier'
  | 'non-strict-input'
  | 'forbidden-param-name'
  | 'unbounded-input'
  | 'invalid-example'
  | 'placeholder-gap'
  | 'param-count'
  | 'param-undefined';

export interface CatalogProblem {
  readonly query: string;
  readonly rule: RuleId;
  readonly message: string;
}

export class CatalogValidationError extends Error {
  readonly problems: readonly CatalogProblem[];

  constructor(problems: readonly CatalogProblem[]) {
    super(
      `Query catalog failed validation (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - [${p.query}] ${p.rule}: ${p.message}`).join('\n'),
    );
    this.name = 'CatalogValidationError';
    this.problems = problems;
  }
}

export interface CatalogPolicy {
  readonly allowedTables: readonly string[];
  readonly sensitivePattern: RegExp;
  readonly maxRows: number;
}

export const DEFAULT_POLICY: CatalogPolicy = {
  allowedTables: ALLOWED_TABLES,
  sensitivePattern: SENSITIVE_COLUMN_PATTERN,
  maxRows: MAX_ROWS,
};

const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Keywords that write, lock rows, or change session state. The READ ONLY
 * transaction would reject most of these at runtime anyway; catching them here
 * turns a runtime failure into a startup failure. `INTO` covers SELECT INTO.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|INTO|SET|RESET|LOCK|VACUUM|ANALYZE|EXECUTE|PREPARE|LISTEN|NOTIFY)\b|\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE)\b/i;

/**
 * Functions with side effects or that execute SQL passed as a string (which
 * would hide table references from the checks below). Not exhaustive: the
 * database role is what ultimately bounds privileges.
 */
const FORBIDDEN_FUNCTIONS =
  /\b(nextval|setval|set_config|pg_sleep\w*|pg_advisory\w*|pg_read\w*|pg_ls_\w+|pg_terminate_backend|pg_cancel_backend|lo_\w+|dblink\w*|query_to_xml\w*|table_to_xml\w*|cursor_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|ts_stat)\s*\(/i;

/** `SELECT *`, `, *` or `alias.*`. `count(*)` and multiplication are fine. */
const WILDCARD = /(\bSELECT\s+(ALL\s+|DISTINCT\s+)?|,\s*)\*|\.\s*\*/i;

/** The statement must end with a top-level `LIMIT $n` or `LIMIT <literal>`. */
const TRAILING_LIMIT = /\bLIMIT\s+(\$\d+|\d+)\s*$/i;

/**
 * Table references: the token after FROM or JOIN. Only the token is consumed,
 * so `FROM a JOIN b` yields both `a` and `b`. A subquery (`FROM (SELECT ...)`)
 * does not match here; the FROM inside it does.
 */
const TABLE_REF = /\b(?:FROM|JOIN)\s+([^\s,()]+)/gi;

/** What may follow a table reference if the FROM list continues with a comma. */
const COMMA_AFTER_REF = /^(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s*,/i;

/** CTE names: `WITH name AS (` and `, name AS (`. */
const CTE_NAME = /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi;

/** Words that may follow FROM/JOIN but are not table names; rejected rather than interpreted. */
const NOT_A_TABLE = /^(lateral|only|unnest|rows|select)$/i;

const PLACEHOLDER = /\$(\d+)/g;
const IDENTIFIER_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Replaces each '...' literal (with '' escapes) by a neutral token so the
 * structural checks never look inside string contents. A quote left over
 * afterwards means an unbalanced literal.
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, ' _literal_ ');
}

export function validateCatalog(
  catalog: readonly CatalogEntry[],
  policy: CatalogPolicy = DEFAULT_POLICY,
): void {
  const problems: CatalogProblem[] = [];
  const seen = new Set<string>();

  for (const entry of catalog) {
    const report = (rule: RuleId, message: string) => problems.push({ query: entry.name, rule, message });

    if (!TOOL_NAME.test(entry.name)) {
      report('invalid-name', 'tool names must match /^[a-z][a-z0-9_]{2,63}$/');
    }
    if (seen.has(entry.name)) {
      report('duplicate-name', 'another catalog entry already uses this name');
    }
    seen.add(entry.name);

    checkSql(entry, policy, report);
    checkColumns(entry, policy, report);
    checkInput(entry, report);
    checkParams(entry, report);
  }

  if (problems.length > 0) {
    throw new CatalogValidationError(problems);
  }
}

type Report = (rule: RuleId, message: string) => void;

function checkSql(entry: CatalogEntry, policy: CatalogPolicy, report: Report): void {
  const raw = entry.sql.trim();
  const sql = stripStringLiterals(raw);

  if (raw.includes(';')) {
    report('multi-statement', "';' is not allowed: one statement per entry, no trailing semicolon");
  }
  if (/--|\/\*/.test(sql)) {
    report('unsupported-syntax', 'SQL comments are not allowed in catalog SQL');
  }
  if (sql.includes("'")) {
    report('unsupported-syntax', 'unbalanced string literal');
  }
  if (sql.includes('"')) {
    report('unsupported-syntax', 'quoted identifiers are not supported by the guard');
  }
  if (/\$(?!\d)/.test(sql)) {
    report('unsupported-syntax', "'$' is only allowed in $n placeholders (no dollar quoting)");
  }
  if (!/^(SELECT|WITH)\b/i.test(sql)) {
    report('not-select', 'SQL must start with SELECT or WITH');
  }

  const write = WRITE_KEYWORDS.exec(sql);
  if (write) {
    report('write-keyword', `'${write[0]}' is not allowed in a read-only catalog`);
  }
  const fn = FORBIDDEN_FUNCTIONS.exec(sql);
  if (fn) {
    report('forbidden-function', `'${fn[1]}()' is not allowed in catalog SQL`);
  }
  if (WILDCARD.test(sql)) {
    report('wildcard-select', 'list output columns explicitly instead of using *');
  }

  const limit = TRAILING_LIMIT.exec(sql);
  if (!limit) {
    report('missing-limit', 'SQL must end with LIMIT $n or LIMIT <number>');
  } else if (limit[1] && !limit[1].startsWith('$') && Number(limit[1]) > policy.maxRows) {
    report('missing-limit', `LIMIT ${limit[1]} exceeds the row cap of ${policy.maxRows}`);
  }

  checkTables(entry, sql, policy, report);
}

function checkTables(entry: CatalogEntry, sql: string, policy: CatalogPolicy, report: Report): void {
  const allowed = new Set(policy.allowedTables);
  const declared = new Set(entry.tables);

  for (const table of declared) {
    if (!allowed.has(table)) {
      report('table-not-allowed', `declared table '${table}' is not in ALLOWED_TABLES`);
    }
  }

  if (/\bTABLE\b/i.test(sql)) {
    // `TABLE name` is shorthand for SELECT * FROM name and has no FROM keyword.
    report('unsupported-table-ref', "the TABLE command is not supported; use SELECT ... FROM");
  }

  const cteNames = new Set<string>();
  for (const match of sql.matchAll(CTE_NAME)) {
    const name = (match[1] ?? '').toLowerCase();
    if (allowed.has(name)) {
      report('unsupported-table-ref', `CTE name '${name}' shadows a table name`);
    }
    cteNames.add(name);
  }

  const referenced = new Set<string>();
  for (const match of sql.matchAll(TABLE_REF)) {
    const ref = match[1] ?? '';
    const rest = sql.slice(match.index + match[0].length);

    if (!SIMPLE_IDENTIFIER.test(ref.toLowerCase()) || NOT_A_TABLE.test(ref)) {
      // Schema-qualified names, function calls in FROM, EXTRACT(... FROM ...),
      // IS DISTINCT FROM, LATERAL: all rejected rather than half-understood.
      report('unsupported-table-ref', `cannot verify reference after FROM/JOIN: '${ref}'`);
      continue;
    }
    if (COMMA_AFTER_REF.test(rest)) {
      // The regex would only see the first table of `FROM a, b`.
      report('unsupported-table-ref', `comma-separated FROM list after '${ref}'; use explicit JOINs`);
    }

    const table = ref.toLowerCase();
    if (cteNames.has(table)) continue;
    referenced.add(table);
    if (!allowed.has(table)) {
      report('table-not-allowed', `SQL references '${table}', which is not in ALLOWED_TABLES`);
    }
    if (!declared.has(table)) {
      report('table-undeclared', `SQL references '${table}' but the entry does not declare it`);
    }
  }

  for (const table of declared) {
    if (!referenced.has(table)) {
      report('table-unreferenced', `declared table '${table}' does not appear after FROM/JOIN`);
    }
  }
}

function checkColumns(entry: CatalogEntry, policy: CatalogPolicy, report: Report): void {
  if (entry.columns.length === 0) {
    report('no-columns', 'an entry must declare its output columns');
  }
  for (const column of entry.columns) {
    if (policy.sensitivePattern.test(column)) {
      report('sensitive-column', `declared output column '${column}' matches the sensitive pattern`);
    }
  }
  // Scans the raw SQL, literals included, so `password_hash AS note` or a
  // sensitive name smuggled into a string cannot slip past the column check.
  const flagged = new Set<string>();
  for (const [word] of entry.sql.matchAll(IDENTIFIER_WORD)) {
    if (policy.sensitivePattern.test(word) && !flagged.has(word.toLowerCase())) {
      flagged.add(word.toLowerCase());
      report('sensitive-identifier', `SQL mentions '${word}', which matches the sensitive pattern`);
    }
  }
}

interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

function checkInput(entry: CatalogEntry, report: Report): void {
  let schema: { additionalProperties?: unknown; properties?: Record<string, JsonSchemaProperty> };
  try {
    schema = z.toJSONSchema(entry.input, { io: 'input' }) as typeof schema;
  } catch (err) {
    report('unbounded-input', `input schema cannot be converted to JSON Schema: ${String(err)}`);
    return;
  }

  if (schema.additionalProperties !== false) {
    report('non-strict-input', 'input must be a strict object (unknown keys rejected); use z.strictObject');
  }

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (FREEFORM_PARAMETER_PATTERN.test(key)) {
      report('forbidden-param-name', `parameter '${key}' looks like a free-form SQL parameter`);
    }
    const problem = boundProblem(prop);
    if (problem) {
      report('unbounded-input', `parameter '${key}': ${problem}`);
    }
  }
}

/** Returns why a JSON Schema property is not tightly bounded, or undefined if it is. */
function boundProblem(prop: JsonSchemaProperty): string | undefined {
  if (Array.isArray(prop.enum)) return undefined;
  switch (prop.type) {
    case 'boolean':
      return undefined;
    case 'string':
      return prop.maxLength === undefined ? 'string without a maximum length' : undefined;
    case 'integer':
    case 'number': {
      // zod's .int() emits the safe-integer range when no explicit bound is set.
      const lowOk = prop.minimum !== undefined && prop.minimum > Number.MIN_SAFE_INTEGER;
      const highOk = prop.maximum !== undefined && prop.maximum < Number.MAX_SAFE_INTEGER;
      return lowOk && highOk ? undefined : 'number without explicit minimum and maximum';
    }
    default:
      return `unsupported type '${prop.type ?? 'unknown'}'; inputs must be flat strings, numbers, booleans or enums`;
  }
}

function checkParams(entry: CatalogEntry, report: Report): void {
  const parsed = entry.input.safeParse(entry.example);
  if (!parsed.success) {
    report('invalid-example', `example does not satisfy the input schema: ${parsed.error.message}`);
    return;
  }

  let params: readonly unknown[];
  try {
    params = entry.params(parsed.data);
  } catch (err) {
    report('invalid-example', `params() threw for the example input: ${String(err)}`);
    return;
  }

  const used = new Set<number>();
  for (const [, n] of stripStringLiterals(entry.sql).matchAll(PLACEHOLDER)) {
    used.add(Number(n));
  }
  const highest = used.size === 0 ? 0 : Math.max(...used);
  for (let i = 1; i <= highest; i++) {
    if (!used.has(i)) {
      report('placeholder-gap', `placeholders jump over $${i}`);
    }
  }
  if (used.has(0)) {
    report('placeholder-gap', '$0 is not a valid placeholder');
  }
  if (params.length !== highest) {
    report('param-count', `SQL uses $1..$${highest} but params() returned ${params.length} value(s)`);
  }
  params.forEach((value, index) => {
    if (value === undefined) {
      report('param-undefined', `param $${index + 1} is undefined; map absent optional input to null`);
    }
  });
}
