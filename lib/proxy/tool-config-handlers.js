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

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
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

function createActionHandler(runAction) {
  return function handleToolActionRequest(clientReq, clientRes) {
    try {
      const result = runAction();
      sendJson(clientRes, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  };
}

function readJsonBody(clientReq, callback) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', () => {
    if (chunks.length === 0) {
      callback(null, {});
      return;
    }
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (err) {
      callback(err);
    }
  });
}

function createBodyActionHandler(runAction) {
  return function handleToolBodyActionRequest(clientReq, clientRes) {
    readJsonBody(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const result = runAction(body || {});
        sendJson(clientRes, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  };
}

function applyCodexProxyWithRoutes() {
  const config = loadConfig();
  return applyCodexProxy({ modelRoutes: getModelRoutes(config) });
}

function switchCodexModeWithRoutes(body = {}) {
  const config = loadConfig();
  return switchCodexMode({
    ...body,
    modelRoutes: getModelRoutes(config),
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
    handleLocalCodexApplyRequest: createActionHandler(applyCodexProxyWithRoutes),
    handleLocalCodexRestoreRequest: createActionHandler(restoreCodexProxy),
    handleLocalCodexSwitchRequest: createBodyActionHandler(switchCodexModeWithRoutes),
    handleLocalCodexApiLoginRequest: createBodyActionHandler(applyCodexApiLogin),
    handleLocalCodexOfficialLoginRequest: createBodyActionHandler(launchCodexOfficialLogin),
    handleLocalCodexAuthBackupRequest: createActionHandler(backupCurrentCodexAuth),
    handleLocalCodexDesktopStatusRequest: createStatusHandler(getCodexDesktopStatus),
    handleLocalCodexDesktopApplyRequest: createActionHandler(applyCodexProxyWithRoutes),
    handleLocalCodexDesktopRestoreRequest: createActionHandler(restoreCodexProxy),
    handleLocalCodexDesktopSwitchRequest: createBodyActionHandler((body) => switchCodexModeWithRoutes({ ...body, surface: 'desktop' })),
    handleLocalCodexDesktopApiLoginRequest: createBodyActionHandler(applyCodexApiLogin),
    handleLocalCodexDesktopOfficialLoginRequest: createBodyActionHandler(launchCodexOfficialLogin),
    handleLocalCodexDesktopAuthBackupRequest: createActionHandler(backupCurrentCodexAuth),
    handleLocalGeminiCliStatusRequest: createStatusHandler(getGeminiCliStatus),
    handleLocalGeminiCliApplyRequest: createActionHandler(applyGeminiCliProxy),
    handleLocalGeminiCliRestoreRequest: createActionHandler(restoreGeminiCliProxy),
  };
}

module.exports = {
  createToolConfigHandlers,
};
