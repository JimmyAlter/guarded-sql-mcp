/**
 * Query execution: the Executor interface, its PostgreSQL implementation, and
 * the output projection applied to every result before it leaves the server.
 */
import pg from 'pg';
import { rowLimit, type CatalogEntry } from './catalog.js';
import { DEFAULT_STATEMENT_TIMEOUT_MS, MAX_ROWS, SENSITIVE_COLUMN_PATTERN } from './policy.js';

export type Row = Record<string, unknown>;

/** The only capability the MCP server needs from a database. */
export interface Executor {
  query(sql: string, params: readonly unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/** The subset of pg.Pool used here. Lets unit tests substitute a recording fake. */
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(destroy?: Error | boolean): void;
}

export interface PgExecutorOptions {
  /** Applied with SET LOCAL semantics inside every transaction. */
  readonly statementTimeoutMs?: number;
}

export class PgExecutor implements Executor {
  private readonly statementTimeoutMs: number;

  constructor(
    private readonly pool: PoolLike,
    options: PgExecutorOptions = {},
  ) {
    const timeout = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) {
      throw new RangeError(`statementTimeoutMs must be an integer between 1 and 600000, got ${timeout}`);
    }
    this.statementTimeoutMs = timeout;
  }

  static connect(
    connectionString: string,
    options: PgExecutorOptions & { onPoolError?: (err: Error) => void } = {},
  ): PgExecutor {
    const pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'guarded-sql-mcp',
    });
    // An idle client can error (for example when the server restarts). Without
    // a listener, pg re-emits it as an uncaught exception.
    pool.on('error', (err) => options.onPoolError?.(err));
    return new PgExecutor(pool, options);
  }

  /**
   * Runs one statement as: BEGIN READ ONLY; SET LOCAL statement_timeout; the
   * query; COMMIT. Any failure rolls back. If the rollback itself fails, the
   * connection is destroyed instead of being returned to the pool.
   */
  async query(sql: string, params: readonly unknown[]): Promise<Row[]> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN READ ONLY');
      // set_config(..., true) is SET LOCAL, but takes the value as a bind parameter.
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.statementTimeoutMs)]);
      const result = await client.query(sql, [...params]);
      await client.query('COMMIT');
      return result.rows;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Output projection
// ---------------------------------------------------------------------------

export interface DroppedKeys {
  /** Keys present in the result but not declared by the catalog entry. */
  readonly undeclared: string[];
  /** Keys (at any depth) matching the sensitive pattern. */
  readonly sensitive: string[];
}

export interface Projection {
  readonly rows: Row[];
  readonly dropped: DroppedKeys;
}

/**
 * Rebuilds each row from the declared column list. Defense in depth: even if a
 * query is later edited to return more than it declares, only declared keys
 * leave the server. Sensitive keys are dropped at every depth (JSON values
 * included), even when declared.
 */
export function projectRows(
  rows: readonly Row[],
  columns: readonly string[],
  sensitive: RegExp = SENSITIVE_COLUMN_PATTERN,
): Projection {
  const undeclared = new Set<string>();
  const sensitiveDropped = new Set<string>();
  const declared = new Set(columns);

  const scrub = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => scrub(item, `${path}[]`));
    if (!isPlainObject(value)) return value;
    const entries: Array<[string, unknown]> = [];
    for (const [key, inner] of Object.entries(value)) {
      if (sensitive.test(key)) {
        sensitiveDropped.add(`${path}.${key}`);
      } else {
        entries.push([key, scrub(inner, `${path}.${key}`)]);
      }
    }
    return Object.fromEntries(entries);
  };

  const projected = rows.map((row) => {
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(row)) {
      if (sensitive.test(key)) {
        sensitiveDropped.add(key);
      } else if (!declared.has(key)) {
        undeclared.add(key);
      }
    }
    for (const column of columns) {
      if (sensitive.test(column) || !Object.hasOwn(row, column)) continue;
      entries.push([column, scrub(row[column], column)]);
    }
    // fromEntries defines own data properties, so a key like "__proto__"
    // cannot alter the prototype of the result.
    return Object.fromEntries(entries);
  });

  return {
    rows: projected,
    dropped: { undeclared: [...undeclared].sort(), sensitive: [...sensitiveDropped].sort() },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// Running a catalog entry
// ---------------------------------------------------------------------------

export interface QueryOutcome {
  readonly rows: Row[];
  readonly rowCount: number;
  /**
   * True when more rows matched than were returned. Every catalog statement
   * fetches one row beyond the limit (see fetchLimit) to find this out.
   */
  readonly hasMore: boolean;
  readonly dropped: DroppedKeys;
}

/**
 * Validates input, binds parameters, executes, caps at the requested limit and projects. The input is
 * parsed here even though the MCP layer already validated it, so no caller can
 * reach the database with unvalidated arguments.
 */
export async function runQuery(
  executor: Executor,
  entry: CatalogEntry,
  args: unknown,
  maxRows: number = MAX_ROWS,
): Promise<QueryOutcome> {
  const input = entry.input.parse(args);
  const params = entry.params(input);
  const limit = rowLimit(input, maxRows);
  const raw = await executor.query(entry.sql, params);
  const { rows, dropped } = projectRows(raw.slice(0, limit), entry.columns);
  return { rows, rowCount: rows.length, hasMore: raw.length > limit, dropped };
}
