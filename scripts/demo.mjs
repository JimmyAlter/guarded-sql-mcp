// Reproducible demo of what an MCP client sees. Needs `npm run build` first.
//
// A real SDK Client talks to the real server (dist/) over an in-memory
// transport. The only stand-in is the database: a fake executor that answers
// with fixed rows copied from db/seed.sql and counts how often it is called,
// so the output is identical on every run and needs no PostgreSQL.
//
// Audit records are printed without `ts` and `durationMs`, which change on
// every run.
//
// `node scripts/demo.mjs --check` prints nothing but a verdict, and exits
// non-zero if the transcript in README.md no longer matches (CI runs it).
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLog } from '../dist/audit.js';
import { createServer } from '../dist/server.js';

const check = process.argv.includes('--check');
const lines = [];
function out(line) {
  lines.push(line);
  if (!check) console.log(line);
}

const FIXTURE_ROWS = [
  { full_name: 'Sam Rivera', email: 'sam.rivera@example.com', department: 'IT', site: 'north-branch' },
];

let executorCalls = 0;
const executor = {
  query: async () => {
    executorCalls += 1;
    return FIXTURE_ROWS;
  },
  close: async () => {},
};

const auditLines = [];
const server = createServer(executor, { audit: new AuditLog((line) => auditLines.push(line)) });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'demo', version: '0.0.0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
out(`tools/list -> ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

async function show(label, name, args) {
  const callsBefore = executorCalls;
  const auditBefore = auditLines.length;
  out('');
  out(`## ${label}`);
  out(`tools/call ${name} ${JSON.stringify(args)}`);
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    result = { isError: true, content: [{ type: 'text', text: `protocol error: ${err.message}` }] };
  }
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  out(`isError: ${result.isError === true}`);
  out(`text: ${text}`);
  if (result.structuredContent !== undefined) {
    out(`structuredContent equals text: ${JSON.stringify(result.structuredContent) === text}`);
  }
  out(`database reached: ${executorCalls > callsBefore ? 'yes' : 'no'}`);
  for (const line of auditLines.slice(auditBefore)) {
    const record = JSON.parse(line);
    delete record.ts;
    delete record.durationMs;
    out(`audit: ${JSON.stringify(record)}`);
  }
  if (auditLines.length === auditBefore) out('audit: (none: refused before the handler ran)');
}

await show('A normal call', 'find_people', { name_or_email: 'rivera' });
await show('Refused: unknown key `sql`', 'get_device', { hostname: 'nb-lt-001', sql: 'SELECT token_hash FROM api_tokens' });
await show('Refused: limit above the cap', 'search_devices', { limit: 1000 });
await show('Refused: injection-looking hostname', 'get_device', { hostname: "x'; DROP TABLE devices;--" });
await show('Refused: a tool that does not exist', 'run_sql', { sql: 'SELECT 1' });

await client.close();
await server.close();

if (check) {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fence = '```';
  if (readme.includes(`${fence}text\n${lines.join('\n')}\n${fence}`)) {
    console.log('README.md demo transcript matches the output of scripts/demo.mjs.');
  } else {
    console.error('README.md demo transcript is out of date: run `npm run demo` and paste its output.');
    process.exitCode = 1;
  }
}
