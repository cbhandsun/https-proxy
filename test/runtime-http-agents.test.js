'use strict';

const assert = require('node:assert/strict');
const { AGENT_OPTIONS, createRuntimeHttpAgents } = require('../lib/proxy/runtime/http-agents');

let loadCalls = 0;
const disabledVerification = createRuntimeHttpAgents({
  env: {},
  loadConfig() {
    loadCalls += 1;
    return { appSettings: { verifyUpstreamTls: false } };
  },
});
assert.equal(disabledVerification.httpsAgent.options.rejectUnauthorized, false);
assert.equal(disabledVerification.httpAgent.options.keepAlive, AGENT_OPTIONS.keepAlive);
assert.equal(loadCalls, 1);

const environmentOverride = createRuntimeHttpAgents({
  env: { PROXY_ALLOW_UNTRUSTED_UPSTREAM: '1' },
  loadConfig() {
    throw new Error('environment override should avoid config loading');
  },
});
assert.equal(environmentOverride.shouldVerifyUpstreamTls(), false);

const safeFallback = createRuntimeHttpAgents({
  env: {},
  loadConfig() {
    throw new Error('invalid config');
  },
});
assert.equal(safeFallback.shouldVerifyUpstreamTls(), true);
assert.equal(safeFallback.createHttpsAgent().options.rejectUnauthorized, true);

assert.throws(() => createRuntimeHttpAgents(), /loadConfig/);
assert.throws(() => createRuntimeHttpAgents({ loadConfig() {}, env: null }), /env/);
assert.throws(() => createRuntimeHttpAgents({ loadConfig() {}, env: [] }), /env/);

console.log('[runtime-http-agents.test] ok');
