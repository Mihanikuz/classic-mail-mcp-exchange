import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const dir = mkdtempSync(join(tmpdir(), 'classic-mail-docker-')),
  file = join(dir, 'config.json'),
  data = join(dir, 'data');
mkdirSync(data, { mode: 0o700 });
const token = randomBytes(48).toString('base64url');
writeFileSync(
  file,
  JSON.stringify({
    encryptionKey: randomBytes(48).toString('base64url'),
    bearerToken: token,
    accounts: [
      {
        id: 'fixture',
        email: 'fixture@example.com',
        username: 'fixture',
        password: 'synthetic-only',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      },
    ],
  }),
  { mode: 0o600 },
);
const image = process.env.SMOKE_IMAGE ?? 'classic-mail-mcp:local',
  name = 'classic-mail-smoke-' + randomUUID();
const user =
  typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
const common = [
  '--init',
  '--user',
  user,
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--mount',
  `type=bind,src=${file},dst=/run/secrets/config.json,readonly`,
  '--mount',
  `type=bind,src=${data},dst=/data`,
  '-e',
  'APP_CONFIG_FILE=/run/secrets/config.json',
];
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let client;
try {
  assert.equal(docker(['image', 'inspect', image, '--format', '{{.Config.User}}']), 'node');
  client = new Client({ name: 'docker-stdio-smoke', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        ...common,
        '-e',
        'TRANSPORT=stdio',
        '-e',
        'AUTH_MODE=stdio',
        image,
      ],
      stderr: 'pipe',
    }),
  );
  assert.equal((await client.listTools()).tools.length, 6);
  assert.notEqual((await client.callTool({ name: 'list_accounts', arguments: {} })).isError, true);
  await client.close();
  client = undefined;
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    ...common,
    '-p',
    '127.0.0.1::8080',
    '-e',
    'AUTH_MODE=bearer',
    '-e',
    'ACCESS_MODE=read-write',
    image,
  ]);
  const mapped = docker(['port', name, '8080/tcp']),
    url = 'http://' + mapped;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url + '/status')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  assert.ok(ready, 'Docker HTTP server must start');
  assert.equal(
    (
      await fetch(url + '/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
        body: '{}',
      })
    ).status,
    401,
  );
  client = new Client({ name: 'docker-http-smoke', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 21);
  const result = await client.callTool({ name: 'list_accounts', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result), /fixture@example.com/);
  console.log(
    'Docker smoke passed: non-root image, hardened stdio (6 tools), authenticated HTTP (21 tools), account listing and invalid-token rejection.',
  );
} finally {
  await client?.close();
  try {
    docker(['rm', '-f', name]);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}
