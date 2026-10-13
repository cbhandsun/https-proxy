'use strict';

const assert = require('node:assert/strict');
const {
  createEvidenceReceipt,
  evidenceReceiptWasStored,
  EVIDENCE_MARKER,
} = require('../lib/proxy/context-checkpoint');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { planContextEviction } = require('../lib/proxy/context-eviction-planner');

const store = createContextArtifactStore();
let writes = 0;
const counted = {
  put(...args) {
    writes += 1;
    return store.put(...args);
  },
};
const options = { artifactStore: counted, artifactOwner: 'owner', artifactScope: 'scope' };
const original = {
  role: 'tool',
  tool_call_id: 'call-evidence',
  content: '原始工具证据🙂'.repeat(1000),
};
const receipt = createEvidenceReceipt(original, options);
assert.equal(evidenceReceiptWasStored(receipt), true);
assert.equal(writes, 1);
let folded = { ...original, content: `${EVIDENCE_MARKER} ${JSON.stringify(receipt)}` };
for (let pass = 0; pass < 5; pass += 1) {
  const reused = createEvidenceReceipt(folded, options);
  assert.deepEqual(reused, receipt);
  assert.equal(evidenceReceiptWasStored(reused), false);
  folded = { ...folded, content: `${EVIDENCE_MARKER} ${JSON.stringify(reused)}` };
}
assert.equal(writes, 1, 'repeated archival must not store the receipt JSON as new evidence');
assert.equal(store.read('owner', 'scope', receipt.locator, receipt.digest).value, original.content);
assert.equal(store.stats().entries, 1);
assert.equal(store.read('other-owner', 'scope', receipt.locator, receipt.digest).ok, false);
assert.equal(store.read('owner', 'scope', receipt.locator, '0'.repeat(64)).ok, false);

const reusedPlan = planContextEviction(
  [
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'call-evidence', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    folded,
    { role: 'user', content: 'current' },
  ],
  100,
  { ...options, keepRecentUserTurns: 1 }
);
assert.equal(writes, 2, 'only the newly archived assistant call adds one admission');
assert.equal(
  reusedPlan.diagnostics.artifactsStored,
  1,
  'the reused result locator is not counted as a second new admission'
);
assert.equal(store.read('owner', 'scope', receipt.locator, receipt.digest).value, original.content);

for (const content of [
  `${EVIDENCE_MARKER} bad-json`,
  `${EVIDENCE_MARKER} ${JSON.stringify({ ...receipt, callId: 'different' })}`,
  `${EVIDENCE_MARKER} ${JSON.stringify({ ...receipt, bytes: -1 })}`,
  `${EVIDENCE_MARKER} ${' '.repeat(5000)}`,
]) {
  const value = createEvidenceReceipt({ ...original, content }, options);
  assert.equal(evidenceReceiptWasStored(value), true);
  assert.notEqual(value.locator, receipt.locator);
  assert.equal(
    store.read('owner', 'scope', value.locator, value.digest).value,
    content,
    'malformed/unbound markers remain ordinary untrusted evidence'
  );
}
const expiredStore = createContextArtifactStore();
expiredStore.close();
assert.equal(expiredStore.read('owner', 'scope', receipt.locator, receipt.digest).ok, false);
assert.equal(evidenceReceiptWasStored({ ...receipt }), false);
