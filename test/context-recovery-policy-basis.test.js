'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { createContextRecoveryRuntime } = require('../lib/proxy/context-recovery-runtime');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  createRootCheckpoint,
  parseRootCheckpoint,
} = require('../lib/proxy/context-recovery-root-checkpoint');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
  exportContextRecoveryRoot,
  acquireContextRecoveryRoot,
  restoreContextRecoverySessions,
  adoptContextRecoveryRoots,
} = require('../lib/proxy/context-recovery-sessions');
const { fingerprintContextData } = require('../lib/proxy/context-recovery-fingerprint');
const { validateRecoveryRootPolicy } = require('../lib/proxy/context-recovery-root-policy');
const { legacyRecoveryRoot } = require('./helpers/recovery-retention-fixture.cjs');
const { loadDurableRecoveryRoot } = require('./helpers/recovery-durable-state.cjs');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const user = (content) => ({ role: 'user', content });
function metadata(sessions, rootId, capability) {
  const owner = acquireContextRecoveryRoot(sessions, rootId);
  try {
    return owner.metadata(capability).metadata;
  } finally {
    owner.release();
  }
}
const policy = {
  instructions: 'stable',
  system: null,
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
  toolChoice: null,
};
const omitted = { ...policy, tools: null };
const original = '新建策略恢复证据🙂\r\nexact';
const call = {
  type: 'function_call',
  id: 'fc-original',
  call_id: 'original',
  name: 'lookup',
  arguments: '{}',
};
const answer = [
  {
    type: 'message',
    id: 'msg-done',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'done' }],
  },
];
const canonical = {
  id: 'compact-fixture',
  object: 'response.compaction',
  created_at: 1,
  output: [
    user('retained'),
    {
      type: 'compaction',
      id: 'opaque-fixture',
      encrypted_content: 'synthetic-provider-opaque',
      extra: { preserved: true },
    },
  ],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
};
const binding = { principal: 'owner', protocol: 'responses', target: 'target' };
function disk() {
  const database = new DatabaseSync(':memory:');
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  return {
    engine,
    close() {
      engine.close();
      database.close();
    },
  };
}
function owner(storage, now = () => 100) {
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  attachContextRecoveryStorage(sessions, storage);
  return sessions;
}
async function seed(storage, selectedPolicy = policy, question = 'question', now = () => 100) {
  const sessions = owner(storage, now);
  try {
    const history = [user(question)];
    const root = sessions.begin({ ...binding, policy: selectedPolicy, history });
    assert.equal(
      (
        await root.completeObservedAsync(
          [call],
          [{ callId: 'original', toolName: 'lookup', arguments: {}, output: '', completed: true }]
        )
      ).ok,
      true
    );
    const captured = [
      ...history,
      call,
      { type: 'function_call_output', call_id: 'original', output: original },
    ];
    const child = sessions.begin({ ...binding, policy: selectedPolicy, history: captured }, [
      { callId: 'original', output: original },
    ]);
    const index = JSON.parse((await child.replyAsync(LIST, {})).text);
    assert.equal((await child.completeObservedAsync(answer)).ok, true);
    const state = await loadDurableRecoveryRoot(storage, root.snapshotId);
    return { state, history: [...captured, ...answer], receipt: index.sources[0] };
  } finally {
    await sessions.shutdownAsync();
  }
}

test('offline compact requests that omit generation tools use a verified original policy and retain canonical continuation', async () => {
  const d = disk();
  const f = await seed(d.engine);
  const sessions = owner(d.engine);
  try {
    const compact = await sessions.beginAsync(
      { ...binding, policy: omitted, history: f.history },
      [],
      () => true,
      true
    );
    assert.equal(compact.ok, true);
    assert.equal(compact.reason, 'observed_continuation');
    assert.equal((await compact.completeCompactionAsync(canonical)).ok, true);
    assert.equal((await compact.startPublicationAsync()).ok, true);
    assert.equal((await compact.finishPublicationAsync()).ok, true);
    const next = await sessions.beginAsync(
      { ...binding, policy, history: [...canonical.output, user('continue')] },
      [],
      () => true
    );
    assert.equal(next.ok, true);
    assert.equal(next.reason, 'observed_continuation');
    const read = await next.replyAsync(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    });
    assert.equal(read.ok, true);
    assert.equal(JSON.parse(read.text).page.text, original);
    const restored = metadata(sessions, f.state.rootId, next);
    assert.equal(restored.expiresAt, f.state.expiresAt);
    assert.equal(restored.budget.calls, f.state.budget.calls + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.policyBasis)), policy);
    assert.deepEqual(canonical.output[1].extra, { preserved: true });
  } finally {
    await sessions.shutdownAsync();
    d.close();
  }
});

test('versioned roots bind the complete original policy; legacy roots require a current matching policy before upgrade', async () => {
  const d = disk();
  const f = await seed(d.engine);
  let restored;
  try {
    assert.equal(f.state.version, 10);
    assert.equal(validateRecoveryRootPolicy(f.state), 10);
    assert.equal(fingerprintContextData(f.state.policyBasis), f.state.policyFingerprint);
    const legacy = legacyRecoveryRoot(f.state, 1);
    assert.equal(validateRecoveryRootPolicy(legacy), 1);
    const request = { ...binding, policy, history: f.history };
    restored = restoreContextRecoverySessions({ now: () => 100 }, [
      { binding: request, state: legacy },
    ]);
    const upgraded = exportContextRecoveryRoot(restored, f.state.rootId);
    const expected = legacyRecoveryRoot(f.state);
    expected.version = 6;
    expected.binding.format = 2;
    for (const snapshot of expected.binding.snapshots)
      snapshot.window = { kind: 'unavailable', count: null };
    for (const snapshot of expected.snapshots) {
      snapshot.pendingResults = [];
      snapshot.pendingReady = true;
      snapshot.privateHistoryComplete = false;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(upgraded)), expected);
    assert.throws(() =>
      restoreContextRecoverySessions({ now: () => 100 }, [
        { binding: { ...request, policy: omitted }, state: legacy },
      ])
    );
    const record = createRootCheckpoint(legacy, [], []);
    assert.doesNotThrow(() => parseRootCheckpoint(record, upgraded));
    assert.equal(record.root.version, 1);
  } finally {
    await restored?.shutdownAsync();
    d.close();
  }
});

test(
  'real encrypted runtime reopen restores omitted-policy compaction and exact canonical continuation',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-policy-reopen-'));
    let storage, runtime;
    try {
      const storePath = path.join(directory, 'context-recovery-v1');
      storage = await openContextRecoveryStorage({ directory: storePath });
      const f = await seed(storage, policy, 'question', Date.now);
      await storage.close();
      storage = undefined;
      assert.equal(
        fs.readFileSync(path.join(storePath, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
      runtime = createContextRecoveryRuntime({ dataDirectory: directory });
      runtime.configureSettings({
        appSettings: { contextRecoveryEnabled: true, contextRecoveryPersistenceEnabled: true },
      });
      assert.deepEqual(await runtime.ready(), { ok: true });
      assert.equal(runtime.sessions.inspect().roots, 0);
      const compact = await runtime.sessions.beginAsync(
        { ...binding, policy: omitted, history: f.history },
        [],
        () => true,
        true
      );
      assert.equal(compact.ok, true);
      assert.equal(compact.reason, 'observed_continuation');
      const imported = metadata(runtime.sessions, f.state.rootId, compact);
      assert.equal(imported.expiresAt, f.state.expiresAt);
      assert.deepEqual(imported.budget, f.state.budget);
      assert.equal((await compact.completeCompactionAsync(canonical)).ok, true);
      assert.equal((await compact.startPublicationAsync()).ok, true);
      assert.equal((await compact.finishPublicationAsync()).ok, true);
      const next = await runtime.sessions.beginAsync(
        { ...binding, policy, history: [...canonical.output, user('continue')] },
        [],
        () => true
      );
      assert.equal(next.ok, true);
      assert.equal(next.reason, 'observed_continuation');
      const read = await next.replyAsync(READ, {
        sourceId: f.receipt.sourceId,
        digest: f.receipt.digest,
      });
      assert.equal(read.ok, true);
      assert.equal(JSON.parse(read.text).page.text, original);
      const final = metadata(runtime.sessions, f.state.rootId, next);
      assert.equal(final.expiresAt, f.state.expiresAt);
      assert.equal(final.budget.calls, f.state.budget.calls + 1);
    } finally {
      await runtime?.shutdownAsync();
      await storage?.close();
      const targetPath = path.resolve(directory);
      assert.equal(path.dirname(targetPath), path.resolve(os.tmpdir()));
      assert.ok(path.basename(targetPath).startsWith('hpm-policy-reopen-'));
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  }
);

test('legacy disk records still restore ordinary exact-policy requests and never guess an omitted policy', async () => {
  const d = disk();
  const source = disk();
  let f, publications;
  try {
    f = await seed(source.engine);
    const scope = createHash('sha256')
      .update('hpm/recovery-root/v1\0' + f.state.rootId)
      .digest('hex');
    publications = source.engine.execute({ operation: 'load', scope }).state.publications;
  } finally {
    source.close();
  }
  const legacy = legacyRecoveryRoot(f.state, 1);
  d.engine.execute({
    operation: 'save',
    scope: createHash('sha256')
      .update('hpm/recovery-root/v1\0' + legacy.rootId)
      .digest('hex'),
    expectedRevision: 0,
    expiresAt: legacy.expiresAt,
    state: createRootCheckpoint(legacy, [], publications),
  });
  const storage = d.engine;
  const compactOwner = owner(storage),
    ordinaryOwner = owner(storage);
  try {
    const compact = await compactOwner.beginAsync(
      { ...binding, policy: omitted, history: f.history },
      [],
      () => true,
      true
    );
    assert.equal(compact.ok, false);
    assert.equal(compactOwner.inspect().roots, 0);
    const current = await ordinaryOwner.beginAsync(
      { ...binding, policy, history: [...f.history, user('continue')] },
      [],
      () => true
    );
    assert.equal(current.ok, true);
    assert.equal(current.reason, 'observed_continuation');
    assert.deepEqual(
      metadata(ordinaryOwner, f.state.rootId, current).policyBasis,
      f.state.policyBasis
    );
  } finally {
    await compactOwner.shutdownAsync();
    await ordinaryOwner.shutdownAsync();
    d.close();
  }
});

test('different generation policies join the same compact frontier; neither offline nor online candidates hide ambiguity', async () => {
  const d = disk();
  const f = await seed(d.engine);
  await seed(d.engine, {
    ...policy,
    tools: [{ ...policy.tools[0], parameters: { type: 'object', additionalProperties: false } }],
  });
  const sessions = owner(d.engine);
  try {
    const request = { ...binding, policy: omitted, history: f.history };
    const before = sessions.inspect();
    const ambiguous = await sessions.beginAsync(request, [], () => true, true);
    assert.deepEqual(ambiguous, { ok: false, code: 'context_binding_compaction_ambiguous' });
    assert.deepEqual(sessions.inspect(), before);
    adoptContextRecoveryRoots(sessions, [
      { binding: { ...binding, policy, history: f.history }, state: f.state },
    ]);
    assert.deepEqual(await sessions.beginAsync(request, [], () => true, true), ambiguous);
    assert.equal(sessions.inspect().roots, 1);
    assert.deepEqual(exportContextRecoveryRoot(sessions, f.state.rootId).budget, f.state.budget);
  } finally {
    await sessions.shutdownAsync();
    d.close();
  }
});

test('restoration policy is only a validation basis; changed instructions, current explicit tools and identity still constrain selection', async () => {
  const d = disk();
  const f = await seed(d.engine);
  const sessions = owner(d.engine);
  const request = { ...binding, policy: omitted, history: f.history };
  try {
    for (const patch of [
      { principal: 'different' },
      { target: 'different' },
      { history: [] },
      { policy: { ...omitted, instructions: 'different' } },
      { policy: { ...omitted, system: 'different' } },
    ]) {
      const result = await sessions.beginAsync({ ...request, ...patch }, [], () => true, true);
      assert.deepEqual(result, { ok: false, code: 'context_binding_compaction_unobserved' });
      assert.equal(sessions.inspect().roots, 0);
    }
    const conflict = await sessions.beginAsync(
      { ...request, policy: { ...policy, tools: [] } },
      [],
      () => true,
      true
    );
    assert.deepEqual(conflict, { ok: false, code: 'context_binding_compaction_policy_conflict' });
    assert.equal(sessions.inspect().roots, 0);
  } finally {
    await sessions.shutdownAsync();
    d.close();
  }
});

test('tampered or mismatched policy bases are rejected even after recomputing the checkpoint digest', async () => {
  const d = disk();
  const f = await seed(d.engine);
  try {
    for (const mutation of [
      (root) => {
        root.policyBasis.instructions = 'tampered';
      },
      (root) => {
        delete root.policyBasis;
      },
      (root) => {
        root.version = 1;
      },
      (root) => {
        root.version = 4;
      },
      (root) => {
        root.policyBasis = { ...policy, tools: [] };
        root.policyFingerprint = fingerprintContextData(root.policyBasis);
      },
    ]) {
      const sessions = owner({
        execute(command) {
          const reply = d.engine.execute(command);
          if (command.operation === 'load') {
            const root = globalThis.structuredClone(reply.state.root);
            mutation(root);
            reply.state = createRootCheckpoint(
              root,
              reply.state.stagedSources,
              reply.state.publications
            );
          }
          return reply;
        },
      });
      try {
        const result = await sessions.beginAsync(
          { ...binding, policy: omitted, history: f.history },
          [],
          () => true,
          true
        );
        assert.deepEqual(result, { ok: false, code: 'context_recovery_storage_unavailable' });
        assert.equal(sessions.inspect().roots, 0);
      } finally {
        await sessions.shutdownAsync();
      }
    }
  } finally {
    d.close();
  }
});

test('policy schema rejects accessors, excessive policy bytes and unknown fields without executing input code', async () => {
  const d = disk();
  const f = await seed(d.engine);
  let ran = 0;
  try {
    const accessor = globalThis.structuredClone(f.state);
    Object.defineProperty(accessor, 'policyBasis', {
      enumerable: true,
      get() {
        ran++;
        return policy;
      },
    });
    assert.throws(() => validateRecoveryRootPolicy(accessor), {
      code: 'context_recovery_storage_unavailable',
    });
    assert.throws(() => createRootCheckpoint(accessor, []), {
      code: 'context_recovery_storage_unavailable',
    });
    const huge = globalThis.structuredClone(f.state);
    huge.policyBasis = { instructions: 'x'.repeat(2 * 1024 * 1024) };
    assert.throws(() => validateRecoveryRootPolicy(huge), {
      code: 'context_recovery_storage_unavailable',
    });
    assert.throws(() => validateRecoveryRootPolicy({ ...f.state, unexpected: true }), {
      code: 'context_recovery_storage_unavailable',
    });
    for (const value of [
      null,
      [],
      {},
      { version: 2 },
      { version: 0 },
      { version: 3 },
      { version: '2' },
      { ...f.state, version: 4 },
      Object.create(null),
      new Date(),
    ])
      assert.throws(() => validateRecoveryRootPolicy(value), {
        code: 'context_recovery_storage_unavailable',
      });
    for (const mode of [
      'index-accessor',
      'method-accessor',
      'extra-property',
      'sparse',
      'readiness-accessor',
    ]) {
      const nested = globalThis.structuredClone(f.state);
      nested.version = 8;
      nested.snapshots = nested.snapshots.map((view) => ({
        ...view,
        pendingResults: [],
        pendingReady: true,
      }));
      const view = nested.snapshots[0];
      if (mode === 'index-accessor')
        Object.defineProperty(nested.snapshots, '0', {
          enumerable: true,
          get() {
            ran++;
            return view;
          },
        });
      if (mode === 'method-accessor')
        Object.defineProperty(nested.snapshots, 'some', {
          get() {
            ran++;
            return Array.prototype.some;
          },
        });
      if (mode === 'extra-property') nested.snapshots.extra = true;
      if (mode === 'sparse') delete nested.snapshots[0];
      if (mode === 'readiness-accessor')
        Object.defineProperty(view, 'pendingReady', {
          enumerable: true,
          get() {
            ran++;
            return true;
          },
        });
      assert.throws(() => validateRecoveryRootPolicy(nested), {
        code: 'context_recovery_storage_unavailable',
      });
    }
    assert.equal(ran, 0);
  } finally {
    d.close();
  }
});

test('original policy is retained only in owner state, not in evidence descriptions or read envelopes', async () => {
  const d = disk();
  const confidentialPolicy = { ...policy, instructions: 'synthetic-instruction-never-in-evidence' };
  const f = await seed(d.engine, confidentialPolicy);
  const sessions = owner(d.engine);
  try {
    const current = await sessions.beginAsync(
      { ...binding, policy: { ...confidentialPolicy, tools: null }, history: f.history },
      [],
      () => true,
      true
    );
    assert.equal(current.ok, true);
    const read = await current.replyAsync(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    });
    assert.equal(read.ok, true);
    assert.equal(JSON.parse(read.text).page.text, original);
    assert.equal(JSON.stringify(read).includes(confidentialPolicy.instructions), false);
    const scope = createHash('sha256')
      .update('hpm/recovery-root/v1\0' + f.state.rootId)
      .digest('hex');
    const stored = d.engine.execute({ operation: 'load', scope });
    assert.equal(stored.state.root.version, 10);
    assert.equal(stored.state.root.policyBasis.instructions, confidentialPolicy.instructions);
  } finally {
    await sessions.shutdownAsync();
    d.close();
  }
});
