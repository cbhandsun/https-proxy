const crypto = require('crypto');

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function stableId(prefix, value) {
  return prefix + '_' + stableHash(value);
}

function stableCreated(value) {
  return parseInt(stableHash(value).slice(0, 8), 16);
}

function fallbackId(prefix, value, options) {
  const stableToolUseIds = !options || options.stableToolUseIds !== false;
  return stableToolUseIds ? stableId(prefix, value) : prefix + '_' + Date.now();
}

module.exports = {
  stableHash,
  stableId,
  fallbackId,
  stableCreated,
};
