/**
 * JSON-lines audit log. Written to stderr by default because stdout is the
 * MCP stdio channel: anything else printed there would corrupt the protocol.
 */

export type LineWriter = (line: string) => void;

export const stderrWriter: LineWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

export interface ToolCallRecord {
  readonly tool: string;
  readonly args: unknown;
  readonly rowCount: number;
  readonly durationMs: number;
  readonly outcome: 'ok' | 'error';
  /** More rows matched than were returned. */
  readonly hasMore?: boolean;
  /** Keys removed by output projection. Sensitive drops indicate a catalog or schema problem. */
  readonly dropped?: { readonly undeclared: readonly string[]; readonly sensitive: readonly string[] };
  /** Internal error details. Never sent to the model. */
  readonly error?: { readonly code?: string; readonly message: string };
}

export class AuditLog {
  constructor(
    private readonly write: LineWriter = stderrWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  toolCall(record: ToolCallRecord): void {
    this.emit({ event: 'tool_call', ...record });
  }

  event(event: string, data: Record<string, unknown> = {}): void {
    this.emit({ event, ...data });
  }

  private emit(fields: Record<string, unknown>): void {
    // JSON.stringify escapes newlines inside values, so one record is one line.
    this.write(JSON.stringify({ ts: this.now().toISOString(), ...fields }));
  }
}
