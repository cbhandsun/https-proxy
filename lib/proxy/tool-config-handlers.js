const {
  getAntigravityCliStatus,
  applyAntigravityCliProxy,
  restoreAntigravityCliProxy,
  getClaudeCodeStatus,
  applyClaudeCodeProxy,
  restoreClaudeCodeProxy,
  getCodexStatus,
  applyCodexProxy,
  restoreCodexProxy,
  getGeminiCliStatus,
  applyGeminiCliProxy,
  restoreGeminiCliProxy,
} = require('./tool-configs');

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
      runAction();
      sendJson(clientRes, 200, { ok: true });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  };
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
    handleLocalCodexApplyRequest: createActionHandler(applyCodexProxy),
    handleLocalCodexRestoreRequest: createActionHandler(restoreCodexProxy),
    handleLocalGeminiCliStatusRequest: createStatusHandler(getGeminiCliStatus),
    handleLocalGeminiCliApplyRequest: createActionHandler(applyGeminiCliProxy),
    handleLocalGeminiCliRestoreRequest: createActionHandler(restoreGeminiCliProxy),
  };
}

module.exports = {
  createToolConfigHandlers,
};
