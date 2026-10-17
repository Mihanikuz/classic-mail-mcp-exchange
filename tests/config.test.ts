import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, accountSchema } from '../src/config.js';
function env(values: Record<string, string>, fn: () => void) {
  const keys = [
    'TRANSPORT',
    'AUTH_MODE',
    'BASE_URL',
    'STORAGE',
    'K_SERVICE',
    'APP_CONFIG_JSON',
    'APP_CONFIG_FILE',
    'ACCESS_MODE',
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, values);
    fn();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}
test('configuration defaults to read-only and rejects anonymous HTTP or mismatched stdio auth', () => {
  env({}, () => assert.equal(readConfig().accessMode, 'read-only'));
  for (const values of [
    { AUTH_MODE: 'stdio' },
    { TRANSPORT: 'stdio', AUTH_MODE: 'bearer' },
    { AUTH_MODE: 'none' },
  ]) {
    env(values, () => assert.throws(readConfig));
  }
});
test('remote origins require HTTPS and Cloud Run refuses ephemeral SQLite', () => {
  env({ AUTH_MODE: 'oauth', BASE_URL: 'http://localhost:8080' }, () => assert.throws(readConfig));
  env({ BASE_URL: 'http://remote.example.com' }, () => assert.throws(readConfig));
  env({ BASE_URL: 'https://remote.example.com/path' }, () => assert.throws(readConfig));
  env({ K_SERVICE: 'fixture' }, () => assert.throws(readConfig, /Firestore|firestore/));
  env({ K_SERVICE: 'fixture', STORAGE: 'firestore', BASE_URL: 'https://remote.example.com' }, () =>
    assert.equal(readConfig().storage, 'firestore'),
  );
});
test('provider config accepts separate login identities and rejects partial SMTP credentials', () => {
  const account = {
    id: 'test',
    email: 'owner@example.com',
    username: 'different-login',
    password: 'synthetic',
    imapHost: 'mail.example.com',
    smtpHost: 'out.example.com',
  };
  assert.equal(accountSchema.parse(account).username, 'different-login');
  assert.throws(() => accountSchema.parse({ ...account, smtpUsername: 'smtp-login' }));
  assert.throws(() => accountSchema.parse({ ...account, smtpPassword: 'synthetic' }));
  assert.equal(
    accountSchema.parse({ ...account, smtpUsername: 'smtp-login', smtpPassword: 'synthetic' })
      .smtpUsername,
    'smtp-login',
  );
});
