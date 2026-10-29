'use strict';

// These handlers keep the existing core authorization and response contracts.
// Reading health/configuration or stopping must not construct CLI launchers,
// configuration writers, MCP execution and other management feature families.
function createManagementBootstrapHandlers(deps) {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps))
    throw new TypeError('Invalid management bootstrap dependencies');
  const { createManagementHealthHandler } = require('./management-health');
  const { createManagementConfigReadHandler } = require('./management-config-read');
  function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(data));
  }
  return {
    health: createManagementHealthHandler({
      proxyStopControl: deps.proxyStopControl,
      appId: deps.APP_ID,
      packageVersion: deps.PACKAGE_VERSION,
      defaultPort: deps.PORT,
      currentConfigSnapshot: () =>
        typeof deps.CONFIG === 'function' ? deps.CONFIG() : deps.CONFIG,
      currentEntryServersSnapshot: () => {
        const entries =
          typeof deps.ENTRY_SERVERS === 'function' ? deps.ENTRY_SERVERS() : deps.ENTRY_SERVERS;
        return Array.isArray(entries) ? entries : [];
      },
      sendJson,
    }),
    getConfig: createManagementConfigReadHandler({ sendJson }),
    proxyStop: deps.proxyStopControl
      ? deps.proxyStopControl.handle
      : (_req, res) => sendJson(res, 503, { error: 'proxy_stop_unavailable' }),
  };
}

module.exports = { createManagementBootstrapHandlers };
