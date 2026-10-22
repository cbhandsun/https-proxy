'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CHECKPOINT_MARKER,
  CHECKPOINT_SCHEMA,
  EVIDENCE_MARKER,
  buildRolePreservingCheckpoint,
  checkpointPayload,
  createEvidenceReceipt,
} = require('../lib/proxy/context-checkpoint');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');

const unavailable = 'missing_no_guess_no_replay';
const original = {
  role: 'tool',
  tool_call_id: 'synthetic_write',
  name: 'synthetic_side_effect',
  content: 'synthetic private original',
};
function receipt(overrides = {}) {
  return {
    kind: 'historical_tool_evidence',
    bytes: 1,
    digest: 'a'.repeat(64),
    callId: original.tool_call_id,
    name: original.name,
    recovery: 'rerun_or_reread_original_tool',
    ...overrides,
  };
}
function previous(value) {
  return {
    role: 'assistant',
    content:
      CHECKPOINT_MARKER +
      '\n' +
      JSON.stringify({
        schema: CHECKPOINT_SCHEMA,
        version: 1,
        sourceRole: 'assistant',
        entries: [{ invokedTools: [original.name], callReceipt: value }],
        evidenceReceipts: [value],
      }),
  };
}
function payload(messages, options) {
  const checkpoints = buildRolePreservingCheckpoint(messages, { maxChars: 6000, ...options });
  return checkpoints && checkpointPayload(checkpoints.find((item) => item.role === 'assistant'));
}

test('missing or refused retention reports unavailability, never guessing or replay authority', () => {
  let puts = 0;
  const options = {
    artifactOwner: 'owner',
    artifactScope: 'scope',
    artifactStore: { put: () => (puts++, null) },
  };
  assert.equal(createEvidenceReceipt(original).recovery, unavailable);
  assert.equal(createEvidenceReceipt(original, options).recovery, unavailable);
  const state = payload([original], options);
  assert.equal(state.evidenceReceipts[0].recovery, unavailable);
  assert.ok(!JSON.stringify(state).includes(original.content));
  assert.equal(puts, 2);
});

test('legacy embedded and refolded hints are normalized without storing receipt JSON as original', () => {
  let puts = 0;
  const options = { artifactStore: { put: () => puts++ }, artifactOwner: 'o', artifactScope: 's' };
  const state = payload([previous(receipt())], options);
  assert.equal(state.entries[0].callReceipt.recovery, unavailable);
  assert.equal(state.evidenceReceipts[0].recovery, unavailable);
  const refolded = createEvidenceReceipt(
    { ...original, content: EVIDENCE_MARKER + ' ' + JSON.stringify(receipt()) },
    options
  );
  assert.equal(refolded.recovery, unavailable);
  assert.equal(refolded.digest, 'a'.repeat(64));
  assert.equal(puts, 0);
});

test('valid stored receipts retain readback; expiry and replacement do not authorize execution', () => {
  let now = 0;
  const store = createContextArtifactStore({ now: () => now, ttlMs: 10, maxLifetimeMs: 20 });
  const options = { artifactStore: store, artifactOwner: 'owner', artifactScope: 'scope' };
  const stored = createEvidenceReceipt(original, options);
  for (const value of [stored, payload([previous(stored)]).evidenceReceipts[0]]) {
    assert.equal(value.recovery, 'read_context_artifact');
    assert.equal(store.read('owner', 'scope', value.locator, value.digest).value, original.content);
  }
  now = 20;
  assert.equal(store.read('owner', 'scope', stored.locator, stored.digest).ok, false);
  const replacement = createContextArtifactStore();
  assert.equal(replacement.read('owner', 'scope', stored.locator, stored.digest).ok, false);
  const inherited = payload([previous(stored)]).evidenceReceipts[0];
  assert.equal(
    inherited.recovery,
    'read_context_artifact',
    'receipt directs only a read, not replay'
  );
  assert.ok(!JSON.stringify(inherited).includes('rerun'));
});

test('receipt-factory output cannot reintroduce replay hints in results or call receipts', () => {
  const call = {
    role: 'assistant',
    tool_calls: [{ id: original.tool_call_id, function: { name: original.name, arguments: '{}' } }],
  };
  const state = payload([call, original], { receiptFactory: () => receipt() });
  assert.equal(state.entries[0].callReceipt.recovery, unavailable);
  assert.equal(state.evidenceReceipts[0].recovery, unavailable);
  assert.ok(!JSON.stringify(state).includes('rerun_or_reread_original_tool'));
});

test('malformed, empty, extreme and accessor-bearing callback receipts cannot execute hooks', () => {
  let hooks = 0;
  const accessor = Object.defineProperty(receipt(), 'digest', { get: () => hooks++ });
  for (const value of [
    null,
    undefined,
    [],
    new Date(),
    {},
    receipt({ bytes: -1 }),
    receipt({ bytes: Number.MAX_SAFE_INTEGER + 1 }),
    receipt({ kind: 'unknown' }),
    receipt({ digest: 'invalid' }),
    accessor,
  ]) {
    assert.equal(payload([original], { receiptFactory: () => value }), null);
  }
  const withHooks = receipt();
  Object.defineProperty(withHooks, 'toJSON', { value: () => hooks++ });
  Object.defineProperty(withHooks, 'recovery', { get: () => hooks++ });
  assert.equal(
    payload([original], { receiptFactory: () => withHooks }).evidenceReceipts[0].recovery,
    unavailable
  );
  assert.equal(hooks, 0);
});

test('locator and scope boundaries never preserve an arbitrary recovery instruction', () => {
  for (const extra of [
    { locator: 'invalid', scope: 'scope' },
    { locator: 'hca_' + 'a'.repeat(32), scope: '' },
    { locator: 'hca_' + 'a'.repeat(32), scope: 's'.repeat(257) },
  ]) {
    const value = payload([previous(receipt(extra))]).evidenceReceipts[0];
    assert.equal(value.recovery, unavailable);
    assert.equal(value.locator, undefined);
  }
  const value = payload([
    previous(receipt({ locator: 'hca_' + 'a'.repeat(32), scope: 's'.repeat(256) })),
  ]).evidenceReceipts[0];
  assert.equal(value.recovery, 'read_context_artifact');
});

test('retention failures remain visible rather than being swallowed into misleading recovery hints', () => {
  const failure = new Error('synthetic retention failure');
  assert.throws(
    () =>
      createEvidenceReceipt(original, {
        artifactStore: {
          put() {
            throw failure;
          },
        },
        artifactOwner: 'owner',
        artifactScope: 'scope',
      }),
    (error) => error === failure
  );
});
