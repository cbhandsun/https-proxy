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

function replacePlaceholders(content) {
  if (typeof content !== 'string') return content;
  const replacements = {
    '{{project_name}}': path.basename(process.cwd()),
    '{{cwd}}': process.cwd(),
    '{{date}}': new Date().toLocaleDateString(),
    '{{os}}': os.platform()
  };
  let result = content;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.split(key).join(value);
  }
  return result;
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
      const finalContent = replacePlaceholders(content);
      fs.writeFileSync(targetPath, finalContent, 'utf8');

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
        const { presets, action, presetId } = body;

        if (action === 'apply' && presetId) {
          const preset = (config.promptPresets || []).find(p => p.id === presetId);
          if (!preset) {
            sendJson(clientRes, 404, { ok: false, error: 'Preset not found: ' + presetId });
            return;
          }

          const results = [];
          const tools = ['claude', 'codex', 'gemini', 'antigravity'];
          for (const type of tools) {
            try {
              const targetPath = promptTargetPath(type);
              const targetDir = path.dirname(targetPath);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              const finalContent = replacePlaceholders(preset.content);
              fs.writeFileSync(targetPath, finalContent, 'utf8');
              results.push({ type, ok: true, path: targetPath });
            } catch (e) {
              results.push({ type, ok: false, error: e.message });
            }
          }
          sendJson(clientRes, 200, { ok: true, results });
          return;
        }

        if (presets && !Array.isArray(presets)) {
          throw new Error('presets must be an array');
        }

        if (presets) {
          config.promptPresets = presets;
          saveConfig(config);
        }
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
