// Starts the built server over stdio, as an MCP client would, and checks that
// tools/list returns exactly the catalog. Needs `npm run build` first. The
// server does not connect to the database until a tool is called, so a
// placeholder DATABASE_URL is enough for this check.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CATALOG } from '../dist/catalog.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...getDefaultEnvironment(),
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://mcp_readonly:unused@127.0.0.1:1/unused',
  },
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (chunk) => (serverLog += chunk));

const client = new Client({ name: 'smoke-stdio', version: '0.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const got = tools.map((t) => t.name).sort();
  const want = CATALOG.map((q) => q.name).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`tools/list mismatch:\n  got  ${got.join(', ')}\n  want ${want.join(', ')}`);
  }
  console.log(`server: ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`);
  console.log(`tools/list returned ${got.length} tools: ${got.join(', ')}`);
} catch (err) {
  console.error(`smoke test failed: ${err instanceof Error ? err.message : err}`);
  if (serverLog) console.error(`server stderr:\n${serverLog}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
