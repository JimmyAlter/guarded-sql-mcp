-- Least-privileged login role for the MCP server. Run as the database owner
-- after schema.sql.
--
-- This is the database layer of defense. The server's own guards (fixed
-- catalog, input validation, read-only transactions, output projection) do not
-- rely on it; this layer is what still holds if one of them is wrong.
--
-- The password below is for local development only. In any shared
-- environment, set a real one: ALTER ROLE mcp_readonly PASSWORD '...';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
        CREATE ROLE mcp_readonly LOGIN PASSWORD 'mcp_readonly_dev'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 10;
    END IF;
END
$$;

-- No object creation in this database: no schema CREATE, no temp tables.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO mcp_readonly', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO mcp_readonly;

-- Start from nothing, then grant exactly what the catalog reads.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_readonly;

GRANT SELECT ON sites, devices, software_installs, tickets TO mcp_readonly;

-- Column-level grant: password_hash and mfa_secret are not listed, so any
-- statement that touches them (including SELECT *, row_to_json(p) or a
-- whole-row reference) fails with "permission denied".
GRANT SELECT (id, full_name, email, department, site_id) ON people TO mcp_readonly;

-- api_tokens: intentionally no grant.
--
-- No ALTER DEFAULT PRIVILEGES either: tables created later are invisible to
-- this role until someone grants them on purpose.
