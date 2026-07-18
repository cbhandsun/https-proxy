const assert = require('assert');
const { startProxyServers } = require('../lib/proxy/server-lifecycle');

assert.throws(() => startProxyServers(), /requires getRuntimeState/);

console.log('[server-lifecycle.test] ok');
