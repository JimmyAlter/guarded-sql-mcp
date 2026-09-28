import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  containsPattern,
  deviceSoftware,
  escapeLike,
  findPeople,
  getDevice,
  openTickets,
  searchDevices,
  staleDevices,
} from '../../src/catalog.js';

const INJECTION = "x'; DROP TABLE devices;--";

describe('input schemas', () => {
  describe('limit', () => {
    it.each([0, -1, 101, 1000, 2.5])('rejects limit %s', (limit) => {
      expect(searchDevices.input.safeParse({ limit }).success).toBe(false);
    });

    it('rejects a numeric string instead of a number', () => {
      expect(searchDevices.input.safeParse({ limit: '25' }).success).toBe(false);
    });

    it('defaults to 25 and accepts the bounds 1 and 100', () => {
      expect(searchDevices.input.parse({})).toEqual({ limit: 25 });
      expect(searchDevices.input.parse({ limit: 1 }).limit).toBe(1);
      expect(searchDevices.input.parse({ limit: 100 }).limit).toBe(100);
    });
  });

  describe('hostname', () => {
    it.each([
      INJECTION,
      '',
      'a'.repeat(64),
      'host name',
      'host.example.com',
      'hôst',
      'nb-lt-001\n',
      '%',
    ])('rejects %j', (hostname) => {
      expect(getDevice.input.safeParse({ hostname }).success).toBe(false);
      expect(deviceSoftware.input.safeParse({ hostname }).success).toBe(false);
    });

    it.each(['nb-lt-001', 'CO-SRV-01', 'a', 'a'.repeat(63)])('accepts %j', (hostname) => {
      expect(getDevice.input.safeParse({ hostname }).success).toBe(true);
    });
  });

  describe('free-text search', () => {
    it('rejects name_or_email shorter than 2 or longer than 80 characters', () => {
      expect(findPeople.input.safeParse({ name_or_email: 'a' }).success).toBe(false);
      expect(findPeople.input.safeParse({ name_or_email: 'a'.repeat(81) }).success).toBe(false);
      expect(findPeople.input.safeParse({ name_or_email: 'a'.repeat(80) }).success).toBe(true);
    });

    it('trims before checking length, so whitespace cannot satisfy the minimum', () => {
      expect(findPeople.input.safeParse({ name_or_email: '    ' }).success).toBe(false);
      expect(findPeople.input.parse({ name_or_email: '  rivera ' }).name_or_email).toBe('rivera');
    });

    it('rejects control characters, including NUL', () => {
      expect(findPeople.input.safeParse({ name_or_email: 'ab\u0000cd' }).success).toBe(false);
      expect(searchDevices.input.safeParse({ os_contains: 'win\ndows' }).success).toBe(false);
    });

    it('accepts injection-looking text as plain data (it is only ever a bind parameter)', () => {
      expect(findPeople.input.safeParse({ name_or_email: INJECTION }).success).toBe(true);
    });

    it('rejects overlong os_contains and name_contains', () => {
      expect(searchDevices.input.safeParse({ os_contains: 'x'.repeat(41) }).success).toBe(false);
      expect(deviceSoftware.input.safeParse({ hostname: 'a', name_contains: 'x'.repeat(61) }).success).toBe(false);
    });
  });

  describe('enums and ranges', () => {
    it('rejects values outside the enums', () => {
      expect(searchDevices.input.safeParse({ status: 'deleted' }).success).toBe(false);
      expect(openTickets.input.safeParse({ priority: 'urgent' }).success).toBe(false);
    });

    it.each([0, 366, 30.5])('rejects stale_devices days %s', (days) => {
      expect(staleDevices.input.safeParse({ days }).success).toBe(false);
    });

    it('rejects site codes outside the pattern', () => {
      expect(searchDevices.input.safeParse({ site: 'North Branch' }).success).toBe(false);
      expect(searchDevices.input.safeParse({ site: INJECTION }).success).toBe(false);
    });
  });

  it('every tool rejects unknown keys such as sql', () => {
    for (const entry of CATALOG) {
      const withExtra = { ...(entry.example as object), sql: 'SELECT * FROM api_tokens' };
      expect(entry.input.safeParse(withExtra).success, entry.name).toBe(false);
    }
  });
});

describe('LIKE escaping', () => {
  it('escapes %, _ and the escape character itself', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain text')).toBe('plain text');
  });

  it('wraps escaped text for a contains match', () => {
    expect(containsPattern('a_b')).toBe('%a\\_b%');
    expect(containsPattern('%')).toBe('%\\%%');
  });

  it('is applied by params(), so % and _ from the model match literally', () => {
    const input = findPeople.input.parse({ name_or_email: '%_' });
    expect(findPeople.params(input)).toEqual(['%\\%\\_%', 26]);
  });

  it('every ILIKE in the catalog declares ESCAPE with a single backslash', () => {
    for (const entry of CATALOG) {
      const ilikes = entry.sql.match(/\bILIKE\b/gi)?.length ?? 0;
      const escapes = entry.sql.split("ESCAPE '\\'").length - 1;
      expect(escapes, entry.name).toBe(ilikes);
    }
  });
});
