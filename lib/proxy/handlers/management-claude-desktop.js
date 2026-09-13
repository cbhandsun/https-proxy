const { CONFIG_FILE, decryptKey, encryptConfigSecretsForStorage } = require('../config');
const {
  applyClaudeDesktopConfig,
  claudeDesktopBaseUrl,
  getClaudeDesktopClientEvidence,
  getClaudeDesktopGatewayConfig,
  getClaudeDesktopInferenceModels,
  getClaudeDesktopStatus,
  PROXY_PREFIX,
  restoreClaudeDesktopConfig,
  restoreClaudeDesktopConfigBackup,
  syncClaudeDesktopMcpServers,
} = require('../claude-desktop');
const { computeClaudeDesktopDrift } = require('../tool-config-drift');

function expectedClaudeDesktopBaseUrl(
  config,
  { baseUrl = claudeDesktopBaseUrl, proxyPrefix = PROXY_PREFIX } = {}
) {
  const desktop = config && config.claudeDesktop ? config.claudeDesktop : {};
  const mode = desktop.mode || 'proxy';
  if (mode === 'proxy') return baseUrl(config) + proxyPrefix;
  if (mode === 'direct') return desktop.directBaseUrl || '';
  return '';
}

function decorateClaudeDesktopStatus(
  status,
  config,
  {
    baseUrl = claudeDesktopBaseUrl,
    proxyPrefix = PROXY_PREFIX,
    gatewayConfig = getClaudeDesktopGatewayConfig,
    inferenceModels = getClaudeDesktopInferenceModels,
    clientEvidence = getClaudeDesktopClientEvidence,
    decrypt = decryptKey,
  } = {}
) {
  const desktop = config && config.claudeDesktop ? config.claudeDesktop : {};
  const expectedBaseUrl = expectedClaudeDesktopBaseUrl(config, { baseUrl, proxyPrefix });
  const actualBaseUrl = status.actualBaseUrl || status.gatewayUrl || '';
  const gateway = gatewayConfig();
  let expectedToken = String(desktop.token || '').trim();
  if (
    expectedToken &&
    (expectedToken.startsWith('hpm-enc:') ||
      expectedToken.startsWith('hpm-dpapi:') ||
      expectedToken.startsWith('hpm-aes-v2:'))
  ) {
    expectedToken = String(decrypt(expectedToken) || expectedToken).trim();
  }
  const tokenMatchesExpected =
    !expectedToken || !gateway.isLocalProxy || !gateway.token || gateway.token === expectedToken;
  const mcpStatus = status.mcpStatus || {};
  const drift = computeClaudeDesktopDrift({
    expectedModels: typeof inferenceModels === 'function' ? inferenceModels(config) : [],
    actualModels: gateway.inferenceModels,
    expectedBaseUrl,
    actualBaseUrl,
    tokenMatchesExpected,
  });
  return {
    ...status,
    desiredMode: desktop.mode || 'proxy',
    expectedBaseUrl,
    actualBaseUrl,
    profilePath: status.profilePath || status.configPath,
    configured: status.configured === true,
    matchesExpected: drift.baseUrlMatches,
    tokenMatchesExpected,
    clientEvidence: clientEvidence(),
    // Flat fields the presentation layer reads; source of truth stays mcpStatus.
    mcpServersCount: Number.isFinite(mcpStatus.totalCount) ? mcpStatus.totalCount : 0,
    mcpServersManagedCount: Number.isFinite(mcpStatus.managedCount) ? mcpStatus.managedCount : 0,
    mcpServersCustomCount: Number.isFinite(mcpStatus.customCount) ? mcpStatus.customCount : 0,
    drift,
  };
}

function createManagementClaudeDesktopHandlers({
  sendJson,
  currentConfigSnapshot,
  configFile = CONFIG_FILE,
  decrypt = decryptKey,
  encryptConfigForStorage = encryptConfigSecretsForStorage,
  getStatus = getClaudeDesktopStatus,
  applyConfig = applyClaudeDesktopConfig,
  restoreConfig = restoreClaudeDesktopConfig,
  baseUrl = claudeDesktopBaseUrl,
  proxyPrefix = PROXY_PREFIX,
  gatewayConfig = getClaudeDesktopGatewayConfig,
  inferenceModels = getClaudeDesktopInferenceModels,
  clientEvidence = getClaudeDesktopClientEvidence,
} = {}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementClaudeDesktopHandlers requires sendJson');
  }
  if (typeof currentConfigSnapshot !== 'function') {
    throw new TypeError('createManagementClaudeDesktopHandlers requires currentConfigSnapshot');
  }

  const decorate = (status, config) =>
    decorateClaudeDesktopStatus(status, config, {
      baseUrl,
      proxyPrefix,
      gatewayConfig,
      inferenceModels,
      clientEvidence,
      decrypt,
    });

  function handleLocalClaudeDesktopStatusRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, {
        ok: true,
        ...decorate(getStatus(), currentConfigSnapshot()),
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClaudeDesktopApplyRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot();
      const result = applyConfig(config, configFile, decrypt, encryptConfigForStorage);
      sendJson(clientRes, 200, {
        ok: true,
        ...result,
        ...decorate(getStatus(), config),
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClaudeDesktopRestoreRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot();
      restoreConfig(config, configFile, encryptConfigForStorage);
      sendJson(clientRes, 200, {
        ok: true,
        ...decorate(getStatus(), config),
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClaudeDesktopSyncMcpRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot();
      const mcpStatus = syncClaudeDesktopMcpServers(config, decrypt);
      sendJson(clientRes, 200, {
        ok: true,
        mcpStatus,
        ...decorate(getStatus(), config),
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClaudeDesktopRestoreBackupRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot();
      const restored = restoreClaudeDesktopConfigBackup();
      if (!restored) {
        sendJson(clientRes, 404, { ok: false, error: '未找到 Claude Desktop 配置文件备份 (.bak)' });
        return;
      }
      sendJson(clientRes, 200, {
        ok: true,
        restored: true,
        ...decorate(getStatus(), config),
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  return {
    handleLocalClaudeDesktopStatusRequest,
    handleLocalClaudeDesktopApplyRequest,
    handleLocalClaudeDesktopRestoreRequest,
    handleLocalClaudeDesktopSyncMcpRequest,
    handleLocalClaudeDesktopRestoreBackupRequest,
  };
}

module.exports = {
  createManagementClaudeDesktopHandlers,
  decorateClaudeDesktopStatus,
  expectedClaudeDesktopBaseUrl,
};
