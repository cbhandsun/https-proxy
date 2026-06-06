const fs = require('fs');
const os = require('os');
const path = require('path');

function promptTargetPath(type, homeDir = os.homedir()) {
  if (type === 'claude') {
    return path.join(homeDir, '.claude', 'CLAUDE.md');
  }
  if (type === 'codex') {
    return path.join(homeDir, '.codex', 'AGENTS.md');
  }
  if (type === 'gemini') {
    return path.join(homeDir, '.gemini', 'GEMINI.md');
  }
  if (type === 'antigravity') {
    return path.join(homeDir, '.antigravity', 'CLAUDE.md');
  }
  throw new Error('Unsupported prompt type: ' + type);
}

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  clientRes.end(JSON.stringify(payload));
}

function handleLocalPromptsSyncRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { type, content } = body;
      if (!type || typeof content !== 'string') {
        throw new Error('type and content are required');
      }

      const targetPath = promptTargetPath(type);
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(targetPath, content, 'utf8');

      sendJson(clientRes, 200, { ok: true, path: targetPath });
    } catch (err) {
      sendJson(clientRes, 400, { error: err.message });
    }
  });
}

function handleLocalPromptsPresetsRequest(clientReq, clientRes, config, saveConfig) {
  if (clientReq.method === 'GET') {
    sendJson(clientRes, 200, { ok: true, presets: config.promptPresets || [] });
    return;
  }

  if (clientReq.method === 'POST') {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { presets } = body;
        if (!Array.isArray(presets)) {
          throw new Error('presets must be an array');
        }

        config.promptPresets = presets;
        saveConfig(config);
        sendJson(clientRes, 200, { ok: true });
      } catch (err) {
        sendJson(clientRes, 400, { error: err.message });
      }
    });
    return;
  }
}

module.exports = {
  promptTargetPath,
  handleLocalPromptsSyncRequest,
  handleLocalPromptsPresetsRequest,
};
