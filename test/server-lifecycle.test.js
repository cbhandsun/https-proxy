const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startProxyServers } = require('../lib/proxy/server-lifecycle');

assert.throws(() => startProxyServers(), /requires getRuntimeState/);
const source = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'proxy', 'server-lifecycle.js'),
  'utf8'
);
assert.ok(!source.includes('mgmt_token_hint'), 'startup logs must not expose token fragments');
assert.ok(!source.includes('openai.api_key'), 'startup logs must not print fake or real API keys');

console.log('[server-lifecycle.test] ok');
