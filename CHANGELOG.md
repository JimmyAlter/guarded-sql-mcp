# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-29

### Added

- The startup privilege check also warns when the connected role has
  `BYPASSRLS`, is a member of `pg_read_all_data` or `pg_write_all_data`, can
  `CREATE` in a schema or create temporary tables, has any privilege on a
  table outside the allowlist (such as `api_tokens`), or can `SELECT` a
  column whose name looks sensitive (such as `people.password_hash`). CI checks
  that `mcp_readonly` gets no warnings and the database owner gets all of them.
- Release badge in the README and a `.mailmap` for a consistent author name.

### Changed

- **Breaking:** `DATABASE_URL` must be a `postgres://` or `postgresql://` URL
  with a host; anything else (including libpq key=value strings) stops the
  server at startup. Errors never include the value.
- **Breaking:** `createServer` rejects `maxRows` outside 1-100 and response
  limits outside the bounds accepted from the environment, instead of using
  them. Options can only tighten the policy.
- `SECURITY.md`: report through GitHub private vulnerability reporting, or
  privately via the maintainer's GitHub profile; never in a public issue.
- Dependabot: the 3-day cooldown is explicit, and semver-major `@types/node`
  updates are ignored (`engines.node` is `>=22`).
- vitest 5.

### Fixed

- Dependabot npm runs failed with `ETARGET ... with a date before`: the
  lockfile pinned `typescript-eslint` 8.71.0, published inside the cooldown
  window. The lockfile is now resolved with `npm install --before`.

## [0.2.0] - 2026-09-28

### Added

- Response size cap. String cells longer than `MAX_CELL_CHARS` (default 1000)
  are cut and end with `…[truncated N chars]`, and trailing rows are dropped
  until the JSON body fits `MAX_RESPONSE_BYTES` (default 64 KiB). Results carry
  `truncated: true`, and the audit record gets `responseBytes` plus the number
  of cells cut and rows dropped. Both limits are configurable within hard
  bounds.
- Structured output: every tool declares an `outputSchema` derived from its
  declared columns, and successful results return `structuredContent`
  alongside the JSON text.
- `AUDIT_REDACT_ARGS` logs string tool arguments as `"[redacted]"`.
- `db/roles.sql` sets session defaults for `mcp_readonly`:
  `default_transaction_read_only = on`, `statement_timeout = 5s`,
  `idle_in_transaction_session_timeout = 10s`.
- Validator rule `limit-lookahead`: a trailing `LIMIT $n` must be bound to
  `fetchLimit(limit)`.
- `npm run lint` (typescript-eslint, strict-type-checked) in CI.
- `npm run demo`: a reproducible transcript of one normal call and four
  refusals, pasted in the README and checked in CI.
- CodeQL analysis, Dependabot (npm and GitHub Actions) and `SECURITY.md`.
- Package metadata (repository, homepage, bugs, keywords) and a
  `prepublishOnly` check.

### Changed

- **Breaking:** the result field `truncated` meant "more rows exist" and is now
  `hasMore`; `truncated` now means the size limits changed the response.
  Results are `{ rowCount, hasMore, truncated, rows }`.
- **Breaking:** Node.js 22 or later is required. CI tests Node 22 and 24.
- Cells are JSON scalars: timestamps are ISO 8601 strings, and JSON or array
  values are serialized to strings.
- The server version is read from `package.json` instead of a duplicate
  constant.
- Third-party GitHub Actions are pinned by commit SHA.
- The build cleans `dist/` and no longer emits source maps.

### Fixed

- "More rows" was never reported: every statement's `LIMIT` was bound to the
  requested limit, so the executor could not see an extra row. Statements now
  fetch `limit + 1` rows and return at most `limit`.

## [0.1.0] - 2026-09-28

### Added

- MCP server over stdio with a fixed catalog of seven read-only tools over a
  fictional IT asset inventory; no tool accepts SQL.
- Strict zod input schemas: unknown keys rejected, every field bounded,
  `ILIKE` search text escaped.
- Startup catalog validator (table allowlist, sensitive identifiers, trailing
  `LIMIT`, no `SELECT *`, write keywords, side-effecting functions, comments,
  dollar quoting, placeholder and parameter checks).
- `PgExecutor`: `BEGIN READ ONLY`, transaction-local `statement_timeout`,
  rollback on error, broken connections destroyed.
- Output projection onto declared columns, dropping sensitive keys at any
  depth; 100-row cap.
- Least-privileged `mcp_readonly` role with table- and column-level grants.
- Generic errors to the model; JSON-lines audit log on stderr.
- Unit, protocol and PostgreSQL 16 integration tests in CI.

[0.3.0]: https://github.com/JimmyAlter/guarded-sql-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JimmyAlter/guarded-sql-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JimmyAlter/guarded-sql-mcp/releases/tag/v0.1.0
