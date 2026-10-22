'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

// Child-process-only fault injection. Production receives the real artifact
// store and has no injectable model-facing payload provider or test controls.
const filename = require.resolve('../../lib/proxy/context-evidence-ledger');
const load = Module._load;
let fault = 'none';
let accesses = 0;
let failReadAt = null;
let api;
try {
  Module._load = function (request, parent, isMain) {
    const loaded = load.call(this, request, parent, isMain);
    if (parent?.filename !== filename || request !== './context-artifact-store') return loaded;
    return {
      ...loaded,
      createContextArtifactStore(options) {
        const store = loaded.createContextArtifactStore(options);
        return {
          ...store,
          read(...args) {
            accesses++;
            const result = store.read(...args);
            if (accesses === failReadAt) return { ok: false };
            if (fault === 'throw') throw new Error('synthetic-private-payload');
            if (fault === 'missing') return { ok: false };
            if (fault === 'type') return { ...result, value: {} };
            if (fault === 'bytes') return { ...result, bytes: result.bytes + 1 };
            if (fault === 'digest') return { ...result, digest: '0'.repeat(64) };
            if (fault === 'expiry') return { ...result, expiresAt: result.expiresAt + 1 };
            if (fault === 'content') return { ...result, value: 'x'.repeat(result.bytes) };
            return result;
          },
        };
      },
    };
  };
  api = require(filename);
} finally {
  Module._load = load;
}
const ledger = api.createContextEvidenceLedger({
  owner: 'owner',
  threadId: 'thread',
  now: () => 100,
});
try {
  ledger.capture({
    callId: 'call',
    toolName: 'lookup',
    arguments: {},
    completed: true,
    output: 'synthetic-private-payload',
  });
  for (fault of ['missing', 'type', 'bytes', 'digest', 'expiry', 'throw', 'content']) {
    const prior = accesses;
    const metadata = api.exportContextEvidenceMetadata(ledger);
    assert.equal(accesses, prior);
    assert.equal(metadata.kind, 'evidence-ledger-metadata');
    assert.equal(metadata.sources.length, 1);
    assert.equal(Object.hasOwn(metadata.sources[0], 'output'), false);
    assert.equal(Object.hasOwn(metadata.sources[0], 'locator'), false);
    metadata.sources[0].bytes++;
    assert.notEqual(
      api.exportContextEvidenceMetadata(ledger).sources[0].bytes,
      metadata.sources[0].bytes
    );
    const progress = api.exportContextEvidenceProgress(ledger);
    assert.equal(accesses, prior);
    assert.equal(progress.readCount, 0);
    assert.equal(progress.sources.length, 1);
    assert.deepEqual(Object.keys(progress.sources[0]).sort(), [
      'coveredThrough',
      'readComplete',
      'sourceId',
    ]);
    progress.sources[0].coveredThrough = 999;
    assert.equal(api.exportContextEvidenceProgress(ledger).sources[0].coveredThrough, 0);
    assert.throws(
      () => api.exportContextEvidenceLedger(ledger),
      (error) =>
        error.code === 'invalid_evidence_ledger_state' &&
        error.message === error.code &&
        error.cause === undefined
    );
    const resident = api.contextEvidenceResidency(ledger);
    assert.throws(() => api.evictContextEvidencePayloads(ledger, [metadata.sources[0].sourceId]), {
      code: 'invalid_evidence_ledger_state',
    });
    assert.deepEqual(api.contextEvidenceResidency(ledger), resident);
  }
  assert.equal(accesses, 14);
  fault = 'none';
  assert.equal(
    api.exportContextEvidenceLedger(ledger).sources[0].output,
    'synthetic-private-payload'
  );
  assert.equal(ledger.inspect().readCount, 0);
  ledger.capture({
    callId: 'second',
    toolName: 'lookup',
    arguments: {},
    completed: true,
    output: 'second-private',
  });
  const ids = api.exportContextEvidenceMetadata(ledger).sources.map((source) => source.sourceId);
  const residency = api.contextEvidenceResidency(ledger);
  failReadAt = accesses + 2;
  assert.throws(() => api.evictContextEvidencePayloads(ledger, ids), {
    code: 'invalid_evidence_ledger_state',
  });
  assert.deepEqual(api.contextEvidenceResidency(ledger), residency);
  failReadAt = null;
  api.evictContextEvidencePayloads(ledger, ids);
  assert.deepEqual(api.contextEvidenceResidency(ledger), {
    residentBytes: 0,
    residentEntries: 0,
    coldEntries: 2,
  });
} finally {
  ledger.close();
}

const sessionsApi = require('../../lib/proxy/context-recovery-sessions');
const { validateRecoveryRootMetadata } = require('../../lib/proxy/context-recovery-root-state');
const sessions = sessionsApi.createContextRecoverySessions({ now: () => 100 });
sessions.configure(true);
let owner;
try {
  const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
  const user = { role: 'user', content: 'synthetic' };
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  const root = sessions.begin({ ...binding, history: [user] });
  assert.equal(
    root.complete(
      [tool],
      [{ callId: 'call', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
      'first'
    ).ok,
    true
  );
  const view = sessions.begin(
    {
      ...binding,
      history: [
        user,
        tool,
        { role: 'tool', tool_call_id: 'call', content: 'synthetic-private-payload' },
      ],
    },
    [{ callId: 'call', output: 'synthetic-private-payload' }]
  );
  assert.equal(view.complete([{ role: 'assistant', content: 'done' }], [], 'second').ok, true);
  const pending = sessions.begin({ ...binding, history: [user], previousResponseId: 'second' });
  owner = sessionsApi.acquireContextRecoveryRoot(sessions, root.snapshotId);
  const full = owner.checkpoint(pending);
  for (fault of ['missing', 'type', 'bytes', 'digest', 'expiry', 'throw']) {
    const before = accesses;
    const metadata = validateRecoveryRootMetadata(owner.metadata(pending));
    assert.equal(
      metadata.metadata.ledger.sources[0].sourceId,
      full.root.ledger.sources[0].sourceId
    );
    assert.equal(accesses, before);
    assert.deepEqual(owner.payloads(pending, []), []);
    assert.equal(accesses, before);
    assert.throws(() => owner.payloads(pending, [full.root.ledger.sources[0].sourceId]));
    assert.equal(accesses, before + 1);
    assert.throws(() => owner.checkpoint(pending));
  }
  process.stdout.write('payload_faults_rejected_without_raw_fallback\n');
} finally {
  owner?.release();
  sessions.close();
}
