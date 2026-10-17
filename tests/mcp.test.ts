import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerTools } from '../src/tools.js';
import type { Session } from '../src/auth.js';

test('MCP SDK client discovers full toolset, calls a read tool and rejects malformed sends', async () => {
  const server = new FastMCP<Session>({
    name: 'synthetic-test',
    version: '1.0.0',
    authenticate: async (req) =>
      req.headers.authorization === 'Bearer synthetic-test-only'
        ? { sub: 'test', email: 'owner@example.com' }
        : undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
  });
  registerTools(server, {
    listAccounts: () => [{ id: 'test', email: 'test@example.com', allowedFolders: ['INBOX'] }],
  } as any);
  const client = new Client({ name: 'synthetic-client', version: '1.0.0' });
  try {
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        host: '127.0.0.1',
        port: 18920,
        endpoint: '/mcp',
        stateless: true,
        enableJsonResponse: true,
        cors: false,
      },
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18920/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-test-only' } },
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 21);
    assert.equal(tools.filter((t) => t.annotations?.readOnlyHint).length, 6);
    assert.ok(tools.find((t) => t.name === 'send_message')?.annotations?.destructiveHint);
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), /test@example.com/);
    await assert.rejects(client.callTool({ name: 'send_message', arguments: {} }));
  } finally {
    await client.close();
    await server.stop();
  }
});
