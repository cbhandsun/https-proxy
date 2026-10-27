'use strict';

const path = require('node:path');
const { CONFIG_DIR, DATA_DIR } = require('../config');
const { parsePortOrDefault } = require('../management-utils');
const { getActiveTianxiNativeTasks } = require('../tianxi-live-result-wait');
const { contextRecoveryDiagnostics } = require('../context-recovery-diagnostics');

// The same response implementation is used before and after the full
// management aggregate is loaded. Authentication remains in the core router.
function createManagementHealthHandler({
  proxyStopControl,
  sendJson,
  appId,
  packageVersion,
  defaultPort,
  currentConfigSnapshot,
  currentEntryServersSnapshot,
  recoveryDiagnostics = contextRecoveryDiagnostics,
}) {
  if (typeof sendJson !== 'function')
    throw new TypeError('createManagementHealthHandler requires sendJson');
  if (typeof currentConfigSnapshot !== 'function')
    throw new TypeError('createManagementHealthHandler requires currentConfigSnapshot');
  if (typeof currentEntryServersSnapshot !== 'function')
    throw new TypeError('createManagementHealthHandler requires currentEntryServersSnapshot');

  return function handleLocalHealthRequest(clientReq, clientRes) {
    const config = currentConfigSnapshot() || {};
    const entryServers = currentEntryServersSnapshot();
    sendJson(clientRes, 200, {
      ok: true,
      appId,
      version: packageVersion,
      status: 'running',
      pid: process.pid,
      ...(proxyStopControl ? { shutdown: proxyStopControl.identity } : {}),
      uptimeSec: Math.round(process.uptime()),
      tianxi: { activeNativeTasks: getActiveTianxiNativeTasks() },
      contextRecovery: recoveryDiagnostics.inspect(config),
      runtime: {
        contextRecoveryDirectory: path.join(DATA_DIR, 'context-recovery-v1'),
        entrypoint: process.argv[1] || '',
        cwd: process.cwd(),
        configDir: CONFIG_DIR,
        runtimeDir: DATA_DIR,
      },
      ports: {
        management: parsePortOrDefault(
          process.env.MGMT_PORT ||
            (config.localServer && config.localServer.managementPort) ||
            defaultPort + 100,
          defaultPort + 100
        ),
        entries: (Array.isArray(entryServers) ? entryServers : []).map((entry) => ({
          protocol: entry.protocol,
          host: entry.host,
          listenPort: entry.listenPort,
          basePath: entry.basePath,
          tls: entry.tls !== false,
        })),
      },
    });
  };
}

module.exports = { createManagementHealthHandler };
