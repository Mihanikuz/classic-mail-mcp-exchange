import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteStore } from '../src/sqlite.js';
const config = {
  encryptionKey: 'e'.repeat(64),
  bearerToken: 'b'.repeat(64),
  accounts: [
    {
      id: 'local',
      email: 'owner@example.com',
      username: 'login-name',
      password: 'synthetic-only',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
    },
  ],
};
test('SQLite enforces atomic code consumption, rate limits and durable send deduplication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'classic-mail-storage-')),
    path = join(dir, 'state.sqlite');
  let db = new SqliteStore(path);
  try {
    await db.save('code', { value: 'fixture' }, 60);
    const takes = await Promise.all([db.take('code'), db.take('code')]);
    assert.equal(takes.filter(Boolean).length, 1);
    await db.save('expired', { value: true }, -1);
    assert.equal(await db.get('expired'), null);
    assert.equal((await db.claim('send-uuid', 'hash-a')).fresh, true);
    await db.finish('send-uuid', 'accepted', { accepted: ['recipient@example.com'] });
    await db.terminate();
    db = new SqliteStore(path);
    assert.equal((await db.claim('send-uuid', 'hash-a')).fresh, false);
    assert.equal((await db.claim('send-uuid', 'hash-a')).state, 'accepted');
    await assert.rejects(db.claim('send-uuid', 'hash-b'));
    await db.limit('owner', 'send', 1, 60);
    await assert.rejects(db.limit('owner', 'send', 1, 60));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    await db.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('real stdio process exposes only six read tools by default with clean protocol output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'classic-mail-stdio-')),
    path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server.js'],
    env: {
      PATH: process.env.PATH ?? '',
      TRANSPORT: 'stdio',
      AUTH_MODE: 'stdio',
      APP_CONFIG_FILE: path,
      SQLITE_PATH: join(dir, 'db.sqlite'),
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
    assert.ok(tools.every((t) => !t._meta?.securitySchemes));
    const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.notEqual(accounts.isError, true);
    assert.match(JSON.stringify(accounts), /owner@example.com/);
    assert.ok(!JSON.stringify(accounts).includes('synthetic-only'));
    await assert.rejects(client.callTool({ name: 'send_message', arguments: {} }));
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('real HTTP bearer authentication supports discovery and blocks wrong tokens and disabled writes', async () => {
  const port = 18860,
    dir = mkdtempSync(join(tmpdir(), 'classic-mail-http-'));
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      APP_CONFIG_JSON: JSON.stringify(config),
      SQLITE_PATH: join(dir, 'db.sqlite'),
    },
    stdio: 'ignore',
  });
  const url = 'http://127.0.0.1:' + port,
    client = new Client({ name: 'http-test', version: '1.0.0' });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(url + '/status')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert.ok(ready, 'server must start');
    for (const token of ['', 'wrong']) {
      const response = await fetch(url + '/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 401);
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + config.bearerToken } },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 6);
    assert.notEqual(
      (await client.callTool({ name: 'list_accounts', arguments: {} })).isError,
      true,
    );
    await assert.rejects(client.callTool({ name: 'send_message', arguments: {} }));
    assert.equal(
      (await fetch(url + '/mcp', { headers: { Origin: 'https://untrusted.example' } })).status,
      403,
    );
  } finally {
    await client.close();
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
