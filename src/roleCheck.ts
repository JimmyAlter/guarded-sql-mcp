/**
 * Startup diagnostic: warn when the server is connected with more privilege
 * than it needs. The code-level guards do not depend on the database role,
 * but running as a superuser or a role that can write or read secrets throws
 * away the last layer of defense, so it is worth saying so loudly in the log.
 *
 * Internal query, not a catalog entry and not exposed as a tool. It only reads
 * the system catalogs and privilege functions, so it works in the executor's
 * READ ONLY transaction.
 */
import type { Executor } from './executor.js';
import { ALLOWED_TABLES, SENSITIVE_COLUMN_PATTERN } from './policy.js';

/** Predefined roles (PostgreSQL 14+) that grant access to every table. */
const BROAD_ROLES = ['pg_read_all_data', 'pg_write_all_data'];

/** Tables, partitioned tables, views, materialized views and foreign tables. */
const RELKINDS = "c.relkind IN ('r', 'p', 'v', 'm', 'f')";

export const ROLE_CHECK_SQL = `
  SELECT r.rolname AS role_name,
         r.rolsuper AS superuser,
         r.rolbypassrls AS bypass_rls,
         ARRAY(
           SELECT g.rolname::text FROM pg_roles g
           WHERE g.rolname = ANY ($1::text[]) AND pg_has_role(r.oid, g.oid, 'MEMBER')
           ORDER BY 1
         ) AS broad_roles,
         ARRAY(
           SELECT n.nspname::text FROM pg_namespace n
           WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
             AND has_schema_privilege(r.oid, n.oid, 'CREATE')
           ORDER BY 1
         ) AS create_schemas,
         has_database_privilege(r.oid, current_database(), 'TEMPORARY') AS can_create_temp,
         ARRAY(
           SELECT c.relname::text FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND ${RELKINDS}
             AND has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
           ORDER BY 1
         ) AS writable_tables,
         ARRAY(
           SELECT c.relname::text FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND ${RELKINDS}
             AND NOT (c.relname = ANY ($2::text[]))
             AND (has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  OR has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
           ORDER BY 1
         ) AS non_allowlisted_tables,
         ARRAY(
           SELECT c.relname || '.' || a.attname FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           WHERE c.relnamespace = 'public'::regnamespace AND ${RELKINDS}
             AND a.attname ~* $3
             AND has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT')
           ORDER BY 1
         ) AS sensitive_columns
  FROM pg_roles r
  WHERE r.rolname = current_user`;

/** Bind parameters for ROLE_CHECK_SQL: broad roles, the table allowlist, the sensitive-name pattern. */
export function roleCheckParams(): unknown[] {
  return [BROAD_ROLES, [...ALLOWED_TABLES], SENSITIVE_COLUMN_PATTERN.source];
}

export async function checkConnectedRole(executor: Executor): Promise<string[]> {
  const [row] = await executor.query(ROLE_CHECK_SQL, roleCheckParams());
  if (!row) return ['could not determine the connected role'];
  const role = `'${String(row['role_name'])}'`;
  const list = (key: string): string[] => {
    const value = row[key];
    return Array.isArray(value) ? value.map(String) : [];
  };

  const warnings: string[] = [];
  if (row['superuser'] === true) {
    warnings.push(`connected as superuser ${role}; use the mcp_readonly role from db/roles.sql`);
  }
  if (row['bypass_rls'] === true) {
    warnings.push(`role ${role} has BYPASSRLS; row-level security policies do not apply to it`);
  }
  const broad = list('broad_roles');
  if (broad.length > 0) {
    warnings.push(`role ${role} is a member of ${broad.join(', ')}, which grants access to every table`);
  }
  const schemas = list('create_schemas');
  if (schemas.length > 0) {
    warnings.push(`role ${role} can CREATE objects in schema ${schemas.join(', ')}`);
  }
  if (row['can_create_temp'] === true) {
    warnings.push(`role ${role} can create temporary tables in this database`);
  }
  const writable = list('writable_tables');
  if (writable.length > 0) {
    warnings.push(`role ${role} can write to tables in schema public: ${writable.join(', ')}`);
  }
  const outside = list('non_allowlisted_tables');
  if (outside.length > 0) {
    warnings.push(`role ${role} has privileges on tables outside ALLOWED_TABLES: ${outside.join(', ')}`);
  }
  const sensitive = list('sensitive_columns');
  if (sensitive.length > 0) {
    warnings.push(`role ${role} can SELECT sensitive columns: ${sensitive.join(', ')}`);
  }
  return warnings;
}
