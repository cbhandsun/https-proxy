const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCoreRequestHandler } = require('../lib/proxy/core-request-handler');

assert.throws(() => createCoreRequestHandler(), /requires getRuntimeState/);

const handler = createCoreRequestHandler({ getRuntimeState: () => ({}) });
assert.strictEqual(typeof handler, 'function');
assert.strictEqual(handler.name, 'handleRequestInner');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'proxy', 'core-request-handler.js'),
  'utf8'
);
assert.ok(source.includes('authorizeManagementRequest(clientReq, MANAGEMENT_TOKEN)'));
assert.ok(!source.includes('isTauriManagementOrigin'));
assert.ok(!source.includes("searchParams.get('token')"));

console.log('[core-request-handler.test] ok');
