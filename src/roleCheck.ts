/**
 * Startup diagnostic: warn when the server is connected with more privilege
 * than it needs. The code-level guards do not depend on the database role,
 * but running as a superuser or a role that can write throws away the last
 * layer of defense, so it is worth saying so loudly in the log.
 *
 * Internal query, not a catalog entry and not exposed as a tool.
 */
import type { Executor } from './executor.js';

const ROLE_CHECK_SQL = `
  SELECT r.rolname AS role_name,
         r.rolsuper AS superuser,
         coalesce(bool_or(has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')), false) AS can_write
  FROM pg_roles r
  LEFT JOIN pg_class c ON c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
  WHERE r.rolname = current_user
  GROUP BY r.rolname, r.rolsuper`;

export async function checkConnectedRole(executor: Executor): Promise<string[]> {
  const [row] = await executor.query(ROLE_CHECK_SQL, []);
  if (!row) return ['could not determine the connected role'];
  const warnings: string[] = [];
  if (row['superuser'] === true) {
    warnings.push(`connected as superuser '${String(row['role_name'])}'; use the mcp_readonly role from db/roles.sql`);
  }
  if (row['can_write'] === true) {
    warnings.push(`role '${String(row['role_name'])}' can write to tables in schema public`);
  }
  return warnings;
}
