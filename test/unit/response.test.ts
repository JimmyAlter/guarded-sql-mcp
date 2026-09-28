import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CELL_CHARS, DEFAULT_MAX_RESPONSE_BYTES } from '../../src/policy.js';
import { shapeResponse, truncateString } from '../../src/response.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('truncateString', () => {
  it('leaves short strings alone', () => {
    expect(truncateString('abc', 3)).toBe('abc');
  });

  it('cuts to the limit and says how much was removed', () => {
    expect(truncateString('abcdefgh', 3)).toBe('abc…[truncated 5 chars]');
  });

  it('never splits a surrogate pair', () => {
    const out = truncateString('ab😀cd', 3);
    expect(out).toBe('ab…[truncated 4 chars]');
  });
});

describe('shapeResponse', () => {
  it('passes small results through unchanged', () => {
    const rows = [{ code: 'hq', active_devices: 3 }];
    const shaped = shapeResponse(rows, false);
    expect(shaped.body).toEqual({ rowCount: 1, hasMore: false, truncated: false, rows });
    expect(shaped.text).toBe(JSON.stringify(shaped.body));
    expect(shaped.bytes).toBe(bytes(shaped.text));
    expect(shaped).toMatchObject({ cellsTruncated: 0, rowsDropped: 0 });
  });

  it('keeps hasMore from the query when nothing was dropped', () => {
    expect(shapeResponse([{ a: 1 }], true).body).toMatchObject({ hasMore: true, truncated: false });
  });

  it('turns driver values into JSON scalars', () => {
    const [row] = shapeResponse(
      [
        {
          seen: new Date('2026-01-02T03:04:05Z'),
          big: 12345678901234567890n,
          json: { a: [1, 2] },
          nan: Number.NaN,
          nothing: undefined,
          flag: true,
        },
      ],
      false,
    ).body.rows;
    expect(row).toEqual({
      seen: '2026-01-02T03:04:05.000Z',
      big: '12345678901234567890',
      json: '{"a":[1,2]}',
      nan: 'NaN',
      nothing: null,
      flag: true,
    });
  });

  it('cuts long string cells, including serialized JSON values', () => {
    const long = 'y'.repeat(DEFAULT_MAX_CELL_CHARS + 50);
    const shaped = shapeResponse([{ note: long, json: { note: long } }], false);
    const row = shaped.body.rows[0]!;
    expect(row['note']).toBe(`${'y'.repeat(DEFAULT_MAX_CELL_CHARS)}…[truncated 50 chars]`);
    expect(String(row['json'])).toMatch(/…\[truncated \d+ chars\]$/);
    expect(shaped).toMatchObject({ cellsTruncated: 2, rowsDropped: 0 });
    expect(shaped.body.truncated).toBe(true);
  });

  it('drops trailing rows until the body fits, and never exceeds the byte cap', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, text: 'é'.repeat(1_000) }));
    const shaped = shapeResponse(rows, false);
    expect(shaped.bytes).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_BYTES);
    expect(shaped.body.rowCount).toBe(shaped.body.rows.length);
    expect(shaped.body.rows.map((r) => r['id'])).toEqual([...Array(shaped.body.rowCount).keys()]);
    expect(shaped.rowsDropped).toBe(100 - shaped.body.rowCount);
    expect(shaped.body).toMatchObject({ hasMore: true, truncated: true });
    // Adding back the next row would have gone over the cap.
    const withOneMore = JSON.stringify({ ...shaped.body, rows: rows.slice(0, shaped.body.rowCount + 1) });
    expect(bytes(withOneMore)).toBeGreaterThan(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('counts escaped characters at their serialized size', () => {
    const rows = Array.from({ length: 50 }, () => ({ text: '\u0001'.repeat(900) }));
    const shaped = shapeResponse(rows, false, { maxResponseBytes: 8_192, maxCellChars: 1_000 });
    expect(shaped.bytes).toBeLessThanOrEqual(8_192);
    expect(shaped.body.rowCount).toBe(1);
  });

  it('returns zero rows rather than exceed the cap when one row is too wide', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, 'z'.repeat(500)]));
    const shaped = shapeResponse([wide], false, { maxResponseBytes: 4_096, maxCellChars: 1_000 });
    expect(shaped.body).toEqual({ rowCount: 0, hasMore: true, truncated: true, rows: [] });
    expect(shaped.bytes).toBeLessThanOrEqual(4_096);
  });
});
