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
}

export type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): Config {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }
  return {
    databaseUrl,
    statementTimeoutMs: parseInteger(env, 'STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS, STATEMENT_TIMEOUT_BOUNDS),
    maxResponseBytes: parseInteger(env, 'MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES_BOUNDS),
    maxCellChars: parseInteger(env, 'MAX_CELL_CHARS', DEFAULT_MAX_CELL_CHARS, MAX_CELL_CHARS_BOUNDS),
  };
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
