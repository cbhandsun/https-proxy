const fs = require('fs');

const { CONFIG_DIR, CONFIG_FILE, DATA_DIR } = require('../config');
const { parsePortOrDefault } = require('../management-utils');
const { getUsageSummary } = require('../usage');

const {
  handleLocalPromptsSyncRequest,
  handleLocalPromptsPresetsRequest,
} = require('../prompts-sync');

function readRawConfigSnapshot(configFile, currentConfigSnapshot) {
  if (fs.existsSync(configFile)) {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  }
  return JSON.parse(JSON.stringify(currentConfigSnapshot() || {}));
}

function createManagementCoreHandlers({
  sendJson,
  metricsInstance,
  appId,
  packageVersion,
  defaultPort,
  currentConfigSnapshot,
  currentEntryServersSnapshot,
  writeConfigFileAtomically,
  reloadProxyConfig,
  configFile = CONFIG_FILE,
  usageSummary = getUsageSummary,
}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementCoreHandlers requires sendJson');
  }
  if (typeof currentConfigSnapshot !== 'function') {
    throw new TypeError('createManagementCoreHandlers requires currentConfigSnapshot');
  }
  if (typeof currentEntryServersSnapshot !== 'function') {
    throw new TypeError('createManagementCoreHandlers requires currentEntryServersSnapshot');
  }
  if (typeof writeConfigFileAtomically !== 'function') {
    throw new TypeError('createManagementCoreHandlers requires writeConfigFileAtomically');
  }
  if (typeof reloadProxyConfig !== 'function') {
    throw new TypeError('createManagementCoreHandlers requires reloadProxyConfig');
  }

  function handleLocalMetricsRequest(clientReq, clientRes) {
    try {
      const text =
        metricsInstance && typeof metricsInstance.render === 'function'
          ? metricsInstance.render()
          : '';
      clientRes.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'access-control-allow-origin': '*',
        'Cache-Control': 'no-store',
      });
      clientRes.end(text);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalHealthRequest(clientReq, clientRes) {
    const config = currentConfigSnapshot() || {};
    const entryServers = currentEntryServersSnapshot();
    sendJson(clientRes, 200, {
      ok: true,
      appId,
      version: packageVersion,
      status: 'running',
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      runtime: {
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
  }

  function readRawConfig() {
    return readRawConfigSnapshot(configFile, currentConfigSnapshot);
  }

  function writeRawConfigSnapshot(nextConfig) {
    writeConfigFileAtomically(nextConfig);
    reloadProxyConfig();
  }

  async function handleLocalUsageSummaryRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, { ok: true, summary: await usageSummary() });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalPromptsPresetsGetRequest(clientReq, clientRes) {
    handleLocalPromptsPresetsRequest(
      clientReq,
      clientRes,
      currentConfigSnapshot() || {},
      writeRawConfigSnapshot
    );
  }

  function handleLocalPromptsPresetsSaveRequest(clientReq, clientRes) {
    handleLocalPromptsPresetsRequest(clientReq, clientRes, readRawConfig(), writeRawConfigSnapshot);
  }

  function handleLocalPromptsPresetsApplyRequest(clientReq, clientRes) {
    handleLocalPromptsPresetsRequest(
      clientReq,
      clientRes,
      currentConfigSnapshot() || {},
      writeRawConfigSnapshot
    );
  }

  return {
    handleLocalMetricsRequest,
    handleLocalHealthRequest,
    handleLocalUsageSummaryRequest,
    handleLocalPromptsSyncRequest,
    handleLocalPromptsPresetsGetRequest,
    handleLocalPromptsPresetsSaveRequest,
    handleLocalPromptsPresetsApplyRequest,
    readRawConfigSnapshot: readRawConfig,
    writeRawConfigSnapshot,
  };
}

module.exports = {
  createManagementCoreHandlers,
  readRawConfigSnapshot,
};
