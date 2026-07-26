'use strict';

const assert = require('assert');
const {
  MAX_MANAGEMENT_TOKEN_BYTES,
  authorizeManagementRequest,
  managementTokenMatches,
  readManagementTokenHeader,
} = require('../lib/proxy/management-auth');

const token = '0123456789abcdef0123456789abcdef';

assert.strictEqual(authorizeManagementRequest({ headers: { 'x-mgmt-token': token } }, token), true);
assert.strictEqual(
  authorizeManagementRequest(
    { headers: { origin: 'tauri://localhost', 'x-mgmt-token': 'wrong-token' } },
    token
  ),
  false,
  'a Tauri Origin header must not bypass token authentication'
);
assert.strictEqual(
  authorizeManagementRequest(
    { headers: { origin: 'tauri://localhost' }, url: `/v1/local/config?token=${token}` },
    token
  ),
  false,
  'a URL token must not authenticate management requests'
);
assert.strictEqual(authorizeManagementRequest({ headers: {} }, token), false);
assert.strictEqual(
  authorizeManagementRequest({ headers: { 'x-mgmt-token': [token] } }, token),
  false
);
assert.strictEqual(managementTokenMatches(token, token), true);
assert.strictEqual(managementTokenMatches(token, `${token}0`), false);
assert.strictEqual(managementTokenMatches('', ''), false);
assert.strictEqual(
  readManagementTokenHeader({
    headers: { 'x-mgmt-token': 'x'.repeat(MAX_MANAGEMENT_TOKEN_BYTES + 1) },
  }),
  ''
);

console.log('[management-auth.test] ok');
