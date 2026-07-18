const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRuntimeSupport,
  isTauriManagementOrigin,
  maskManagementToken,
} = require('../lib/proxy/runtime-support');

assert.throws(() => createRuntimeSupport(), /requires dataDir/);
assert.strictEqual(maskManagementToken('short'), '[redacted]');
assert.strictEqual(maskManagementToken('1234567890abcdef'), '123456...cdef');
assert.strictEqual(isTauriManagementOrigin({ headers: { origin: 'tauri://localhost' } }), true);
assert.strictEqual(isTauriManagementOrigin({ headers: { origin: 'https://example.test' } }), false);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-runtime-support-'));
const support = createRuntimeSupport({ dataDir });
const token = support.writeManagementTokenFile(45678);
assert.match(token, /^[0-9a-f]{32}$/);
assert.strictEqual(fs.readFileSync(path.join(dataDir, '.mgmt-token-45678'), 'utf8'), token);
assert.strictEqual(support.readExistingManagementToken(45678), token);

console.log('[runtime-support.test] ok');
