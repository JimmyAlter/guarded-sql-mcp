import { describe, expect, it } from 'vitest';
import { AuditLog, REDACTED, redactStrings } from '../../src/audit.js';

function capture(redactArgs?: boolean) {
  const lines: string[] = [];
  const log = new AuditLog((line) => lines.push(line), () => new Date('2026-01-01T00:00:00Z'), { redactArgs });
  return { log, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const call = {
  tool: 'find_people',
  args: { name_or_email: 'sam.rivera@example.com', limit: 25 },
  rowCount: 1,
  durationMs: 1,
  outcome: 'ok' as const,
};

describe('AuditLog', () => {
  it('logs arguments verbatim by default', () => {
    const { log, records } = capture();
    log.toolCall(call);
    expect(records()[0]).toMatchObject({ event: 'tool_call', args: call.args, ts: '2026-01-01T00:00:00.000Z' });
  });

  it('redacts string arguments when redactArgs is on, keeping numbers', () => {
    const { log, records } = capture(true);
    log.toolCall(call);
    const [record] = records();
    expect(record).toMatchObject({ tool: 'find_people', args: { name_or_email: REDACTED, limit: 25 } });
    expect(JSON.stringify(record)).not.toContain('rivera');
  });

  it('writes one JSON object per line, even when values contain newlines', () => {
    const lines: string[] = [];
    new AuditLog((line) => lines.push(line)).event('note', { text: 'a\nb' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
  });
});

describe('redactStrings', () => {
  it('replaces strings at any depth and leaves other values alone', () => {
    expect(redactStrings({ a: 'x', b: [1, 'y', { c: 'z', d: null }], e: true })).toEqual({
      a: REDACTED,
      b: [1, REDACTED, { c: REDACTED, d: null }],
      e: true,
    });
  });
});
