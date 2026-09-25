-- Fictional seed data. Names, sites, addresses and secrets are made up.
-- Timestamps are relative to now() so time-based queries stay meaningful.
-- Run as the database owner after roles.sql.

INSERT INTO sites (code, name, city) VALUES
    ('north-branch',   'North Branch',   'Northfield'),
    ('central-office', 'Central Office', 'Centerville'),
    ('east-warehouse', 'East Warehouse', 'Eastport');

-- password_hash and mfa_secret hold obviously fake values. They exist so the
-- tests can prove that they never leave the database through the server.
INSERT INTO people (full_name, email, department, site_id, password_hash, mfa_secret)
SELECT p.full_name, p.email, p.department, s.id, p.password_hash, p.mfa_secret
FROM (VALUES
    ('Sam Rivera',   'sam.rivera@example.com',   'IT',         'north-branch',   '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTAx', 'SEED-ONLY-MFA-01'),
    ('Jordan Lee',   'jordan.lee@example.com',   'Finance',    'central-office', '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTAy', 'SEED-ONLY-MFA-02'),
    ('Taylor Kim',   'taylor.kim@example.com',   'Operations', 'east-warehouse', '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTAz', NULL),
    ('Casey Nguyen', 'casey.nguyen@example.com', 'IT',         'central-office', '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTA0', 'SEED-ONLY-MFA-04'),
    ('Morgan Silva', 'morgan.silva@example.com', 'Sales',      'north-branch',   '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTA1', NULL),
    ('Riley Costa',  'riley.costa@example.com',  'Logistics',  'east-warehouse', '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTA2', 'SEED-ONLY-MFA-06'),
    ('Jamie Park',   'jamie.park@example.com',   'HR',         'central-office', '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTA3', NULL),
    ('Avery Santos', 'avery.santos@example.com', 'Sales',      'north-branch',   '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTA4', 'SEED-ONLY-MFA-08'),
    ('Drew O''Neil', 'drew.oneil@example.com',   'Facilities', 'central-office', '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1vbmx5$ZmFrZS1oYXNoLTA5', NULL)
) AS p (full_name, email, department, site_code, password_hash, mfa_secret)
JOIN sites s ON s.code = p.site_code;

INSERT INTO devices (hostname, site_id, os, status, last_seen_at, assigned_person_id, ip)
SELECT d.hostname, s.id, d.os, d.status::device_status, now() - d.last_seen_ago, pe.id, d.ip::inet
FROM (VALUES
    ('nb-lt-001',  'north-branch',   'Windows 11 Pro',        'online',  interval '2 hours',    'sam.rivera@example.com',   '10.10.1.21'),
    ('nb-lt-002',  'north-branch',   'Windows 11 Pro',        'offline', interval '45 days',    'morgan.silva@example.com', '10.10.1.22'),
    ('nb-ws-001',  'north-branch',   'Ubuntu 24.04 LTS',      'online',  interval '10 minutes', 'avery.santos@example.com', '10.10.1.30'),
    ('nb-lt-003',  'north-branch',   'macOS 15',              'retired', interval '400 days',   NULL,                       NULL),
    ('co-ws-001',  'central-office', 'Windows 11 Enterprise', 'online',  interval '1 hour',     'jordan.lee@example.com',   '10.20.1.11'),
    ('co-ws-002',  'central-office', 'Windows 10 Enterprise', 'offline', interval '90 days',    'jamie.park@example.com',   '10.20.1.12'),
    ('co-srv-001', 'central-office', 'Ubuntu 22.04 LTS',      'online',  interval '1 minute',   'casey.nguyen@example.com', '10.20.0.5'),
    ('co-srv-002', 'central-office', 'Windows Server 2022',   'online',  interval '3 minutes',  'casey.nguyen@example.com', '10.20.0.6'),
    ('co-lt-001',  'central-office', 'macOS 15',              'online',  interval '5 hours',    'drew.oneil@example.com',   '10.20.1.40'),
    ('ew-hh-001',  'east-warehouse', 'Android 14',            'online',  interval '30 minutes', 'riley.costa@example.com',  '10.30.2.10'),
    ('ew-hh-002',  'east-warehouse', 'Android 14',            'offline', NULL,                  NULL,                       NULL),
    ('ew-ws-001',  'east-warehouse', 'Windows 11 Pro',        'online',  interval '40 days',    'taylor.kim@example.com',   '10.30.1.15')
) AS d (hostname, site_code, os, status, last_seen_ago, person_email, ip)
JOIN sites s ON s.code = d.site_code
LEFT JOIN people pe ON pe.email = d.person_email;

INSERT INTO software_installs (device_id, name, version, installed_at)
SELECT dv.id, sw.name, sw.version, now() - sw.installed_ago
FROM (VALUES
    ('nb-lt-001',  'Google Chrome',       '128.0.6613.120', interval '20 days'),
    ('nb-lt-001',  'Microsoft Teams',     '24215.1007.3082', interval '60 days'),
    ('nb-lt-001',  '7-Zip',               '24.08',          interval '120 days'),
    ('nb-lt-002',  'Google Chrome',       '126.0.6478.127', interval '95 days'),
    ('nb-ws-001',  'Mozilla Firefox',     '130.0',          interval '15 days'),
    ('nb-ws-001',  'Python',              '3.12.5',         interval '40 days'),
    ('co-ws-001',  'Google Chrome',       '128.0.6613.120', interval '18 days'),
    ('co-ws-001',  'LibreOffice',         '24.8.0',         interval '30 days'),
    ('co-ws-002',  'Internet Explorer 11', '11.0.19041',    interval '900 days'),
    ('co-srv-001', 'nginx',               '1.26.2',         interval '75 days'),
    ('co-srv-001', 'OpenSSH Server',      '8.9p1',          interval '300 days'),
    ('co-srv-002', 'Microsoft SQL Server Express', '16.0.1000.6', interval '200 days'),
    ('co-lt-001',  'VLC media player',    '3.0.21',         interval '50 days'),
    ('ew-hh-001',  'Inventory Scanner',   '4.2.0',          interval '10 days'),
    ('ew-ws-001',  'Mozilla Firefox',     '128.2.0esr',     interval '45 days')
) AS sw (hostname, name, version, installed_ago)
JOIN devices dv ON dv.hostname = sw.hostname;

INSERT INTO tickets (site_id, device_id, title, priority, status, opened_at)
SELECT s.id, dv.id, t.title, t.priority::ticket_priority, t.status::ticket_status, now() - t.opened_ago
FROM (VALUES
    ('north-branch',   'nb-lt-002',  'Laptop has not checked in for over a month',  'high',     'open',        interval '3 days'),
    ('central-office', 'co-ws-002',  'Replace Windows 10 workstation',              'critical', 'in_progress', interval '10 days'),
    ('central-office', 'co-srv-001', 'Disk usage above 85 percent on /var',         'medium',   'open',        interval '1 day'),
    ('east-warehouse', 'ew-hh-002',  'Handheld scanner was never enrolled',         'low',      'open',        interval '7 days'),
    ('north-branch',   NULL,         'Replace printer toner on second floor',       'low',      'closed',      interval '20 days'),
    ('east-warehouse', 'ew-ws-001',  'Workstation offline since last month',        'high',     'open',        interval '2 days')
) AS t (site_code, hostname, title, priority, status, opened_ago)
JOIN sites s ON s.code = t.site_code
LEFT JOIN devices dv ON dv.hostname = t.hostname;

INSERT INTO api_tokens (person_id, token_hash)
SELECT pe.id, t.token_hash
FROM (VALUES
    ('sam.rivera@example.com',   'seed-only-token-hash-0001'),
    ('casey.nguyen@example.com', 'seed-only-token-hash-0002')
) AS t (email, token_hash)
JOIN people pe ON pe.email = t.email;
