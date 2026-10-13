'use strict';

const { createHash } = require('node:crypto');

// Preserve ordinary provider IDs; replacing punctuation alone aliases distinct
// calls (for example a-b and a_b). Unsafe/long IDs get a bounded readable prefix
// and a deterministic digest of the complete original value.
function geminiToolId(raw) {
  if (/^[A-Za-z0-9_]{1,128}$/.test(raw)) return 'toolu_' + raw;
  const prefix = raw.slice(0, 24).replace(/[^A-Za-z0-9_]/g, '_');
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return 'toolu_' + prefix + '_' + digest;
}

module.exports = { geminiToolId };
