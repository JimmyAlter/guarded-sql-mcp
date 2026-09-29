/**
 * Reads and validates the server's settings from environment variables. Every
 * numeric setting has hard bounds: a typo fails at startup instead of quietly
 * disabling a limit.
 */
import {
  DEFAULT_MAX_CELL_CHARS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MAX_CELL_CHARS_BOUNDS,
  MAX_RESPONSE_BYTES_BOUNDS,
  STATEMENT_TIMEOUT_BOUNDS,
} from './policy.js';

export interface Config {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxCellChars: number;
  /** Replace string arguments in the audit log with a placeholder. */
  readonly auditRedactArgs: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): Config {
  return {
    databaseUrl: parseDatabaseUrl(env['DATABASE_URL']),
    statementTimeoutMs: parseInteger(env, 'STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS, STATEMENT_TIMEOUT_BOUNDS),
    maxResponseBytes: parseInteger(env, 'MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES_BOUNDS),
    maxCellChars: parseInteger(env, 'MAX_CELL_CHARS', DEFAULT_MAX_CELL_CHARS, MAX_CELL_CHARS_BOUNDS),
    auditRedactArgs: parseBoolean(env, 'AUDIT_REDACT_ARGS', false),
  };
}

/**
 * Accepts only a well-formed postgres:// or postgresql:// URL, so a typo fails
 * at startup rather than on the first tool call. Error messages never include
 * the value, which usually contains a password.
 */
function parseDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL (expected postgres://user:password@host:port/database).');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must use the postgres:// or postgresql:// scheme, got '${url.protocol}//'.`);
  }
  if (url.hostname === '' && !url.searchParams.has('host')) {
    throw new Error('DATABASE_URL has no host.');
  }
  return raw;
}

function parseInteger(
  env: Env,
  name: string,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!/^\s*\d+\s*$/.test(raw) || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${name} must be an integer between ${bounds.min} and ${bounds.max}, got '${raw}'`);
  }
  return value;
}

function parseBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be one of 1/0, true/false, yes/no, on/off, got '${env[name] ?? ''}'`);
}
