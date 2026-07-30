const path = require('path');
const { URL } = require('url');

const { DATA_DIR, encryptKey } = require('../config');
const { parseBoundedInteger, readJsonBodyFromRequest } = require('../management-utils');
const { validateMcpHubConfig } = require('../validator');
const { readTailText } = require('./management-diagnostics');

function isEncryptedSecret(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('hpm-dpapi:') ||
      value.startsWith('hpm-enc:') ||
      value.startsWith('hpm-aes-v2:'))
  );
}

function encryptMcpSecret(value) {
  const token = String(value || '').trim();
  if (!token || isEncryptedSecret(token)) return token;
  return encryptKey(token);
}

function redactMcpHubSecrets(mcpHub) {
  const cloned = JSON.parse(JSON.stringify(mcpHub || { servers: [], routing: [] }));
  if (cloned && Array.isArray(cloned.servers)) {
    for (const server of cloned.servers) {
      if (server && server.bearerToken) server.bearerToken = '[redacted]';
    }
  }
  return cloned;
}

function protectMcpHubSecretsForStorage(nextMcpHub, currentRawMcpHub) {
  const cloned = JSON.parse(JSON.stringify(nextMcpHub || { servers: [], routing: [] }));
  const currentServers = Array.isArray(currentRawMcpHub && currentRawMcpHub.servers)
    ? currentRawMcpHub.servers
    : [];
  if (!Array.isArray(cloned.servers)) return cloned;
  for (const server of cloned.servers) {
    if (!server || typeof server !== 'object') continue;
    const current = currentServers.find((item) => item && item.id === server.id);
    if (server.bearerToken === '[redacted]' || server.bearerToken === '***') {
      server.bearerToken = current ? current.bearerToken || '' : '';
      continue;
    }
    if (server.bearerToken) server.bearerToken = encryptMcpSecret(server.bearerToken);
  }
  return cloned;
}

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
      sendJson(clientRes, 200, {
        ok: true,
        mcpHub: redactMcpHubSecrets(config.mcpHub || { servers: [], routing: [] }),
      });
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
        rawConfig.mcpHub = protectMcpHubSecretsForStorage(mcpHubConfig, rawConfig.mcpHub);
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
  protectMcpHubSecretsForStorage,
  redactMcpHubSecrets,
};
