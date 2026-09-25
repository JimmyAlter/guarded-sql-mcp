import type { Executor, Row } from '../../src/executor.js';

type Responder = (sql: string, params: readonly unknown[]) => Row[] | Promise<Row[]>;

/** Records every call and answers with whatever the test supplies. No database involved. */
export class FakeExecutor implements Executor {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly respond: Responder = () => []) {}

  async query(sql: string, params: readonly unknown[]): Promise<Row[]> {
    this.calls.push({ sql, params: [...params] });
    return this.respond(sql, params);
  }

  async close(): Promise<void> {}
}
