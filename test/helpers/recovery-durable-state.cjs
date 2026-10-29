'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// Explicit full storage read for fixtures that need an old-format importer
// input. A cold live owner must never fabricate payloads for its sync exporter.
async function loadDurableRecoveryRoot(storage, rootId) {
  const scope = createHash('sha256')
    .update('hpm/recovery-root/v1\0' + rootId)
    .digest('hex');
  const record = await storage.execute({ operation: 'load', scope });
  assert.equal(record.state.root.rootId, rootId);
  return record.state.root;
}

module.exports = { loadDurableRecoveryRoot };
