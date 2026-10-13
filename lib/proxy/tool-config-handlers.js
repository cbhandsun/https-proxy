const {
  getAntigravityCliStatus,
  applyAntigravityCliProxy,
  restoreAntigravityCliProxy,
  getClaudeCodeStatus,
  applyClaudeCodeProxy,
  restoreClaudeCodeProxy,
  getCodexStatus,
  getCodexDesktopStatus,
  applyCodexApiLogin,
  backupCurrentCodexAuth,
  launchCodexOfficialLogin,
  applyCodexProxy,
  restoreCodexProxy,
  switchCodexMode,
  getGeminiCliStatus,
  applyGeminiCliProxy,
  restoreGeminiCliProxy,
} = require('./tool-configs');
const { loadConfig, getModelRoutes } = require('./config');
const { readJsonBodyFromRequest } = require('./management-utils');
const { localModelRoutesForClientProtocol } = require('./models');

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify(payload));
}

function createStatusHandler(readStatus) {
  return function handleToolStatusRequest(clientReq, clientRes) {
    try {
      const status = readStatus();
      sendJson(clientRes, 200, { ok: true, ...status });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  };
}

// Status endpoints read the live config here so the handler factory stays a
// composition root and the drift comparison always uses current routes.
function codexModelRoutesForConfig(config) {
  return localModelRoutesForClientProtocol(
    getModelRoutes(config).map(ensureCodexResponsesRoute),
    'openai-responses'
  );
}

function ensureCodexResponsesRoute(route) {
  if (!route || typeof route !== 'object') return route;
  const profileId = String(route.profileId || '').trim();
  const from = String(route.from || '').trim();
  if (profileId !== 'workbuddy-official' || !from.startsWith('workbuddy/')) return route;
  const protocols = Array.isArray(route.clientProtocols) ? route.clientProtocols : [];
  if (protocols.includes('openai-responses')) return route;
  return {
    ...route,
    clientProtocols: Array.from(new Set([...protocols, 'openai-responses'])),
  };
}

function readCodexDesktopStatusWithRoutes() {
  const config = loadConfig();
  return getCodexDesktopStatus({
    routeSlugs: codexModelRoutesForConfig(config).map((route) =>
      String((route && route.from) || '').trim()
    ),
  });
}

function createActionHandler(runAction) {
  return function handleToolActionRequest(clientReq, clientRes) {
    try {
      const result = runAction();
      sendJson(clientRes, 200, {
        ok: true,
        ...(result && typeof result === 'object' ? result : {}),
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  };
}

function createBodyActionHandler(runAction) {
  return function handleToolBodyActionRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(clientRes, 400, { ok: false, error: 'Request body must be a JSON object' });
        return;
      }
      try {
        const result = runAction(body);
        sendJson(clientRes, 200, {
          ok: true,
          ...(result && typeof result === 'object' ? result : {}),
        });
      } catch (err) {
        sendJson(clientRes, err.statusCode === 400 ? 400 : 500, {
          ok: false,
          error: err.message,
        });
      }
    });
  };
}

function applyCodexProxyWithRoutes(body = {}) {
  const config = loadConfig();
  return applyCodexProxy({
    ...body,
    modelRoutes: codexModelRoutesForConfig(config),
  });
}

function switchCodexModeWithRoutes(body = {}) {
  const config = loadConfig();
  return switchCodexMode({
    ...body,
    modelRoutes: codexModelRoutesForConfig(config),
  });
}

function createToolConfigHandlers() {
  return {
    handleLocalAntigravityCliStatusRequest: createStatusHandler(getAntigravityCliStatus),
    handleLocalAntigravityCliApplyRequest: createActionHandler(applyAntigravityCliProxy),
    handleLocalAntigravityCliRestoreRequest: createActionHandler(restoreAntigravityCliProxy),
    handleLocalClaudeCodeStatusRequest: createStatusHandler(getClaudeCodeStatus),
    handleLocalClaudeCodeApplyRequest: createActionHandler(applyClaudeCodeProxy),
    handleLocalClaudeCodeRestoreRequest: createActionHandler(restoreClaudeCodeProxy),
    handleLocalCodexStatusRequest: createStatusHandler(getCodexStatus),
    handleLocalCodexApplyRequest: createBodyActionHandler(applyCodexProxyWithRoutes),
    handleLocalCodexRestoreRequest: createActionHandler(restoreCodexProxy),
    handleLocalCodexSwitchRequest: createBodyActionHandler(switchCodexModeWithRoutes),
    handleLocalCodexApiLoginRequest: createBodyActionHandler(applyCodexApiLogin),
    handleLocalCodexOfficialLoginRequest: createBodyActionHandler(launchCodexOfficialLogin),
    handleLocalCodexAuthBackupRequest: createActionHandler(backupCurrentCodexAuth),
    handleLocalCodexDesktopStatusRequest: createStatusHandler(readCodexDesktopStatusWithRoutes),
    handleLocalCodexDesktopApplyRequest: createBodyActionHandler(applyCodexProxyWithRoutes),
    handleLocalCodexDesktopRestoreRequest: createActionHandler(restoreCodexProxy),
    handleLocalCodexDesktopSwitchRequest: createBodyActionHandler((body) =>
      switchCodexModeWithRoutes({ ...body, surface: 'desktop' })
    ),
    handleLocalCodexDesktopApiLoginRequest: createBodyActionHandler(applyCodexApiLogin),
    handleLocalCodexDesktopOfficialLoginRequest: createBodyActionHandler(launchCodexOfficialLogin),
    handleLocalCodexDesktopAuthBackupRequest: createActionHandler(backupCurrentCodexAuth),
    handleLocalGeminiCliStatusRequest: createStatusHandler(getGeminiCliStatus),
    handleLocalGeminiCliApplyRequest: createActionHandler(applyGeminiCliProxy),
    handleLocalGeminiCliRestoreRequest: createActionHandler(restoreGeminiCliProxy),
  };
}

module.exports = {
  codexModelRoutesForConfig,
  createToolConfigHandlers,
};
