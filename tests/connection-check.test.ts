import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFailure } from '../src/connection-check.js';

test('connection diagnostics never expose provider errors or credentials', () => {
  assert.equal(
    safeFailure({ code: 'EAUTH', message: 'synthetic-secret' }),
    'authentication_rejected',
  );
  assert.equal(safeFailure({ authenticationFailed: true }), 'authentication_rejected');
  assert.equal(safeFailure({ responseCode: 535 }), 'authentication_rejected');
  assert.equal(safeFailure({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(safeFailure({ code: 'ENOTFOUND' }), 'dns_error');
  assert.equal(safeFailure({ code: 'ECONNRESET' }), 'connection_error');
  assert.equal(safeFailure({ code: 'CERT_HAS_EXPIRED' }), 'certificate_error');
  for (const error of [null, undefined, 'synthetic-secret', { message: 'synthetic-secret' }])
    assert.equal(safeFailure(error), 'check_failed');
});
