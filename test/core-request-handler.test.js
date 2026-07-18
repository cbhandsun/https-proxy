const assert = require('assert');
const { createCoreRequestHandler } = require('../lib/proxy/core-request-handler');

assert.throws(() => createCoreRequestHandler(), /requires getRuntimeState/);

const handler = createCoreRequestHandler({ getRuntimeState: () => ({}) });
assert.strictEqual(typeof handler, 'function');
assert.strictEqual(handler.name, 'handleRequestInner');

console.log('[core-request-handler.test] ok');
