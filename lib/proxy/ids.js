const crypto = require('crypto');

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function stableId(prefix, value) {
  return prefix + '_' + stableHash(value);
}

function stableCreated() {
  // Keep the existing injected API; creation time is independent of content/IDs.
  // Stream callers capture this once and reuse it for every event.
  return Math.floor(Date.now() / 1000);
}

function resolveCreatedTimestamp(value, fallback = stableCreated) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback();
}

function fallbackId(prefix, value, options) {
  // Response identity belongs to one request, regardless of equal content.
  // Keep tool/output-item identity rules separate from stored-history keys.
  if (prefix === 'resp' || prefix === 'chatcmpl' || prefix === 'msg_gemini') {
    return prefix + '_' + crypto.randomUUID();
  }
  const stableToolUseIds = !options || options.stableToolUseIds !== false;
  return stableToolUseIds ? stableId(prefix, value) : prefix + '_' + Date.now();
}

module.exports = {
  stableHash,
  stableId,
  fallbackId,
  stableCreated,
  resolveCreatedTimestamp,
};
