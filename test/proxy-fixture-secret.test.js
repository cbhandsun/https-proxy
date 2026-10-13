'use strict';
const assert = require('node:assert/strict');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');
const { _decryptAesV2 } = require('../lib/proxy/secret-crypto');
const first = { HPM_MASTER_KEY_BASE64: 'inherited-key', HPM_MASTER_KEY_FILE: 'unused' };
const second = {};
const encrypted = prepareProxyFixtureSecret(first, 'synthetic-fixture');
assert.ok(encrypted.startsWith('hpm-aes-v2:'));
assert.ok(!encrypted.includes('synthetic-fixture'));
const key = Buffer.from(first.HPM_MASTER_KEY_BASE64, 'base64');
assert.equal(key.length, 32);
assert.equal(_decryptAesV2(encrypted, key), 'synthetic-fixture');
const another = prepareProxyFixtureSecret(first, 'second-fixture');
assert.equal(first.HPM_MASTER_KEY_BASE64, key.toString('base64'));
assert.equal(_decryptAesV2(another, key), 'second-fixture');
prepareProxyFixtureSecret(second, 'synthetic-fixture');
assert.notEqual(first.HPM_MASTER_KEY_BASE64, second.HPM_MASTER_KEY_BASE64);
assert.equal(first.HPM_MASTER_KEY_FILE, 'unused');
assert.equal(
  _decryptAesV2(encrypted, Buffer.from(second.HPM_MASTER_KEY_BASE64, 'base64')),
  encrypted
);
const maximum = prepareProxyFixtureSecret(first, 'x'.repeat(4096));
assert.equal(_decryptAesV2(maximum, key).length, 4096);
for (const value of [undefined, null, false, {}, [], '', 'x'.repeat(4097)])
  assert.throws(
    () => prepareProxyFixtureSecret({}, value),
    (error) => error.message === 'Invalid proxy fixture secret input'
  );
for (const environment of [undefined, null, [], 'SECRET', 1])
  assert.throws(
    () => prepareProxyFixtureSecret(environment, 'SECRET'),
    (error) => error.message === 'Invalid proxy fixture secret input'
  );
assert.throws(() => prepareProxyFixtureSecret(Object.freeze({}), 'SECRET'), TypeError);
