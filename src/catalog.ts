/**
 * The fixed query catalog. This file is the complete list of things the model
 * can ask the database. Each entry is reviewed SQL with `$n` placeholders; tool
 * arguments are validated by the entry's zod schema and then passed as bind
 * parameters. No argument value is ever concatenated into SQL text.
 *
 * `validateCatalog()` checks every entry at startup (see validateCatalog.ts).
 */
import { z } from 'zod';
import { MAX_ROWS } from './policy.js';

export interface QueryDefinition<S extends z.ZodObject = z.ZodObject> {
  /** Tool name exposed over MCP. */
  readonly name: string;
  readonly title: string;
  /** Shown to the model. Describes the data; it does not grant or restrict anything. */
  readonly description: string;
  /** Strict object schema: unknown keys are rejected, every field is bounded. */
  readonly input: S;
  /** Static SQL. `$1..$n` placeholders only. */
  readonly sql: string;
  /** Maps validated input to bind parameters, in placeholder order. */
  readonly params: (input: z.output<S>) => readonly unknown[];
  /** Every table the SQL reads. Must match the FROM/JOIN references exactly. */
  readonly tables: readonly string[];
  /** The only keys that may leave the server, per row. */
  readonly columns: readonly string[];
  /** A valid input. Used by the validator, the integration tests and the docs. */
  readonly example: z.input<S>;
}

/** A catalog entry with its input type erased, so entries can live in one array. */
export type CatalogEntry = QueryDefinition;

export function defineQuery<S extends z.ZodObject>(definition: QueryDefinition<S>): CatalogEntry {
  // The cast only erases the input type parameter. Callers always pass input
  // that has been parsed by `definition.input` first (see runQuery).
  return Object.freeze(definition) as unknown as CatalogEntry;
}

/**
 * Escapes LIKE/ILIKE metacharacters so user text matches literally.
 * Must be paired with `ESCAPE '\'` in the SQL.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Builds a "contains" ILIKE pattern from user text. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

const optional = <T>(value: T | undefined): T | null => value ?? null;

// ---------------------------------------------------------------------------
// Input building blocks. Every string has a max length (and usually a pattern),
// every number has explicit bounds. The validator rejects unbounded fields.
// ---------------------------------------------------------------------------

export const HOSTNAME_PATTERN = /^[A-Za-z0-9-]{1,63}$/;
const SITE_CODE_PATTERN = /^[a-z0-9-]{2,32}$/;
/** Printable text only. Control characters (including NUL, which Postgres rejects in text) are refused. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]*$/;

const siteCode = z
  .string()
  .max(32)
  .regex(SITE_CODE_PATTERN, 'site code: 2-32 lowercase letters, digits or hyphens')
  .describe('Site code as returned by list_sites, e.g. "north-branch".');

const hostname = z
  .string()
  .max(63)
  .regex(HOSTNAME_PATTERN, 'hostname: 1-63 letters, digits or hyphens')
  .describe('Device hostname, e.g. "nb-lt-001". Case-insensitive.');

const searchText = (min: number, max: number, what: string) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(PRINTABLE_PATTERN, 'printable characters only')
    .describe(`${what} Matched literally: % and _ have no special meaning.`);

const limit = z
  .number()
  .int()
  .min(1)
  .max(MAX_ROWS)
  .default(25)
  .describe(`Maximum rows to return (1-${MAX_ROWS}, default 25).`);

const deviceStatus = z.enum(['online', 'offline', 'retired']);
const ticketPriority = z.enum(['low', 'medium', 'high', 'critical']);

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const listSites = defineQuery({
  name: 'list_sites',
  title: 'List sites',
  description: 'List all sites with their code, city and number of non-retired devices.',
  input: z.strictObject({}),
  sql: `
    SELECT s.code, s.name, s.city, count(d.id)::int AS active_devices
    FROM sites s
    LEFT JOIN devices d ON d.site_id = s.id AND d.status <> 'retired'
    GROUP BY s.id, s.code, s.name, s.city
    ORDER BY s.name
    LIMIT 100`,
  params: () => [],
  tables: ['sites', 'devices'],
  columns: ['code', 'name', 'city', 'active_devices'],
  example: {},
});

export const searchDevices = defineQuery({
  name: 'search_devices',
  title: 'Search devices',
  description:
    'Search devices by site, status and operating system. Returns hostname, site, OS, status, IP and last check-in time.',
  input: z.strictObject({
    site: siteCode.optional(),
    status: deviceStatus.optional().describe('Device status.'),
    os_contains: searchText(1, 40, 'Substring of the operating system name, e.g. "Windows".').optional(),
    limit,
  }),
  sql: `
    SELECT d.hostname, s.code AS site, d.os, d.status, host(d.ip) AS ip, d.last_seen_at
    FROM devices d
    JOIN sites s ON s.id = d.site_id
    WHERE ($1::text IS NULL OR s.code = $1)
      AND ($2::text IS NULL OR d.status::text = $2)
      AND ($3::text IS NULL OR d.os ILIKE $3 ESCAPE '\\')
    ORDER BY d.hostname
    LIMIT $4`,
  params: (i) => [
    optional(i.site),
    optional(i.status),
    i.os_contains === undefined ? null : containsPattern(i.os_contains),
    i.limit,
  ],
  tables: ['devices', 'sites'],
  columns: ['hostname', 'site', 'os', 'status', 'ip', 'last_seen_at'],
  example: { site: 'north-branch' },
});

export const getDevice = defineQuery({
  name: 'get_device',
  title: 'Get device',
  description:
    'Get one device by hostname, including its site and the name and email of the person it is assigned to.',
  input: z.strictObject({ hostname }),
  sql: `
    SELECT d.hostname, s.code AS site, s.name AS site_name, d.os, d.status,
           host(d.ip) AS ip, d.last_seen_at,
           p.full_name AS assigned_to, p.email AS assigned_email
    FROM devices d
    JOIN sites s ON s.id = d.site_id
    LEFT JOIN people p ON p.id = d.assigned_person_id
    WHERE lower(d.hostname) = lower($1)
    LIMIT 1`,
  params: (i) => [i.hostname],
  tables: ['devices', 'sites', 'people'],
  columns: [
    'hostname',
    'site',
    'site_name',
    'os',
    'status',
    'ip',
    'last_seen_at',
    'assigned_to',
    'assigned_email',
  ],
  example: { hostname: 'nb-lt-001' },
});

export const findPeople = defineQuery({
  name: 'find_people',
  title: 'Find people',
  description: 'Find people whose name or email contains the given text. Returns name, email, department and site.',
  input: z.strictObject({
    name_or_email: searchText(2, 80, 'Part of a full name or email address.'),
    limit,
  }),
  sql: `
    SELECT p.full_name, p.email, p.department, s.code AS site
    FROM people p
    JOIN sites s ON s.id = p.site_id
    WHERE p.full_name ILIKE $1 ESCAPE '\\' OR p.email ILIKE $1 ESCAPE '\\'
    ORDER BY p.full_name
    LIMIT $2`,
  params: (i) => [containsPattern(i.name_or_email), i.limit],
  tables: ['people', 'sites'],
  columns: ['full_name', 'email', 'department', 'site'],
  example: { name_or_email: 'rivera' },
});

export const deviceSoftware = defineQuery({
  name: 'device_software',
  title: 'Device software',
  description: 'List software installed on a device, optionally filtered by package name.',
  input: z.strictObject({
    hostname,
    name_contains: searchText(1, 60, 'Substring of the software name, e.g. "Chrome".').optional(),
    limit,
  }),
  sql: `
    SELECT si.name, si.version, si.installed_at
    FROM software_installs si
    JOIN devices d ON d.id = si.device_id
    WHERE lower(d.hostname) = lower($1)
      AND ($2::text IS NULL OR si.name ILIKE $2 ESCAPE '\\')
    ORDER BY si.name
    LIMIT $3`,
  params: (i) => [
    i.hostname,
    i.name_contains === undefined ? null : containsPattern(i.name_contains),
    i.limit,
  ],
  tables: ['software_installs', 'devices'],
  columns: ['name', 'version', 'installed_at'],
  example: { hostname: 'nb-lt-001' },
});

export const staleDevices = defineQuery({
  name: 'stale_devices',
  title: 'Stale devices',
  description:
    'List non-retired devices that have not checked in for at least the given number of days (or never), oldest first.',
  input: z.strictObject({
    days: z.number().int().min(1).max(365).default(30).describe('Days without check-in (1-365, default 30).'),
    site: siteCode.optional(),
    limit,
  }),
  sql: `
    SELECT d.hostname, s.code AS site, d.os, d.status, d.last_seen_at
    FROM devices d
    JOIN sites s ON s.id = d.site_id
    WHERE d.status <> 'retired'
      AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - make_interval(days => $1))
      AND ($2::text IS NULL OR s.code = $2)
    ORDER BY d.last_seen_at NULLS FIRST, d.hostname
    LIMIT $3`,
  params: (i) => [i.days, optional(i.site), i.limit],
  tables: ['devices', 'sites'],
  columns: ['hostname', 'site', 'os', 'status', 'last_seen_at'],
  example: { days: 30 },
});

export const openTickets = defineQuery({
  name: 'open_tickets',
  title: 'Open tickets',
  description: 'List tickets that are not closed, highest priority first, optionally filtered by site and priority.',
  input: z.strictObject({
    site: siteCode.optional(),
    priority: ticketPriority.optional().describe('Ticket priority.'),
    limit,
  }),
  sql: `
    SELECT t.id AS ticket_id, t.title, t.priority, t.status, s.code AS site,
           d.hostname, t.opened_at
    FROM tickets t
    JOIN sites s ON s.id = t.site_id
    LEFT JOIN devices d ON d.id = t.device_id
    WHERE t.status <> 'closed'
      AND ($1::text IS NULL OR s.code = $1)
      AND ($2::text IS NULL OR t.priority::text = $2)
    ORDER BY t.priority DESC, t.opened_at
    LIMIT $3`,
  params: (i) => [optional(i.site), optional(i.priority), i.limit],
  tables: ['tickets', 'sites', 'devices'],
  columns: ['ticket_id', 'title', 'priority', 'status', 'site', 'hostname', 'opened_at'],
  example: {},
});

export const CATALOG: readonly CatalogEntry[] = Object.freeze([
  listSites,
  searchDevices,
  getDevice,
  findPeople,
  deviceSoftware,
  staleDevices,
  openTickets,
]);
