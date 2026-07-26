'use strict';

const http = require('node:http');
const https = require('node:https');

const AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
});

function createRuntimeHttpAgents({ loadConfig, env = process.env } = {}) {
  if (typeof loadConfig !== 'function') {
    throw new TypeError('loadConfig must be a function');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }

  const shouldVerifyUpstreamTls = () => {
    if (env.PROXY_ALLOW_UNTRUSTED_UPSTREAM === '1') return false;
    try {
      const config = loadConfig();
      return !config.appSettings || config.appSettings.verifyUpstreamTls !== false;
    } catch (_error) {
      return true;
    }
  };

  const createHttpsAgent = () =>
    new https.Agent({
      ...AGENT_OPTIONS,
      rejectUnauthorized: shouldVerifyUpstreamTls(),
    });

  return {
    createHttpsAgent,
    httpAgent: new http.Agent(AGENT_OPTIONS),
    httpsAgent: createHttpsAgent(),
    shouldVerifyUpstreamTls,
  };
}

module.exports = {
  AGENT_OPTIONS,
  createRuntimeHttpAgents,
};
