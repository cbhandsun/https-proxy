const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeSupport, maskManagementToken } = require('../lib/proxy/runtime-support');

assert.throws(() => createRuntimeSupport(), /requires dataDir/);
assert.strictEqual(maskManagementToken('short'), '[redacted]');
assert.strictEqual(maskManagementToken('1234567890abcdef'), '123456...cdef');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-runtime-support-'));
fs.writeFileSync(path.join(dataDir, '.mgmt-token-45678'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const support = createRuntimeSupport({ dataDir });
const token = support.writeManagementTokenFile(45678);
assert.match(token, /^[0-9a-f]{32}$/);
assert.notStrictEqual(token, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
assert.strictEqual(fs.readFileSync(path.join(dataDir, '.mgmt-token-45678'), 'utf8'), token);
assert.strictEqual(support.readExistingManagementToken(45678), token);
assert.strictEqual(support.writeManagementTokenFile(45678), token);

const deniedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-runtime-support-denied-'));
const deniedSupport = createRuntimeSupport({
  dataDir: deniedDir,
  secureDirectory() {
    throw new Error('ACL denied');
  },
});
assert.throws(() => deniedSupport.writeManagementTokenFile(45679), /ACL denied/);
assert.strictEqual(fs.existsSync(path.join(deniedDir, '.mgmt-token-45679')), false);

const unreadableTokenPath = path.join(deniedDir, '.mgmt-token');
fs.writeFileSync(unreadableTokenPath, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const unreadableSupport = createRuntimeSupport({
  dataDir: deniedDir,
  secureFile() {
    throw new Error('Token ACL is unsafe');
  },
});
assert.throws(() => unreadableSupport.readExistingManagementToken(45680), /Token ACL is unsafe/);

console.log('[runtime-support.test] ok');
