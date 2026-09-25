-- Fictional IT asset inventory. Run as the database owner.
-- Order: schema.sql, roles.sql, seed.sql.

CREATE TYPE device_status AS ENUM ('online', 'offline', 'retired');
CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'closed');

CREATE TABLE sites (
    id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code    text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,32}$'),
    name    text NOT NULL,
    city    text NOT NULL
);

CREATE TABLE people (
    id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name      text NOT NULL,
    email          text NOT NULL UNIQUE,
    department     text NOT NULL,
    site_id        integer NOT NULL REFERENCES sites (id),
    -- Sensitive: never granted to mcp_readonly, never selectable by the catalog.
    password_hash  text NOT NULL,
    mfa_secret     text
);

CREATE TABLE devices (
    id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hostname            text NOT NULL CHECK (hostname ~ '^[A-Za-z0-9-]{1,63}$'),
    site_id             integer NOT NULL REFERENCES sites (id),
    os                  text NOT NULL,
    status              device_status NOT NULL DEFAULT 'online',
    last_seen_at        timestamptz,
    assigned_person_id  integer REFERENCES people (id),
    ip                  inet
);
CREATE UNIQUE INDEX devices_hostname_lower_idx ON devices (lower(hostname));
CREATE INDEX devices_site_id_idx ON devices (site_id);

CREATE TABLE software_installs (
    id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id     integer NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    name          text NOT NULL,
    version       text NOT NULL,
    installed_at  timestamptz NOT NULL
);
CREATE INDEX software_installs_device_id_idx ON software_installs (device_id);

CREATE TABLE tickets (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id    integer NOT NULL REFERENCES sites (id),
    device_id  integer REFERENCES devices (id),
    title      text NOT NULL,
    priority   ticket_priority NOT NULL DEFAULT 'medium',
    status     ticket_status NOT NULL DEFAULT 'open',
    opened_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_site_status_idx ON tickets (site_id, status);

-- Deliberately outside the allowlist and without any grant to mcp_readonly.
CREATE TABLE api_tokens (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id   integer NOT NULL REFERENCES people (id),
    token_hash  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
