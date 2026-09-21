'use strict';

const assert = require('node:assert/strict');
const {
  AGENT_OPTIONS,
  createRuntimeHttpAgents,
  readUpstreamDnsConfig,
} = require('../lib/proxy/runtime/http-agents');
const { DEFAULT_DNS_SERVERS } = require('../lib/proxy/upstream-dns');

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

// 抗污染解析必须真正挂到 https agent 上，否则上游仍走系统解析。
const withDnsGuard = createRuntimeHttpAgents({
  env: {},
  loadConfig: () => ({ appSettings: { upstreamDnsServers: ['1.1.1.1'] } }),
});
assert.equal(typeof withDnsGuard.createHttpsAgent().options.lookup, 'function');
assert.deepStrictEqual(withDnsGuard.getUpstreamResolver().servers, ['1.1.1.1']);

// 同一份服务器列表应复用解析器（保留缓存），列表变化时才重建。
assert.equal(
  withDnsGuard.getUpstreamResolver(),
  (withDnsGuard.createHttpsAgent(), withDnsGuard.getUpstreamResolver())
);

// 显式空列表表示退回系统解析，agent 不应带 lookup 覆盖。
const systemResolver = createRuntimeHttpAgents({
  env: {},
  loadConfig: () => ({ appSettings: { upstreamDnsServers: [] } }),
});
assert.equal(systemResolver.createHttpsAgent().options.lookup, undefined);
assert.equal(systemResolver.getUpstreamResolver(), null);
assert.equal(
  systemResolver.createHttpsAgent().options.rejectUnauthorized,
  true,
  'DNS 关闭不应影响 TLS 校验'
);

// 未配置时启用内置受信列表。
const unsetDns = createRuntimeHttpAgents({ env: {}, loadConfig: () => ({ appSettings: {} }) });
assert.deepStrictEqual(unsetDns.getUpstreamResolver().servers, [...DEFAULT_DNS_SERVERS]);

// 失效钩子挂在 agent 上，请求路径才能丢弃被污染的缓存答案。
const invalidatableAgent = withDnsGuard.createHttpsAgent();
assert.equal(typeof invalidatableAgent.invalidateUpstreamAddress, 'function');
assert.equal(
  invalidatableAgent.invalidateUpstreamAddress('chatgpt.com', 'ERR_TLS_CERT_ALTNAME_INVALID'),
  false,
  '空缓存时返回 false，且不得抛错'
);
assert.equal(
  invalidatableAgent.invalidateUpstreamAddress('chatgpt.com', 'ECONNRESET'),
  false,
  '普通连接中断不得清空缓存'
);
assert.equal(invalidatableAgent.invalidateUpstreamAddress('', 'CERT_HAS_EXPIRED'), false);
assert.equal(invalidatableAgent.invalidateUpstreamAddress(null, 'CERT_HAS_EXPIRED'), false);

// 关闭 DNS 加固时没有缓存可清，钩子仍需安全返回 false 而不是抛错。
assert.equal(
  systemResolver.createHttpsAgent().invalidateUpstreamAddress('chatgpt.com', 'CERT_HAS_EXPIRED'),
  false
);

assert.deepStrictEqual(
  readUpstreamDnsConfig(() => ({ appSettings: {} })),
  {
    enabled: true,
    servers: undefined,
  }
);
assert.deepStrictEqual(
  readUpstreamDnsConfig(() => ({ appSettings: { upstreamDnsServers: '1.1.1.1,8.8.8.8' } })),
  { enabled: true, servers: ['1.1.1.1', '8.8.8.8'] }
);
assert.deepStrictEqual(
  readUpstreamDnsConfig(() => ({ appSettings: { upstreamDnsServers: '' } })),
  {
    enabled: false,
    servers: [],
  }
);
// 配置读取失败时保持默认开启：静默退回系统解析正是本次故障成因。
assert.deepStrictEqual(
  readUpstreamDnsConfig(() => {
    throw new Error('broken config');
  }),
  { enabled: true, servers: undefined }
);

console.log('[runtime-http-agents.test] ok');
