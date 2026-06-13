const os = require('os');
const path = require('path');

const { readJsonBodyFromRequest, writeTextFileAtomically } = require('./management-utils');

const MAX_PROMPT_CONTENT_CHARS = 200000;
const MAX_PROMPT_PRESETS = 64;
const MAX_PROMPT_PRESET_ID_CHARS = 128;
const MAX_PROMPT_PRESET_NAME_CHARS = 200;

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
    '{{os}}': os.platform(),
  };
  let result = content;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.split(key).join(value);
  }
  return result;
}

function assertPromptContent(content, label = 'content') {
  if (typeof content !== 'string') throw new Error(`${label} must be a string`);
  if (content.length > MAX_PROMPT_CONTENT_CHARS) {
    throw new Error(`${label} is too large; max ${MAX_PROMPT_CONTENT_CHARS} characters`);
  }
}

function normalizePromptPresets(presets) {
  if (!Array.isArray(presets)) throw new Error('presets must be an array');
  if (presets.length > MAX_PROMPT_PRESETS) {
    throw new Error(`presets contains too many items; max ${MAX_PROMPT_PRESETS}`);
  }
  return presets.map((preset, index) => {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      throw new Error(`presets[${index}] must be an object`);
    }
    const id = String(preset.id || '').trim();
    if (!id) throw new Error(`presets[${index}].id is required`);
    if (id.length > MAX_PROMPT_PRESET_ID_CHARS) {
      throw new Error(`presets[${index}].id is too long`);
    }
    if (preset.name != null && String(preset.name).length > MAX_PROMPT_PRESET_NAME_CHARS) {
      throw new Error(`presets[${index}].name is too long`);
    }
    assertPromptContent(preset.content, `presets[${index}].content`);
    return { ...preset, id };
  });
}

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify(payload));
}

function handleLocalPromptsSyncRequest(clientReq, clientRes) {
  readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
    if (bodyErr) {
      sendJson(clientRes, 400, { error: bodyErr.message });
      return;
    }
    try {
      const { type, content } = body;
      if (!type) {
        throw new Error('type and content are required');
      }
      assertPromptContent(content);

      const targetPath = promptTargetPath(type);
      const finalContent = replacePlaceholders(content);
      writeTextFileAtomically(targetPath, finalContent);

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
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const { presets, action, presetId } = body;

        if (action === 'apply' && presetId) {
          const preset = (config.promptPresets || []).find((p) => p.id === presetId);
          if (!preset) {
            sendJson(clientRes, 404, { ok: false, error: 'Preset not found: ' + presetId });
            return;
          }
          assertPromptContent(preset.content, 'preset.content');

          const results = [];
          const tools = ['claude', 'codex', 'gemini', 'antigravity'];
          for (const type of tools) {
            try {
              const targetPath = promptTargetPath(type);
              const finalContent = replacePlaceholders(preset.content);
              writeTextFileAtomically(targetPath, finalContent);
              results.push({ type, ok: true, path: targetPath });
            } catch (e) {
              results.push({ type, ok: false, error: e.message });
            }
          }
          sendJson(clientRes, 200, { ok: true, results });
          return;
        }

        if (presets) {
          config.promptPresets = normalizePromptPresets(presets);
          saveConfig(config);
        }
        sendJson(clientRes, 200, { ok: true });
      } catch (err) {
        sendJson(clientRes, 400, { error: err.message });
      }
    });
    return;
  }

  sendJson(clientRes, 405, { ok: false, error: 'Method not allowed' });
}

module.exports = {
  promptTargetPath,
  normalizePromptPresets,
  writeTextFileAtomically,
  handleLocalPromptsSyncRequest,
  handleLocalPromptsPresetsRequest,
};
