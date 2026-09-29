import { describe, expect, it } from 'vitest';
import type { Row } from '../../src/executor.js';
import { ALLOWED_TABLES, SENSITIVE_COLUMN_PATTERN } from '../../src/policy.js';
import { checkConnectedRole, ROLE_CHECK_SQL } from '../../src/roleCheck.js';
import { FakeExecutor } from '../helpers/fakeExecutor.js';

const clean: Row = {
  role_name: 'mcp_readonly',
  superuser: false,
  bypass_rls: false,
  broad_roles: [],
  create_schemas: [],
  can_create_temp: false,
  writable_tables: [],
  non_allowlisted_tables: [],
  sensitive_columns: [],
};

const check = (overrides: Row = {}) => checkConnectedRole(new FakeExecutor(() => [{ ...clean, ...overrides }]));

describe('checkConnectedRole', () => {
  it('reports nothing for a least-privileged role', async () => {
    expect(await check()).toEqual([]);
  });

  it('binds the broad roles, the allowlist and the sensitive pattern as parameters', async () => {
    const executor = new FakeExecutor(() => [clean]);
    await checkConnectedRole(executor);
    expect(executor.calls).toEqual([
      {
        sql: ROLE_CHECK_SQL,
        params: [['pg_read_all_data', 'pg_write_all_data'], [...ALLOWED_TABLES], SENSITIVE_COLUMN_PATTERN.source],
      },
    ]);
  });

  it.each([
    [{ superuser: true }, /superuser 'mcp_readonly'/],
    [{ bypass_rls: true }, /BYPASSRLS/],
    [{ broad_roles: ['pg_write_all_data'] }, /member of pg_write_all_data/],
    [{ broad_roles: ['pg_read_all_data'] }, /member of pg_read_all_data/],
    [{ create_schemas: ['public'] }, /CREATE objects in schema public/],
    [{ can_create_temp: true }, /temporary tables/],
    [{ writable_tables: ['sites', 'devices'] }, /can write to tables in schema public: sites, devices/],
    [{ non_allowlisted_tables: ['api_tokens'] }, /outside ALLOWED_TABLES: api_tokens/],
    [{ sensitive_columns: ['people.password_hash'] }, /SELECT sensitive columns: people\.password_hash/],
  ])('warns on %j', async (overrides, message) => {
    const warnings = await check(overrides);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(message);
  });

  it('reports every problem at once', async () => {
    const warnings = await check({ superuser: true, bypass_rls: true, sensitive_columns: ['api_tokens.token_hash'] });
    expect(warnings).toHaveLength(3);
  });

  it('warns when the role cannot be determined', async () => {
    expect(await checkConnectedRole(new FakeExecutor(() => []))).toEqual(['could not determine the connected role']);
  });
});
