# Security policy

## Supported versions

Only the latest release receives fixes. This is a small project maintained by
one person; there are no backports.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not put details in a public
issue, pull request or discussion.

1. **Preferred:** GitHub private vulnerability reporting. On the repository's
   [Security tab](https://github.com/JimmyAlter/guarded-sql-mcp/security), use
   **Report a vulnerability** to open a private security advisory visible only
   to you and the maintainer.
2. **If that button is not available:** contact the maintainer privately using
   the contact details on their GitHub profile,
   [@JimmyAlter](https://github.com/JimmyAlter), and say that it concerns
   guarded-sql-mcp.

Include the version or commit, a description of the issue and, if you can, a
minimal reproduction (a catalog entry, tool arguments or a database state).

You can expect an acknowledgement within a week. If the report is confirmed, a
fix and an advisory are published together, crediting you unless you prefer
otherwise.

## What counts as a vulnerability

The guarantees this server tries to give are listed in the README's
[threat model](README.md#threat-model). Anything that breaks one of them is in
scope, for example:

- tool arguments that change the SQL that runs, or reach a table or column the
  catalog and role do not allow;
- a sensitive column or value reaching the model or the audit log;
- a write, lock or side effect caused through a tool call;
- a way around the response size limits, or a database error detail reaching
  the model;
- a catalog entry that should fail startup validation but passes.

Out of scope: prompt injection carried in legitimate data (ticket titles,
names) that the server returns by design, and anything that requires changing
the catalog, the role grants or the server's configuration. See
[Limitations and non-goals](README.md#limitations-and-non-goals).
