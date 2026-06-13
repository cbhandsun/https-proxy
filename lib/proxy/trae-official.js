const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePortOrDefault } = require('./management-utils');

const TRAE_OFFICIAL_TARGET_URL = 'https://coresg-normal.trae.ai';
const TRAE_OFFICIAL_BRIDGE_HOST = process.env.TRAE_BRIDGE_HOST || '127.0.0.1';
const TRAE_OFFICIAL_AUTH_KEYS = ['iCubeAuthInfo://icube.cloudide', 'iCubeAuthInfo://usertag'];

let traeSqlite3Module = null;
let traeSqlite3LoadError = '';

function getTraeRoamingDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Trae');
}

function getTraeStateDbPath() {
  return path.join(getTraeRoamingDir(), 'User', 'globalStorage', 'state.vscdb');
}

function getTraeStorageJsonPath() {
  return path.join(getTraeRoamingDir(), 'User', 'globalStorage', 'storage.json');
}

function getTraeAppRoot() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs',
    'Trae',
    'resources',
    'app'
  );
}

function getTraeOfficialBridgePort() {
  return parsePortOrDefault(
    process.env.TRAE_BRIDGE_PORT,
    parsePortOrDefault(process.env.TRAE_OPENAI_BRIDGE_PORT, 17861)
  );
}

function getTraeOfficialBridgeUrl(pathname = '/v1/chat') {
  const configured = process.env.TRAE_BRIDGE_URL || process.env.TRAE_OPENAI_BRIDGE_URL;
  if (configured) return configured.replace(/\/$/, '') + pathname;
  return `http://${TRAE_OFFICIAL_BRIDGE_HOST}:${getTraeOfficialBridgePort()}${pathname}`;
}

function loadTraeSqlite3() {
  if (traeSqlite3Module) return traeSqlite3Module;
  const candidates = [
    '@vscode/sqlite3',
    'sqlite3',
    path.join(getTraeAppRoot(), 'node_modules', '@vscode', 'sqlite3'),
  ];
  const errors = [];
  for (const item of candidates) {
    try {
      traeSqlite3Module = require(item);
      traeSqlite3LoadError = '';
      return traeSqlite3Module;
    } catch (err) {
      errors.push(`${item}: ${err.message}`);
    }
  }
  traeSqlite3LoadError = errors.join('; ');
  return null;
}

function getTraeSqlite3LoadError() {
  return traeSqlite3LoadError;
}

function isTraeOfficialProfile(profileOrId) {
  if (!profileOrId) return false;
  const id = typeof profileOrId === 'string' ? profileOrId : profileOrId.id;
  if (typeof id === 'string' && id.toLowerCase() === 'trae-official') return true;
  const protocol =
    typeof profileOrId === 'object' && profileOrId.protocol
      ? String(profileOrId.protocol).toLowerCase()
      : '';
  return protocol === 'trae';
}

function isTraeOfficialTarget(targetUrl) {
  try {
    const host = new URL(targetUrl || '').hostname.toLowerCase();
    return (
      host.endsWith('.trae.ai') ||
      host.endsWith('.traeapi.us') ||
      host === 'trae.ai' ||
      host === 'traeapi.us'
    );
  } catch (err) {
    return false;
  }
}

function readTraeStorageSummary(storagePath = getTraeStorageJsonPath()) {
  const summary = {
    storagePath,
    exists: fs.existsSync(storagePath),
    authKeys: [],
    hasOfficialAuth: false,
    entitlement: null,
    user: null,
  };
  if (!summary.exists) return summary;
  try {
    const content = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    summary.authKeys = Object.keys(content).filter((key) => key.indexOf('iCubeAuthInfo://') === 0);
    summary.hasOfficialAuth =
      TRAE_OFFICIAL_AUTH_KEYS.some((key) => Boolean(content[key])) || summary.authKeys.length > 0;
    const serverDataRaw = content['iCubeServerData://icube.cloudide'];
    if (serverDataRaw) {
      try {
        const serverData =
          typeof serverDataRaw === 'string' ? JSON.parse(serverDataRaw) : serverDataRaw;
        summary.entitlement =
          serverData && (serverData.entitlementInfo || serverData.entitlement || null);
        summary.user = serverData && (serverData.userInfo || serverData.user || null);
      } catch (err) {}
    }
  } catch (err) {
    summary.error = err.message;
  }
  return summary;
}

function readTraeProductInfo() {
  const productPath = path.join(getTraeAppRoot(), 'product.json');
  const result = { productPath, exists: fs.existsSync(productPath) };
  if (!result.exists) return result;
  try {
    const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
    result.name = product.nameLong || product.nameShort || product.name || 'Trae';
    result.version = product.version || product.appVersion || '';
    result.commit = product.commit || '';
    result.date = product.date || '';
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

function queryTraeStateRows(dbPath = getTraeStateDbPath()) {
  return new Promise((resolve) => {
    if (!fs.existsSync(dbPath))
      return resolve({ ok: false, dbPath, rows: [], error: 'Trae state.vscdb not found' });
    const sqlite3 = loadTraeSqlite3();
    if (!sqlite3)
      return resolve({
        ok: false,
        dbPath,
        rows: [],
        error: 'Cannot load SQLite module: ' + traeSqlite3LoadError,
      });

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve({ ok: false, dbPath, rows: [], error: err.message });
    });
    const sql =
      "select key, value from ItemTable where key like '%AI.agent.model%' or key in ('AI.modelList','AI.agent.modelList','AI.model','AI.agent.model')";
    db.all(sql, (err, rows) => {
      db.close(() => {});
      if (err) return resolve({ ok: false, dbPath, rows: [], error: err.message });
      resolve({ ok: true, dbPath, rows: Array.isArray(rows) ? rows : [] });
    });
  });
}

function pushTraeModel(target, item, sourceKey) {
  if (!item || typeof item !== 'object') return;
  const name = String(item.name || item.model || item.id || '').trim();
  if (!name || name === '""') return;
  const displayName = String(item.display_name || item.displayName || item.title || name).trim();
  target.push({
    name,
    displayName: displayName || name,
    modelType: item.model_type || item.modelType || '',
    multimodal: item.multimodal === true,
    isDefault: item.is_default === true || item.isDefault === true,
    promptMaxTokens: item.prompt_max_tokens || null,
    sourceKey,
  });
}

function collectTraeModels(target, value, sourceKey) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '""') return;
    try {
      collectTraeModels(target, JSON.parse(trimmed), sourceKey);
    } catch (err) {}
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTraeModels(target, item, sourceKey);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.name || value.model || value.id) {
    pushTraeModel(target, value, sourceKey);
  }
  for (const key of Object.keys(value)) {
    if (key === 'custom_config' || key === 'context_window_size') continue;
    const child = value[key];
    if (Array.isArray(child) || (child && typeof child === 'object')) {
      collectTraeModels(target, child, sourceKey);
    }
  }
}

function traeSourcePriority(sourceKey) {
  const key = String(sourceKey || '');
  if (key.endsWith('_AI.agent.model.model_list_map')) return 1;
  if (key.endsWith('_AI.agent.model.model_list')) return 2;
  if (key === 'AI.agent.modelList') return 3;
  if (key === 'AI.modelList') return 4;
  if (key.indexOf('localModelData_') === 0) return 5;
  return 9;
}

function traeModelsFromStateRows(rows) {
  const collected = [];
  const sortedRows = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
    return traeSourcePriority(a && a.key) - traeSourcePriority(b && b.key);
  });
  for (const row of sortedRows) {
    collectTraeModels(collected, row && row.value, row && row.key);
  }
  const byName = new Map();
  for (const item of collected) {
    const key = item.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, item);
  }
  return Array.from(byName.values());
}

function buildTraeOfficialModelsResponseFromRows(rows) {
  const rawModels = traeModelsFromStateRows(rows);
  const models = [];
  const modelMap = {};
  const seen = new Set();
  for (const item of rawModels) {
    const publicName = item.displayName || item.name;
    const uniqueName = seen.has(publicName.toLowerCase()) ? item.name : publicName;
    if (seen.has(uniqueName.toLowerCase())) continue;
    seen.add(uniqueName.toLowerCase());
    models.push(uniqueName);
    modelMap[uniqueName] = item.name;
    if (publicName !== item.name && !modelMap[item.name]) modelMap[item.name] = item.name;
  }
  return {
    ok: models.length > 0,
    models,
    authMode: 'official-login',
    source: 'trae-state-cache',
    rawModelCount: rawModels.length,
    modelMap,
    rawModels,
  };
}

async function buildTraeOfficialModelsResponse() {
  const state = await queryTraeStateRows();
  if (!state.ok) {
    return {
      ok: false,
      models: [],
      authMode: 'official-login',
      source: 'trae-state-cache',
      dbPath: state.dbPath,
      error: state.error,
    };
  }
  return { ...buildTraeOfficialModelsResponseFromRows(state.rows), dbPath: state.dbPath };
}

function normalizeTraeOfficialModelName(name) {
  return String(name || '')
    .replace(/^trae\//i, '')
    .trim();
}

function traeOfficialModelSupport(testModel, rows) {
  const requested = normalizeTraeOfficialModelName(testModel);
  if (!requested) return { known: false, supported: false, model: requested };
  const response = buildTraeOfficialModelsResponseFromRows(rows);
  const lower = requested.toLowerCase();
  const found = response.rawModels.find((item) => {
    return (
      item.name.toLowerCase() === lower || String(item.displayName || '').toLowerCase() === lower
    );
  });
  if (!found) return { known: false, supported: false, model: requested };
  return {
    known: true,
    supported: true,
    model: found.name,
    displayName: found.displayName,
    modelType: found.modelType,
  };
}

function appendTraeBridgeImage(images, urlValue) {
  const raw = String(urlValue || '');
  const match = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return false;
  images.push({
    type: 'base64',
    mimeType: match[1] || 'image/png',
    data: match[2],
    base64: match[2],
  });
  return true;
}

function openAIContentToTraeText(content, images) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    return JSON.stringify(content);
  }
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (
      typeof item.text === 'string' &&
      (item.type === 'text' || item.type === 'input_text' || !item.type)
    ) {
      parts.push(item.text);
      continue;
    }
    const imageUrl =
      item.image_url && (typeof item.image_url === 'string' ? item.image_url : item.image_url.url);
    const inputImage = item.type === 'input_image' && (item.image_url || item.image || item.data);
    const urlValue = imageUrl || inputImage;
    if (urlValue) {
      if (
        appendTraeBridgeImage(
          images,
          typeof urlValue === 'string' ? urlValue : urlValue.url || urlValue.data
        )
      ) {
        parts.push('[image]');
      } else {
        parts.push(`[image: ${typeof urlValue === 'string' ? urlValue : 'unsupported'}]`);
      }
    }
  }
  return parts.join('\n').trim();
}

function buildTraeBridgePromptFromOpenAIChat(body) {
  const images = [];
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const lines = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || 'user').trim() || 'user';
    const text = openAIContentToTraeText(message.content, images).trim();
    if (!text) continue;
    const label =
      role === 'assistant'
        ? 'Assistant'
        : role === 'system'
          ? 'System'
          : role === 'developer'
            ? 'Developer'
            : role === 'tool'
              ? 'Tool'
              : 'User';
    lines.push(`${label}:\n${text}`);
  }
  const prompt =
    lines.join('\n\n').trim() || String((body && (body.prompt || body.input)) || '').trim();
  return { prompt, images };
}

function buildTraeBridgeOpenAIChatCompletion(requestBody, text, model) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: 'chatcmpl-trae-' + created,
    object: 'chat.completion',
    created,
    model: model || requestBody.model || 'trae-official',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: String(text || '') },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function normalizeTraeBridgeText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.text === 'string') return payload.text;
  if (payload.response && typeof payload.response.text === 'string') return payload.response.text;
  if (payload.data && typeof payload.data.text === 'string') return payload.data.text;
  if (typeof payload.content === 'string') return payload.content;
  if (payload.message && typeof payload.message.content === 'string')
    return payload.message.content;
  return JSON.stringify(payload);
}

module.exports = {
  TRAE_OFFICIAL_TARGET_URL,
  getTraeRoamingDir,
  getTraeStateDbPath,
  getTraeStorageJsonPath,
  getTraeAppRoot,
  getTraeOfficialBridgeUrl,
  getTraeOfficialBridgePort,
  loadTraeSqlite3,
  getTraeSqlite3LoadError,
  isTraeOfficialProfile,
  isTraeOfficialTarget,
  readTraeStorageSummary,
  readTraeProductInfo,
  queryTraeStateRows,
  traeModelsFromStateRows,
  buildTraeOfficialModelsResponseFromRows,
  buildTraeOfficialModelsResponse,
  normalizeTraeOfficialModelName,
  traeOfficialModelSupport,
  buildTraeBridgePromptFromOpenAIChat,
  buildTraeBridgeOpenAIChatCompletion,
  normalizeTraeBridgeText,
};
