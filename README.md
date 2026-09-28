# guarded-sql-mcp

[![CI](https://github.com/JimmyAlter/guarded-sql-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/JimmyAlter/guarded-sql-mcp/actions/workflows/ci.yml)

An MCP server that gives an LLM agent read access to a PostgreSQL database
through a fixed catalog of parameterized queries. The model can pick a query
and fill in bounded parameters. It cannot write SQL, and it cannot reach tables
or columns that the catalog and the database role do not allow. This is a
public reimplementation of a pattern I use in five internal, closed-source MCP
servers that expose PostgreSQL and SQL Server to LLM agents; none of that code
is here. It was written from scratch, with a fictional schema and data, so that
the approach and the tests behind it can be read in full.

The schema is a fictional IT asset inventory (sites, devices, people, installed
software, tickets).

## Threat model

Treat everything the model sends as untrusted input. It may have read a
malicious ticket title, a poisoned web page or a crafted email, and its tool
arguments can carry whatever that content asked for. A system prompt that says
"never read the password column" is a request, not an access control. So every
restriction here is enforced in code or in the database, and each one is
covered by a test:

- **No free-form SQL is reachable by the model.** Every tool maps to one
  static, reviewed statement. Arguments are only ever bind parameters.
- **Password and secret columns are excluded by construction.** They are
  rejected in the catalog at startup, stripped from results at runtime, and not
  granted to the database role.
- **The table allowlist is checked in code, not described in a prompt.** A
  catalog entry that touches a table outside the allowlist stops the server
  from starting.
- **A single call cannot flood the model's context.** Rows are capped at
  100, every string cell at 1000 characters, and the whole JSON response at
  64 KiB. Without the byte cap, one call over a few wide rows could return
  megabytes. Anything cut is flagged `truncated: true` in the result and
  recorded in the audit log.

## Defense layers

```mermaid
flowchart TD
    S["Startup: validateCatalog()"] -.->|must pass before the server is built| T
    M["Model: tools/call"] --> T{"Tool in the catalog?"}
    T -- no --> R1["Refused"]
    T -- yes --> V{"Strict zod schema:<br/>bounded fields, no unknown keys"}
    V -- invalid --> R2["Refused, executor never called"]
    V -- valid --> P["params() builds $1..$n bind values"]
    P --> X["PgExecutor: BEGIN READ ONLY,<br/>SET LOCAL statement_timeout,<br/>static SQL ending in LIMIT, COMMIT"]
    X --> DB[("PostgreSQL as mcp_readonly:<br/>table and column grants")]
    DB --> C["Row cap, then projection onto declared<br/>columns; sensitive keys dropped"]
    C --> SZ["Size cap: long cells cut,<br/>trailing rows dropped to fit 64 KiB"]
    SZ --> OUT["structuredContent + JSON text to the model"]
    X -- error --> E["Generic error to the model,<br/>details to the audit log"]
```

1. **Fixed catalog** ([src/catalog.ts](src/catalog.ts)). One MCP tool per
   entry. There is no generic query tool and no parameter named `sql`,
   `query` or `statement`.
2. **Input validation.** Each entry has a `z.strictObject` schema. Unknown
   keys are rejected. Every string has a maximum length and usually a pattern
   (hostnames: `^[A-Za-z0-9-]{1,63}$`), every number has explicit bounds,
   `limit` is 1..100. Search text is matched with `ILIKE ... ESCAPE '\'` after
   escaping `%` and `_`, so the model cannot turn a search into a wildcard
   dump.
3. **Startup catalog validation** ([src/validateCatalog.ts](src/validateCatalog.ts)).
   Before the server is created, every entry is checked (see
   [What the validator rejects](#what-the-validator-rejects)). One bad entry
   means the process exits.
4. **Read-only execution** ([src/executor.ts](src/executor.ts)). Every call
   runs as `BEGIN READ ONLY`, a transaction-local `statement_timeout` (default
   5 s), the statement, then `COMMIT`, or `ROLLBACK` on any error. Every
   statement must end in `LIMIT`, and at most 100 rows leave the server.
   The `LIMIT` is bound to one row more than requested, so a result can say
   `hasMore: true` when more rows matched than were returned.
5. **Output projection.** Each row is rebuilt from the entry's declared column
   list. Undeclared keys are dropped. Keys matching the sensitive pattern are
   dropped at any depth, including inside JSON values, even if declared. Drops
   are recorded in the audit log.
6. **Response size cap** ([src/response.ts](src/response.ts)). Every cell
   becomes a JSON scalar (dates as ISO strings, JSON values serialized). String
   cells longer than `MAX_CELL_CHARS` (default 1000) are cut and end with
   `…[truncated N chars]`. Trailing rows are then dropped until the serialized
   body fits `MAX_RESPONSE_BYTES` (default 64 KiB). The result carries
   `truncated: true` and the audit record says how many cells were cut and rows
   dropped.
7. **Database role** ([db/roles.sql](db/roles.sql)). `mcp_readonly` has
   `SELECT` on the allowlisted tables only, column-level `SELECT` on `people`
   that leaves out `password_hash` and `mfa_secret`, nothing on `api_tokens`,
   and no `CREATE` or `TEMP`. Its sessions default to
   `default_transaction_read_only = on`, `statement_timeout = 5s` and
   `idle_in_transaction_session_timeout = 10s`, so even a session opened
   outside the server (psql with the same credentials) is read-only and
   time-bounded. The code layers do not rely on this, and the integration tests
   check it separately.

Database errors reach the model as a generic message. The SQLSTATE and message
go to the audit log: JSON lines on stderr, because stdout is the MCP stdio
channel.

```json
{"ts":"2026-09-25T16:30:15.850Z","event":"tool_call","tool":"find_people","args":{"name_or_email":"rivera","limit":25},"rowCount":1,"durationMs":3.1,"outcome":"ok","hasMore":false,"truncated":false,"responseBytes":157}
```

## Tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `list_sites` | none | code, name, city, count of non-retired devices |
| `search_devices` | `site?`, `status?` (online/offline/retired), `os_contains?` (1-40), `limit` | hostname, site, os, status, ip, last_seen_at |
| `get_device` | `hostname` | device, site, and the assigned person's name and email |
| `find_people` | `name_or_email` (2-80), `limit` | full_name, email, department, site |
| `device_software` | `hostname`, `name_contains?` (1-60), `limit` | name, version, installed_at |
| `stale_devices` | `days` (1-365, default 30), `site?`, `limit` | non-retired devices not seen for `days` or never |
| `open_tickets` | `site?`, `priority?` (low/medium/high/critical), `limit` | ticket_id, title, priority, status, site, hostname, opened_at |

`site` is a site code such as `north-branch`. `limit` is 1-100, default 25.
All tools are annotated `readOnlyHint: true`.

Every tool declares an `outputSchema` derived from its column list, and a
successful result carries the same body twice: as `structuredContent`
(validated against that schema by the SDK) and as JSON text for clients that
do not read structured output:

```json
{"rowCount":1,"hasMore":false,"truncated":false,"rows":[{"full_name":"Sam Rivera","email":"sam.rivera@example.com","department":"IT","site":"north-branch"}]}
```

`hasMore: true` means more rows matched than were returned. `truncated: true`
means the size limits cut a value or dropped rows (see below). Cells are JSON
scalars: strings, numbers, booleans or `null`; timestamps are ISO 8601
strings.

## Quick start

Requirements: Node.js 22 or later, and Docker for the local database.

The package is not published to npm yet, so run it from a clone:

```bash
git clone https://github.com/JimmyAlter/guarded-sql-mcp.git
cd guarded-sql-mcp
docker compose up -d          # postgres:16 with db/schema.sql, roles.sql, seed.sql
npm ci
npm run build                 # produces dist/index.js
```

The server reads its settings from environment variables and does not load
`.env` files. [.env.example](.env.example) lists them, and the MCP client
passes them (see below). Always connect as `mcp_readonly`, never as the owner.
At startup the server logs a `privilege_warning` if the role is a superuser or
can write.

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | required | e.g. `postgres://mcp_readonly:mcp_readonly_dev@localhost:5432/inventory` |
| `STATEMENT_TIMEOUT_MS` | `5000` | Per-statement timeout inside each transaction (1-600000) |
| `MAX_RESPONSE_BYTES` | `65536` | Upper bound on one tool result's JSON body (4096-1048576) |
| `MAX_CELL_CHARS` | `1000` | Longest string a cell may carry before it is cut (100-100000) |
| `AUDIT_REDACT_ARGS` | off | `1`/`true`/`on`: log string arguments as `"[redacted]"` in the audit log |

**Claude Code:**

```bash
claude mcp add --transport stdio guarded-sql \
  --env DATABASE_URL=postgres://mcp_readonly:mcp_readonly_dev@localhost:5432/inventory \
  -- node /absolute/path/to/guarded-sql-mcp/dist/index.js
```

**Claude Desktop** (or any client that takes an `mcpServers` block):

```json
{
  "mcpServers": {
    "guarded-sql": {
      "command": "node",
      "args": ["/absolute/path/to/guarded-sql-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgres://mcp_readonly:mcp_readonly_dev@localhost:5432/inventory"
      }
    }
  }
}
```

Once the package is published to npm, `npx -y guarded-sql-mcp` will replace
`node /absolute/path/to/guarded-sql-mcp/dist/index.js` in both snippets. Until
then that command does not work.

The password in `db/roles.sql` and the compose file is for local development.
Anywhere else, set a real one with `ALTER ROLE mcp_readonly PASSWORD '...'`.

## Demo

[scripts/demo.mjs](scripts/demo.mjs) connects a real MCP SDK client to the
built server over an in-memory transport and makes five calls. The only stand-in
is the database: a fake executor answers every query with one fixed row copied
from `db/seed.sql` and records whether it was called, so the output is the same
on every run and needs no PostgreSQL. This is not an LLM session; it shows
exactly what any MCP client, model-driven or not, gets back.

```bash
npm run build && npm run demo
```

The output below was produced by that command, unedited (audit records are
printed without their `ts` and `durationMs` fields, which change every run).
CI runs `node scripts/demo.mjs --check` and fails if it drifts:

```text
tools/list -> 7 tools: list_sites, search_devices, get_device, find_people, device_software, stale_devices, open_tickets

## A normal call
tools/call find_people {"name_or_email":"rivera"}
isError: false
text: {"rowCount":1,"hasMore":false,"truncated":false,"rows":[{"full_name":"Sam Rivera","email":"sam.rivera@example.com","department":"IT","site":"north-branch"}]}
structuredContent equals text: true
database reached: yes
audit: {"event":"tool_call","tool":"find_people","args":{"name_or_email":"rivera","limit":25},"rowCount":1,"outcome":"ok","hasMore":false,"truncated":false,"responseBytes":157}

## Refused: unknown key `sql`
tools/call get_device {"hostname":"nb-lt-001","sql":"SELECT token_hash FROM api_tokens"}
isError: true
text: MCP error -32602: Input validation error: Invalid arguments for tool get_device: Unrecognized key: "sql"
database reached: no
audit: (none: refused before the handler ran)

## Refused: limit above the cap
tools/call search_devices {"limit":1000}
isError: true
text: MCP error -32602: Input validation error: Invalid arguments for tool search_devices: Too big: expected number to be <=100 at limit
database reached: no
audit: (none: refused before the handler ran)

## Refused: injection-looking hostname
tools/call get_device {"hostname":"x'; DROP TABLE devices;--"}
isError: true
text: MCP error -32602: Input validation error: Invalid arguments for tool get_device: hostname: 1-63 letters, digits or hyphens at hostname
database reached: no
audit: (none: refused before the handler ran)

## Refused: a tool that does not exist
tools/call run_sql {"sql":"SELECT 1"}
isError: true
text: MCP error -32602: Tool run_sql not found
database reached: no
audit: (none: refused before the handler ran)
```

Invalid arguments are refused by the SDK against the tool's strict schema
before the handler runs, so they never reach the database and are not in the
audit log (see [Limitations](#limitations-and-non-goals)).

## Adding a query

Add an entry with `defineQuery` in [src/catalog.ts](src/catalog.ts) and append
it to `CATALOG`:

```ts
export const devicesByPerson = defineQuery({
  name: 'devices_by_person',
  title: 'Devices by person',
  description: 'List devices assigned to a person, by exact email address.',
  input: z.strictObject({
    email: z.string().max(120).regex(/^[^\s@]+@[^\s@]+$/),
    limit,
  }),
  sql: `
    SELECT d.hostname, d.os, d.status
    FROM devices d
    JOIN people p ON p.id = d.assigned_person_id
    WHERE lower(p.email) = lower($1)
    ORDER BY d.hostname
    LIMIT $2`,
  params: (i) => [i.email, fetchLimit(i.limit)],
  tables: ['devices', 'people'],
  columns: ['hostname', 'os', 'status'],
  example: { email: 'sam.rivera@example.com' },
});
```

If the query needs a table or column the role cannot read, update
`db/roles.sql` as well. The integration suite runs every entry's `example`
against the seeded database and expects rows back.

### What the validator rejects

| Rule | Example |
| --- | --- |
| `table-not-allowed` | Declares or reads `api_tokens` or any table outside `ALLOWED_TABLES` |
| `table-undeclared`, `table-unreferenced` | SQL reads a table missing from `tables`, or `tables` lists one the SQL never reads |
| `unsupported-table-ref` | Comma joins, schema-qualified or quoted names, `TABLE x`, `LATERAL`, anything after `FROM` it cannot verify |
| `sensitive-column`, `sensitive-identifier` | A declared column, or any identifier in the SQL, matching `/pass(word)?\|hash\|secret\|token\|api[_-]?key\|salt\|mfa\|otp/i` (so `password_hash AS note` fails too) |
| `not-select`, `multi-statement` | Anything that does not start with `SELECT`/`WITH`; any `;` |
| `write-keyword`, `forbidden-function` | `INSERT`/`UPDATE`/`DELETE` in a CTE, `SELECT INTO`, `FOR UPDATE`/`FOR SHARE`, `pg_sleep`, `set_config`, `query_to_xml` and similar |
| `wildcard-select` | `SELECT *` or `alias.*` (`count(*)` is fine) |
| `missing-limit` | No trailing `LIMIT`, or a literal limit above the row cap |
| `limit-lookahead` | A trailing `LIMIT $n` not bound to `fetchLimit(limit)` (limit + 1), which would make `hasMore` always false |
| `unsupported-syntax` | Comments, dollar quoting, unbalanced quotes |
| `placeholder-gap`, `param-count`, `param-undefined` | `$1, $3` without `$2`; `params()` length differs from the highest placeholder; an optional input mapped to `undefined` instead of `null` |
| `non-strict-input`, `unbounded-input`, `forbidden-param-name` | `z.object` instead of `z.strictObject`; a string without `max`, a number without both bounds, nested objects or arrays; a parameter named like `sql`, `query`, `statement` |
| `invalid-example`, `duplicate-name`, `invalid-name`, `no-columns` | Self-explanatory |

## Testing

```bash
npm run typecheck          # tsc --noEmit, strict
npm test                   # unit + protocol tests, no database needed
npm run lint               # typescript-eslint, strict-type-checked
npm run build && npm run smoke   # start dist/index.js over stdio and check tools/list
npm run demo               # the transcript in the Demo section (after build)
npm run test:integration   # needs DATABASE_URL (as mcp_readonly); skipped otherwise
```

What each suite shows:

- **Unit: validator** (`test/unit/validateCatalog.test.ts`). The real catalog
  passes. For each rule above, a small inline catalog that breaks it is
  rejected, including `FROM a JOIN b` with no alias and a sensitive column
  behind an innocent alias.
- **Unit: inputs** (`test/unit/inputs.test.ts`). Out-of-range limits, bad
  hostnames such as `x'; DROP TABLE devices;--`, overlong and control-character
  strings, unknown keys like `sql` are all rejected. `%` and `_` are escaped,
  and every `ILIKE` has a matching `ESCAPE '\'`.
- **Unit: executor** (`test/unit/executor.test.ts`). Projection keeps only
  declared columns and drops sensitive keys at any depth. The row cap holds
  when the executor returns 500 rows. Arguments reach the executor only as
  bind parameters. Against a recording fake pool, `PgExecutor` issues
  `BEGIN READ ONLY`, the timeout, the query, `COMMIT`, and `ROLLBACK` on error.
- **Unit: response size** (`test/unit/response.test.ts`,
  `test/unit/config.test.ts`). Long cells are cut without splitting a
  surrogate pair, trailing rows are dropped until the body fits, escaped
  characters are counted at their serialized size, and one over-wide row yields
  zero rows rather than an oversized response. Out-of-range limits in the
  environment stop the server from starting.
- **Protocol** (`test/protocol/server.test.ts`). A real SDK `Client` connects
  over `InMemoryTransport`. `tools/list` is exactly the catalog, and every
  schema is closed and bounded. Invalid arguments and unknown tools are refused
  before the executor runs. When a fake executor returns `password_hash`,
  `mfa_secret` and `token_hash`, none of them reaches the client. Database
  errors come back generic. Each tool's `outputSchema` lists exactly its
  columns, and `structuredContent` equals the JSON text. An executor that returns 101 rows of ~1 MB each
  produces a response under 64 KiB, flagged `truncated` and audited.
- **Integration** (`test/integration/database.test.ts`). Runs against
  PostgreSQL loaded with `db/*.sql`, connected as `mcp_readonly`. Every tool
  returns rows with no sensitive keys and none of the seeded secret values.
  Writes through the executor fail with `25006` (read-only transaction), and
  the timeout cancels `pg_sleep`. A fresh session as `mcp_readonly` shows
  `default_transaction_read_only = on`, and writes still get `42501` inside an
  explicit `READ WRITE` transaction. The role gets `42501` on `api_tokens`, on
  `people.password_hash`, and on `SELECT *` or `row_to_json(p)` from `people`.
  Injection-looking inputs return zero rows, not errors.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck, lint, tests,
build and the stdio smoke test on Node 22 and 24. It also runs the integration
suite against a `postgres:16` service, with `REQUIRE_INTEGRATION=1` so a
missing database fails the job instead of skipping it.

## Limitations and non-goals

- **Not a general SQL tool.** If a question is not covered by the catalog, the
  answer is a new reviewed entry, not a more flexible tool.
- **PostgreSQL only.** The pattern works for SQL Server too, but this
  repository does not implement it.
- **The validator is a guard, not a parser.** It uses regular expressions over
  a small catalog that humans review, and it fails closed on constructs it
  cannot verify (`EXTRACT(x FROM y)`, `IS DISTINCT FROM`, comma joins). Never
  use it to vet SQL from a user or a model. It also cannot see whole-row
  references such as `SELECT p FROM people p`. The column grants catch those,
  and the integration tests show it.
- **Projection works on names, not content.** It removes keys that look
  sensitive. It cannot know whether an innocently named column holds a secret.
- **Tool output is untrusted too.** Names, emails and ticket titles are
  returned to the model by design, and a ticket title can itself contain a
  prompt injection. This server does not sanitize content. The client must
  treat tool results as data.
- **Refused calls are not audited.** The SDK answers calls with invalid
  arguments or unknown tool names before the handler runs, so they do not
  appear in the audit log. Calls that pass validation are always logged.
- **The audit log keeps arguments verbatim by default.** Search text such as
  a person's name or email in `find_people` ends up in the log as typed. Set
  `AUDIT_REDACT_ARGS=1` to log every string argument as `"[redacted]"`
  (numbers such as `limit` are kept). Results are never logged, only row
  counts and sizes.
- **No per-user authorization.** It is a local stdio server. Whoever can
  start it gets the database role's access.

## License

[MIT](LICENSE) © Thiago Langone
