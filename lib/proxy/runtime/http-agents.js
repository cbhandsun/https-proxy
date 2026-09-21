'use strict';

const http = require('node:http');
const https = require('node:https');
const {
  createUpstreamResolver,
  parseDnsServerList,
  isUntrustworthyAddressError,
} = require('../upstream-dns');

const AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
});

/**
 * 读取抗污染 DNS 配置。
 *
 * 默认开启（appSettings.upstreamDnsServers 未设置时使用内置受信列表），显式配置空
 * 数组或空字符串表示退回系统解析。配置损坏时保持默认开启，因为静默退回系统解析
 * 正是本次 502 的成因。
 */
function readUpstreamDnsConfig(loadConfig) {
  let config;
  try {
    config = loadConfig();
  } catch (_error) {
    config = null;
  }
  return upstreamDnsConfigFromConfig(config);
}

function upstreamDnsConfigFromConfig(config) {
  const settings = config && config.appSettings ? config.appSettings : null;
  const raw = settings ? settings.upstreamDnsServers : undefined;
  const disabled = raw == null ? false : (Array.isArray(raw) ? raw : String(raw)).length === 0;
  if (disabled) return { enabled: false, servers: [] };
  const { servers } = parseDnsServerList(raw == null ? undefined : raw);
  if (servers.length === 0) return { enabled: true, servers: undefined };
  return { enabled: true, servers };
}

function createRuntimeHttpAgents({ loadConfig, env = process.env, logger = null } = {}) {
  if (typeof loadConfig !== 'function') {
    throw new TypeError('loadConfig must be a function');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }

  // 解析器按服务器列表复用，保留 DNS 缓存；列表没变就不重建。
  let resolverKey = null;
  let resolverInstance = null;

  function resolveUpstreamResolver(dnsConfig) {
    if (!dnsConfig.enabled) return null;
    const key = (dnsConfig.servers || []).join(',');
    if (resolverInstance && resolverKey === key) return resolverInstance;
    resolverInstance = createUpstreamResolver({ servers: dnsConfig.servers, logger });
    resolverKey = key;
    return resolverInstance;
  }

  // 最近一次成功读取的配置；环境变量覆盖跳过读取时用它保持 DNS 策略不抖动。
  let lastKnownConfig = null;

  // TLS 校验与 DNS 策略来自同一次配置读取，避免同一次建连出现两套配置视图。
  function readConnectionPolicy() {
    if (env.PROXY_ALLOW_UNTRUSTED_UPSTREAM === '1') {
      return {
        rejectUnauthorized: false,
        dnsConfig: upstreamDnsConfigFromConfig(lastKnownConfig),
      };
    }
    let config;
    try {
      config = loadConfig();
      if (config) lastKnownConfig = config;
    } catch (_error) {
      config = null;
    }
    return {
      rejectUnauthorized:
        !config || !config.appSettings || config.appSettings.verifyUpstreamTls !== false,
      dnsConfig: upstreamDnsConfigFromConfig(config || lastKnownConfig),
    };
  }

  const shouldVerifyUpstreamTls = () => readConnectionPolicy().rejectUnauthorized;

  const createHttpsAgent = () => {
    const policy = readConnectionPolicy();
    const resolver = resolveUpstreamResolver(policy.dnsConfig);
    const agent = new https.Agent({
      ...AGENT_OPTIONS,
      rejectUnauthorized: policy.rejectUnauthorized,
      ...(resolver ? { lookup: resolver.lookup } : {}),
    });
    /**
     * 证书不匹配/连不上这类失败说明"解析到的机器不是目标机器"，最可能是该域名的
     * DNS 答案不可信。把失效动作挂在 agent 上，请求路径只需拿到 agent 即可丢弃
     * 该域名的缓存答案，无需额外接线；普通连接断开不触发。
     */
    agent.invalidateUpstreamAddress = (hostname, errorCode) => {
      if (!isUntrustworthyAddressError(errorCode)) return false;
      if (!resolver || typeof resolver.invalidate !== 'function') return false;
      if (typeof hostname !== 'string' || !hostname.trim()) return false;
      try {
        return resolver.invalidate(hostname);
      } catch (_error) {
        return false;
      }
    };
    return agent;
  };

  return {
    createHttpsAgent,
    httpAgent: new http.Agent(AGENT_OPTIONS),
    httpsAgent: createHttpsAgent(),
    getUpstreamResolver: () => resolverInstance,
    shouldVerifyUpstreamTls,
  };
}

module.exports = {
  AGENT_OPTIONS,
  createRuntimeHttpAgents,
  readUpstreamDnsConfig,
  upstreamDnsConfigFromConfig,
};
