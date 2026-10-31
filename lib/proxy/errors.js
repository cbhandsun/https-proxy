const UPSTREAM_RATE_LIMIT_COOLDOWNS = new Map();
const MAX_UPSTREAM_RETRY_AFTER_SECONDS = 120;
let cooldownPersistenceOverride;
let cooldownPersistenceLoaded = false;

function clampRetryAfterSeconds(value, maxSeconds = MAX_UPSTREAM_RETRY_AFTER_SECONDS) {
  const parsed = Math.ceil(Number(value));
  const max = Number.isFinite(Number(maxSeconds))
    ? Math.max(1, Math.trunc(Number(maxSeconds)))
    : MAX_UPSTREAM_RETRY_AFTER_SECONDS;
  return Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), max) : max;
}

function parseRetryDelaySeconds(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*s/);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return null;
  return clampRetryAfterSeconds(seconds);
}

function parseRetryAfterHeaderSeconds(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = Array.isArray(value) ? String(value[0] || '').trim() : String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return clampRetryAfterSeconds(Number(text));

  const parsedDate = Date.parse(text);
  const nowMs = Number(now);
  if (Number.isFinite(parsedDate) && Number.isFinite(nowMs)) {
    return clampRetryAfterSeconds((parsedDate - nowMs) / 1000);
  }

  return parseRetryDelaySeconds(text);
}

function parseGeminiError(statusCode, body) {
  let message = body;
  let type = statusCode === 429 ? 'rate_limit_error' : 'api_error';
  let status = null;
  let retryAfterSeconds = null;
  let quotaMetric = null;
  let quotaId = null;

  try {
    const parsed = JSON.parse(body);
    const error = parsed && parsed.error;
    if (error) {
      message = error.message || body;
      status = error.status || null;
      if (status === 'RESOURCE_EXHAUSTED') type = 'rate_limit_error';
      const details = Array.isArray(error.details) ? error.details : [];
      for (const detail of details) {
        if (detail && detail.retryDelay)
          retryAfterSeconds = parseRetryDelaySeconds(detail.retryDelay);
        const violations = detail && detail.violations;
        if (Array.isArray(violations) && violations[0]) {
          quotaMetric = violations[0].quotaMetric || quotaMetric;
          quotaId = violations[0].quotaId || quotaId;
        }
      }
    }
  } catch (err) {}

  if (retryAfterSeconds === null) retryAfterSeconds = parseRetryDelaySeconds(message);
  return { type, message, status, retryAfterSeconds, quotaMetric, quotaId };
}

function upstreamRequestId(headers) {
  return (
    (headers &&
      (headers['x-request-id'] ||
        headers['request-id'] ||
        headers['anthropic-request-id'] ||
        headers['x-requestid'])) ||
    undefined
  );
}

function upstreamErrorRequestId(headers, error) {
  return (
    upstreamRequestId(headers) ||
    (error &&
      (error.request_id ||
        error.requestId ||
        error.id ||
        error.upstream_request_id ||
        error.upstreamRequestId)) ||
    undefined
  );
}

function decodeHtmlEntity(entity) {
  const named = {
    amp: '&',
    gt: '>',
    lt: '<',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  const text = String(entity || '');
  if (Object.prototype.hasOwnProperty.call(named, text)) return named[text];
  const decimal = text.match(/^#(\d+)$/);
  if (decimal) {
    const codePoint = Number(decimal[1]);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '&' + text + ';';
  }
  const hex = text.match(/^#x([0-9a-f]+)$/i);
  if (hex) {
    const codePoint = Number.parseInt(hex[1], 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '&' + text + ';';
  }
  return '&' + text + ';';
}

function textFromHtmlSnippet(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, (_match, entity) => decodeHtmlEntity(entity))
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlErrorMessage(body, statusCode) {
  if (typeof body !== 'string' || !/<(?:!doctype\s+html|html|head|body|title|h1)\b/i.test(body)) {
    return '';
  }
  const titleMatch = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const headingMatch = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = textFromHtmlSnippet(titleMatch && titleMatch[1]);
  const heading = textFromHtmlSnippet(headingMatch && headingMatch[1]);
  const message = title || heading;
  if (message) return message;
  return `Upstream returned an HTML error page (${statusCode})`;
}

function normalizeUpstreamError(statusCode, headers, body, upstream) {
  let type = statusCode === 429 ? 'rate_limit_error' : 'api_error';
  let message = String(body || 'Upstream request failed');
  let code;
  let parsedError = null;
  try {
    const parsed = JSON.parse(body);
    const error = parsed && parsed.error ? parsed.error : parsed;
    if (error && typeof error === 'object') {
      parsedError = error;
      type = typeof error.type === 'string' && error.type ? error.type : type;
      if (!error.type && typeof error.code === 'string' && error.code) type = error.code;
      message =
        (typeof error.message === 'string' && error.message) ||
        (typeof error.msg === 'string' && error.msg) ||
        (typeof error.error === 'string' && error.error) ||
        message;
      code = error.code || error.status || undefined;
    }
  } catch (err) {}
  const htmlMessage = htmlErrorMessage(body, statusCode);
  if (htmlMessage) message = htmlMessage;
  return {
    error: {
      type,
      message,
      code,
      status: statusCode,
      upstream,
      request_id: upstreamErrorRequestId(headers, parsedError),
      retry_after: headers && headers['retry-after'] ? String(headers['retry-after']) : undefined,
    },
  };
}

function sendJsonError(clientRes, statusCode, error, extraHeaders) {
  const body = JSON.stringify(error);
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...(extraHeaders || {}),
  });
  clientRes.end(body);
}

function sendUpstreamError(clientRes, statusCode, headers, body, upstream) {
  const normalized = normalizeUpstreamError(statusCode, headers, body, upstream);
  const extraHeaders = {};
  if (normalized.error.retry_after) extraHeaders['Retry-After'] = normalized.error.retry_after;
  sendJsonError(clientRes, statusCode, normalized, extraHeaders);
  return normalized;
}

function geminiErrorToClaude(statusCode, body) {
  const error = parseGeminiError(statusCode, body);
  return JSON.stringify({ error: { type: error.type, message: error.message } });
}

function upstreamCooldownKey(profileId, targetModel, defaultModel = 'upstream') {
  return String(profileId || 'default') + ':' + String(targetModel || defaultModel);
}

function cooldownRecordFromValue(value) {
  if (value && typeof value === 'object') {
    return {
      until: Number(value.until),
      source: typeof value.source === 'string' ? value.source : '',
      profileId: typeof value.profileId === 'string' ? value.profileId : '',
      targetModel: typeof value.targetModel === 'string' ? value.targetModel : '',
    };
  }
  return { until: Number(value), source: '', profileId: '', targetModel: '' };
}

function cooldownPartsFromKey(key) {
  const text = String(key || '');
  const separator = text.indexOf(':');
  if (separator < 0) return { profileId: text, targetModel: '' };
  return {
    profileId: text.slice(0, separator),
    targetModel: text.slice(separator + 1),
  };
}

function cooldownSnapshotFromEntry(key, value, now = Date.now()) {
  const record = cooldownRecordFromValue(value);
  if (!Number.isFinite(record.until) || record.until <= now) {
    UPSTREAM_RATE_LIMIT_COOLDOWNS.delete(key);
    return null;
  }
  const parts = cooldownPartsFromKey(key);
  return {
    key,
    profileId: record.profileId || parts.profileId,
    targetModel: record.targetModel || parts.targetModel,
    retryAfterSeconds: Math.max(1, Math.ceil((record.until - now) / 1000)),
    resetAt: Math.ceil(record.until / 1000),
    source: record.source || undefined,
  };
}

function cooldownPersistence() {
  if (cooldownPersistenceOverride !== undefined) return cooldownPersistenceOverride;
  try {
    return require('./upstream-cooldown-store');
  } catch (_error) {
    return null;
  }
}

function activeCooldownSnapshots(now = Date.now()) {
  const items = [];
  let removedExpired = false;
  for (const [key, value] of UPSTREAM_RATE_LIMIT_COOLDOWNS.entries()) {
    const item = cooldownSnapshotFromEntry(key, value, now);
    if (item) {
      items.push(item);
    } else {
      removedExpired = true;
    }
  }
  return { items, removedExpired };
}

function persistCooldownsBestEffort(now = Date.now()) {
  const persistence = cooldownPersistence();
  if (!persistence || typeof persistence.writePersistedCooldowns !== 'function') return;
  try {
    persistence.writePersistedCooldowns(
      activeCooldownSnapshots(now).items.map((item) => ({
        profileId: item.profileId,
        targetModel: item.targetModel,
        until: item.resetAt * 1000,
        source: item.source || '',
      })),
      { now }
    );
  } catch (_error) {}
}

function loadPersistedCooldownsOnce(now = Date.now()) {
  if (cooldownPersistenceLoaded) return;
  cooldownPersistenceLoaded = true;
  const persistence = cooldownPersistence();
  if (!persistence || typeof persistence.readPersistedCooldowns !== 'function') return;
  try {
    const records = persistence.readPersistedCooldowns({ now });
    for (const record of records) {
      if (!record || !record.profileId || !record.targetModel) continue;
      UPSTREAM_RATE_LIMIT_COOLDOWNS.set(
        upstreamCooldownKey(record.profileId, record.targetModel),
        record
      );
    }
  } catch (_error) {}
}

function configureUpstreamCooldownPersistence(persistence) {
  cooldownPersistenceOverride = persistence || null;
  cooldownPersistenceLoaded = false;
}

function getCooldownByKey(key, now = Date.now()) {
  loadPersistedCooldownsOnce(now);
  return cooldownSnapshotFromEntry(key, UPSTREAM_RATE_LIMIT_COOLDOWNS.get(key), now);
}

function setCooldownByKey(key, retryAfterSeconds, now = Date.now(), options = {}) {
  loadPersistedCooldownsOnce(now);
  if (!retryAfterSeconds) return null;
  const maxSeconds =
    options && Object.prototype.hasOwnProperty.call(options, 'maxSeconds')
      ? options.maxSeconds
      : MAX_UPSTREAM_RETRY_AFTER_SECONDS;
  const seconds = clampRetryAfterSeconds(retryAfterSeconds, maxSeconds);
  const until = now + seconds * 1000;
  UPSTREAM_RATE_LIMIT_COOLDOWNS.set(key, {
    until,
    source: typeof options.source === 'string' ? options.source : '',
    profileId: typeof options.profileId === 'string' ? options.profileId : '',
    targetModel: typeof options.targetModel === 'string' ? options.targetModel : '',
  });
  const snapshot = cooldownSnapshotFromEntry(key, UPSTREAM_RATE_LIMIT_COOLDOWNS.get(key), now);
  persistCooldownsBestEffort(now);
  return snapshot;
}

function getUpstreamCooldown(profileId, targetModel) {
  return getCooldownByKey(upstreamCooldownKey(profileId, targetModel));
}

function setUpstreamCooldown(profileId, targetModel, retryAfterSeconds, options) {
  const profile = String(profileId || 'default');
  const model = String(targetModel || 'upstream');
  return setCooldownByKey(upstreamCooldownKey(profile, model), retryAfterSeconds, Date.now(), {
    ...(options || {}),
    profileId: profile,
    targetModel: model,
  });
}

function listUpstreamCooldowns(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  loadPersistedCooldownsOnce(now);
  const profileId =
    typeof options.profileId === 'string' && options.profileId.trim()
      ? options.profileId.trim()
      : '';
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(0, Math.trunc(Number(options.maxItems)))
    : 100;
  const snapshot = activeCooldownSnapshots(now);
  if (snapshot.removedExpired) persistCooldownsBestEffort(now);
  return snapshot.items
    .filter((item) => !profileId || item.profileId === profileId)
    .sort((a, b) => b.retryAfterSeconds - a.retryAfterSeconds)
    .slice(0, maxItems);
}

function clearUpstreamCooldowns(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  loadPersistedCooldownsOnce(now);
  const profileId =
    typeof options.profileId === 'string' && options.profileId.trim()
      ? options.profileId.trim()
      : '';
  const targetModel =
    typeof options.targetModel === 'string' && options.targetModel.trim()
      ? options.targetModel.trim()
      : '';
  let clearedCount = 0;
  for (const [key, value] of Array.from(UPSTREAM_RATE_LIMIT_COOLDOWNS.entries())) {
    const item = cooldownSnapshotFromEntry(key, value, now);
    if (!item) continue;
    const matchProfile = !profileId || item.profileId === profileId;
    const matchModel = !targetModel || item.targetModel === targetModel;
    if (matchProfile && matchModel) {
      UPSTREAM_RATE_LIMIT_COOLDOWNS.delete(key);
      clearedCount += 1;
    }
  }
  persistCooldownsBestEffort(now);
  return {
    clearedCount,
    cooldowns: listUpstreamCooldowns({ now }),
  };
}

const KEY_POOL_CURSORS = new Map();

function splitApiKeyPool(rawApiKey) {
  const text = String(rawApiKey || '').trim();
  if (!text || text.startsWith('{') || !text.includes(',')) return text ? [text] : [];
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function selectApiKeyFromPool(rawApiKey, profileId = 'default', now = Date.now()) {
  const keys = splitApiKeyPool(rawApiKey);
  if (keys.length <= 1) return keys[0] || '';
  const cursorKey = String(profileId || 'default');
  const startIdx = KEY_POOL_CURSORS.get(cursorKey) || 0;
  for (let offset = 0; offset < keys.length; offset += 1) {
    const idx = (startIdx + offset) % keys.length;
    const cdKey = `keypool:${cursorKey}:${idx}`;
    if (!getCooldownByKey(cdKey, now)) {
      KEY_POOL_CURSORS.set(cursorKey, (idx + 1) % keys.length);
      return keys[idx];
    }
  }
  const fallbackIdx = startIdx % keys.length;
  KEY_POOL_CURSORS.set(cursorKey, (fallbackIdx + 1) % keys.length);
  return keys[fallbackIdx];
}

function markApiKeyPoolRateLimited(
  rawApiKey,
  selectedKey,
  profileId = 'default',
  retryAfterSeconds = 30,
  now = Date.now()
) {
  const keys = splitApiKeyPool(rawApiKey);
  if (keys.length <= 1) return null;
  const idx = keys.indexOf(String(selectedKey || '').trim());
  if (idx < 0) return null;
  const cursorKey = String(profileId || 'default');
  return setCooldownByKey(`keypool:${cursorKey}:${idx}`, retryAfterSeconds, now, {
    profileId: cursorKey,
    targetModel: `apiKey#${idx + 1}`,
    source: 'key-pool-429',
  });
}

function geminiCooldownKey(profileId, targetModel) {
  return upstreamCooldownKey(profileId, targetModel, 'gemini');
}

function getGeminiCooldown(profileId, targetModel) {
  return getCooldownByKey(geminiCooldownKey(profileId, targetModel));
}

function setGeminiCooldown(profileId, targetModel, retryAfterSeconds) {
  const profile = String(profileId || 'default');
  const model = String(targetModel || 'gemini');
  return setCooldownByKey(geminiCooldownKey(profile, model), retryAfterSeconds, Date.now(), {
    profileId: profile,
    targetModel: model,
  });
}

module.exports = {
  clampRetryAfterSeconds,
  parseRetryDelaySeconds,
  parseRetryAfterHeaderSeconds,
  parseGeminiError,
  upstreamRequestId,
  normalizeUpstreamError,
  sendJsonError,
  sendUpstreamError,
  geminiErrorToClaude,
  upstreamCooldownKey,
  getUpstreamCooldown,
  setUpstreamCooldown,
  listUpstreamCooldowns,
  clearUpstreamCooldowns,
  splitApiKeyPool,
  selectApiKeyFromPool,
  markApiKeyPoolRateLimited,
  configureUpstreamCooldownPersistence,
  geminiCooldownKey,
  getGeminiCooldown,
  setGeminiCooldown,
};
