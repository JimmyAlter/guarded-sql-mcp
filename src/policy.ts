/**
 * Access policy shared by the catalog validator, the executor and the tests.
 *
 * Everything here is enforced in code. Nothing in this file is a hint to the
 * model: tool descriptions are not an access control mechanism.
 */

/**
 * Tables that catalog queries may read. `api_tokens` exists in the schema and
 * is deliberately absent, so no catalog entry referencing it can pass startup
 * validation.
 */
export const ALLOWED_TABLES: readonly string[] = Object.freeze([
  'sites',
  'devices',
  'people',
  'software_installs',
  'tickets',
]);

/**
 * Column names that must never be returned to the model. Used by the catalog
 * validator (declared columns and every identifier in the SQL text) and by the
 * executor's output projection (every key of every returned row).
 *
 * Deliberately broad: a false positive fails closed and is fixed by renaming
 * an alias in reviewed SQL. No `g` flag, so `.test()` has no `lastIndex` state.
 */
export const SENSITIVE_COLUMN_PATTERN = /pass(word)?|hash|secret|token|api[_-]?key|salt|mfa|otp/i;

export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_COLUMN_PATTERN.test(name);
}

/**
 * Tool parameter names that suggest free-form SQL. No catalog entry may declare
 * one. This is a naming guard; the real guarantee is that parameter values only
 * ever travel as `$n` bind parameters and are never concatenated into SQL.
 */
export const FREEFORM_PARAMETER_PATTERN = /sql|query|statement|clause|expr/i;

/** Hard cap on rows returned by any single tool call. */
export const MAX_ROWS = 100;

/** Default `statement_timeout` applied inside every transaction. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
