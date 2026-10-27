const fs = require('fs');

const { CONFIG_FILE } = require('../config');
const { getUsageSummary } = require('../usage');
const { contextRecoveryDiagnostics } = require('../context-recovery-diagnostics');
const { createManagementHealthHandler } = require('./management-health');

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
  proxyStopControl,
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
  recoveryDiagnostics = contextRecoveryDiagnostics,
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

  const handleLocalHealthRequest = createManagementHealthHandler({
    proxyStopControl,
    sendJson,
    appId,
    packageVersion,
    defaultPort,
    currentConfigSnapshot,
    currentEntryServersSnapshot,
    recoveryDiagnostics,
  });

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
