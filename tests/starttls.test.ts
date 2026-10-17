import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { accountSchema } from '../src/config.js';
import { imapOptions, smtpOptions } from '../src/mail.js';
const account = accountSchema.parse({
  id: 'test',
  email: 'owner@example.com',
  username: 'login',
  password: 'synthetic-only',
  imapHost: 'localhost',
  imapPort: 143,
  smtpHost: 'localhost',
  smtpPort: 587,
});
test('real IMAP and SMTP clients refuse servers without STARTTLS before sending credentials', async () => {
  for (const kind of ['imap', 'smtp']) {
    const commands: string[] = [],
      sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.write(
        kind === 'imap' ? '* OK [CAPABILITY IMAP4rev1] fixture\r\n' : '220 fixture ESMTP\r\n',
      );
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk;
        let i;
        while ((i = pending.indexOf('\r\n')) >= 0) {
          const line = pending.slice(0, i);
          pending = pending.slice(i + 2);
          const verb = kind === 'imap' ? line.split(' ')[1] : line.split(' ')[0];
          commands.push(verb);
          if (kind === 'imap') {
            const tag = line.split(' ')[0];
            if (verb === 'CAPABILITY')
              socket.write('* CAPABILITY IMAP4rev1\r\n' + tag + ' OK done\r\n');
            else socket.write(tag + ' BAD TLS unavailable\r\n');
          } else if (verb === 'EHLO') socket.write('250-fixture\r\n250 AUTH PLAIN LOGIN\r\n');
          else socket.write('454 TLS unavailable\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error();
    try {
      if (kind === 'imap') {
        const client = new ImapFlow({
          ...imapOptions(account),
          host: '127.0.0.1',
          port: address.port,
        });
        client.on('error', () => {});
        try {
          await assert.rejects(client.connect());
        } finally {
          client.close();
        }
      } else {
        const client = nodemailer.createTransport({
          ...smtpOptions(account),
          host: '127.0.0.1',
          port: address.port,
        });
        try {
          await assert.rejects(client.verify());
        } finally {
          client.close();
        }
      }
      assert.ok(
        !commands.some((c) => ['LOGIN', 'AUTHENTICATE', 'AUTH'].includes(c)),
        'No credentials before verified TLS',
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
