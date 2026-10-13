'use strict';
const { randomBytes } = require('node:crypto');
const { _encryptAesV2 } = require('../../lib/proxy/secret-crypto');
const keys = new WeakMap();

// Protocol fixtures exercise a supported persisted-secret format, with a fresh
// key for each isolated environment. Plaintext migration and DPAPI remain
// covered by secret-crypto tests rather than every protocol child startup.
function prepareProxyFixtureSecret(environment, value) {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 4096
  )
    throw new TypeError('Invalid proxy fixture secret input');
  let key = keys.get(environment);
  if (!key) {
    key = randomBytes(32);
    keys.set(environment, key);
  }
  environment.HPM_MASTER_KEY_BASE64 = key.toString('base64');
  return _encryptAesV2(value, key);
}

module.exports = { prepareProxyFixtureSecret };
