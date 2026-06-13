const path = require('path');
const { URL } = require('url');

const { DATA_DIR } = require('../config');
const { parseBoundedInteger, readJsonBodyFromRequest } = require('../management-utils');
const { validateMcpHubConfig } = require('../validator');
const { readTailText } = require('./management-diagnostics');

function createManagementMcpHandlers({
  sendJson,
  currentConfigSnapshot,
  readRawConfigSnapshot,
  writeRawConfigSnapshot,
}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementMcpHandlers requires sendJson');
  }
  if (typeof currentConfigSnapshot !== 'function') {
    throw new TypeError('createManagementMcpHandlers requires currentConfigSnapshot');
  }
  if (typeof readRawConfigSnapshot !== 'function') {
    throw new TypeError('createManagementMcpHandlers requires readRawConfigSnapshot');
  }
  if (typeof writeRawConfigSnapshot !== 'function') {
    throw new TypeError('createManagementMcpHandlers requires writeRawConfigSnapshot');
  }

  function handleLocalMcpHubGetRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot() || {};
      sendJson(clientRes, 200, { ok: true, mcpHub: config.mcpHub || { servers: [], routing: [] } });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalMcpHubSaveRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const mcpHubConfig = body && body.mcpHub;
        if (
          !mcpHubConfig ||
          !Array.isArray(mcpHubConfig.servers) ||
          !Array.isArray(mcpHubConfig.routing)
        ) {
          sendJson(clientRes, 400, {
            ok: false,
            error: 'mcpHub.servers and mcpHub.routing are required arrays',
          });
          return;
        }
        const validation = validateMcpHubConfig(mcpHubConfig);
        if (!validation.valid) {
          sendJson(clientRes, 400, {
            ok: false,
            error: 'Invalid MCP Hub configuration: ' + validation.errors.join(', '),
          });
          return;
        }
        const rawConfig = readRawConfigSnapshot();
        rawConfig.mcpHub = {
          servers: mcpHubConfig.servers,
          routing: mcpHubConfig.routing,
        };
        writeRawConfigSnapshot(rawConfig);
        sendJson(clientRes, 200, { ok: true });
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalMcpHubLogsRequest(clientReq, clientRes) {
    try {
      const logFile = path.join(DATA_DIR, 'mcp-execution.jsonl');
      const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const maxLines = parseBoundedInteger(parsedUrl.searchParams.get('lines'), 200, 1, 2000);
      sendJson(clientRes, 200, { ok: true, logs: readTailText(logFile, maxLines, 256 * 1024) });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  return {
    handleLocalMcpHubGetRequest,
    handleLocalMcpHubSaveRequest,
    handleLocalMcpHubLogsRequest,
  };
}

module.exports = {
  createManagementMcpHandlers,
};
