'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRecoveryRootOwner } = require('../lib/proxy/context-recovery-root-owner');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { recoverySqliteFaults } = require('./helpers/recovery-sqlite-fault.cjs');
const { storageRequest } = require('../lib/proxy/context-recovery-storage-contract');
const {
  createRootCheckpoint,
  parseRootCheckpoint,
} = require('../lib/proxy/context-recovery-root-checkpoint');
const { validateRecoveryRootMetadata } = require('../lib/proxy/context-recovery-root-state');
const {
  parseReaderSettlement,
  applyReaderSettlement,
} = require('../lib/proxy/context-recovery-reader-settlement');
const {
  createReferenceWrite,
  materializeReferenceWrite,
  parseReferenceCheckpoint,
  parseReferencePayloads,
} = require('../lib/proxy/context-recovery-reference-write');
const { fingerprintContextData } = require('../lib/proxy/context-recovery-fingerprint');
const { createReferenceState } = require('../lib/proxy/context-recovery-reference-state');
const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
const {
  createRecoveryDurableAck,
  acknowledgedRecoverySources,
} = require('../lib/proxy/context-recovery-durable-ack');
const {
  createContextRecoverySessions,
  acquireContextRecoveryRoot,
  exportContextRecoveryRoot,
  exportContextRecoveryRootMetadata,
  attachContextRecoveryReaderStorage,
  restoreContextRecoverySessions,
} = require('../lib/proxy/context-recovery-sessions');
const {
  createContextEvidenceTools,
  createContextEvidenceBudget,
  restoreContextEvidenceBudget,
  exportContextEvidenceBudget,
  reserveContextEvidenceBudget,
  readContextEvidenceReservation,
  exportContextEvidenceReservation,
  settleContextEvidenceReservation,
  abandonContextEvidenceReservation,
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const unavailable = { code: 'context_recovery_root_unavailable' };
const badBudget = { code: 'invalid_evidence_budget_state' };
const user = (content) => ({ role: 'user', content });
const exact = '原文\r\nélève🙂';
const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
const request = (history = [user('q')], extra = {}) => ({ ...binding, history, ...extra });
const tool = {
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: 'source-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
  ],
};
function fixture(output = exact, policy) {
  let time = 100;
  const scoped = (history, extra = {}) =>
    request(history, {
      ...(policy === undefined ? {} : { policy }),
      ...extra,
    });
  const runtime = createContextRecoverySessions({ now: () => time });
  runtime.configure(true);
  const root = runtime.begin(scoped());
  assert.equal(
    root.complete(
      [tool],
      [{ callId: 'source-call', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
      'call-response'
    ).ok,
    true
  );
  const captured = runtime.begin(
    scoped([user('q'), tool, { role: 'tool', tool_call_id: 'source-call', content: output }]),
    [{ callId: 'source-call', output }]
  );
  assert.equal(
    captured.complete([{ role: 'assistant', content: 'ready' }], [], 'source-response').ok,
    true
  );
  const view = runtime.begin(scoped([user('read')], { previousResponseId: 'source-response' }));
  const receipt = exportContextRecoveryRoot(runtime, root.snapshotId).ledger.sources[0];
  return {
    runtime,
    root,
    captured,
    view,
    receipt,
    args: { sourceId: receipt.sourceId, digest: receipt.digest },
    acquire: () => acquireContextRecoveryRoot(runtime, root.snapshotId),
    advance: (value) => {
      time = value;
    },
  };
}
function readers(budget, overrides = {}) {
  let reads = 0;
  const tools = createContextEvidenceTools(
    {
      list: () => ({ ok: true, sources: [], nextAfterSourceId: null }),
      read: () => {
        reads++;
        return { ok: false, error: 'context_evidence_unavailable' };
      },
      ...overrides,
    },
    budget
  );
  return { tools, reads: () => reads };
}

const reference = (state) => createReferenceState(state.metadata, state.stagedSources);
const ackInvalid = { code: 'context_recovery_durable_ack_invalid' };

test('durable acknowledgements are opaque, bounded and reject unsafe inputs and forged tokens', () => {
  const f = fixture();
  const owner = f.acquire();
  let effects = 0;
  try {
    const current = owner.metadata(f.view);
    const state = reference(current);
    const ack = createRecoveryDurableAck(state, 1);
    assert.deepEqual(Reflect.ownKeys(ack), []);
    assert.equal(Object.isFrozen(ack), true);
    assert.equal(JSON.stringify(ack), '{}');
    assert.deepEqual(acknowledgedRecoverySources(ack, current), [f.receipt.sourceId]);
    for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])
      assert.throws(() => createRecoveryDurableAck(state, revision), ackInvalid);
    for (const token of [null, undefined, 1, {}, globalThis.structuredClone(ack)])
      assert.throws(() => owner.evictPersisted(f.view, token), ackInvalid);
    assert.throws(
      () =>
        createRecoveryDurableAck(
          {
            get metadata() {
              effects++;
              return current.metadata;
            },
          },
          1
        ),
      ackInvalid
    );
    assert.throws(
      () =>
        acknowledgedRecoverySources(ack, {
          get metadata() {
            effects++;
            return current.metadata;
          },
        }),
      ackInvalid
    );
    assert.equal(effects, 0);
    assert.equal(owner.checkpoint(f.view).root.ledger.sources[0].output, exact);
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('the distinct root metadata exporter preserves lease, lifecycle and input boundaries', () => {
  const f = fixture();
  const owner = f.acquire();
  try {
    const expected = owner.metadata(f.view);
    assert.throws(() => exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId));
    owner.release();
    assert.deepEqual(exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId), expected);
    for (const runtime of [null, {}, undefined])
      assert.throws(() => exportContextRecoveryRootMetadata(runtime, f.root.snapshotId));
    let effects = 0;
    for (const id of [
      null,
      '',
      'x'.repeat(10000),
      {
        get rootId() {
          effects++;
          return f.root.snapshotId;
        },
      },
    ])
      assert.throws(() => exportContextRecoveryRootMetadata(f.runtime, id));
    assert.equal(effects, 0);
    f.runtime.configure(false);
    assert.throws(() => exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId));
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('acknowledged source identities and root association are checked before any eviction', () => {
  const f = fixture(),
    other = fixture();
  const owner = f.acquire(),
    otherOwner = other.acquire();
  try {
    assert.throws(
      () =>
        owner.evictPersisted(
          f.view,
          createRecoveryDurableAck(reference(otherOwner.metadata(other.view)), 1)
        ),
      ackInvalid
    );
    for (const key of ['digest', 'bytes', 'toolName', 'argumentsDigest']) {
      const state = globalThis.structuredClone(owner.metadata(f.view));
      // Change the stored identity and its graph consistently where required.
      // Digest/argument digest remain structurally legal but cannot replace the live bytes.
      const source = state.metadata.ledger.sources[0];
      if (key === 'digest') source.digest = '0'.repeat(64);
      else if (key === 'bytes') source.bytes++;
      else if (key === 'argumentsDigest') {
        source.argumentsDigest = '0'.repeat(64);
        for (const snapshot of state.metadata.snapshots)
          for (const call of snapshot.calls) call.argumentsDigest = source.argumentsDigest;
      } else if (key === 'toolName') {
        source.toolName = 'other';
        for (const snapshot of state.metadata.snapshots)
          for (const call of snapshot.calls) call.toolName = source.toolName;
      }
      const ack = createRecoveryDurableAck(reference(state), 1);
      assert.throws(() => owner.evictPersisted(f.view, ack), ackInvalid);
      assert.equal(owner.checkpoint(f.view).root.ledger.sources[0].output, exact);
    }
    assert.throws(
      () =>
        owner.evictPersisted({}, createRecoveryDurableAck(reference(owner.metadata(f.view)), 1)),
      unavailable
    );
    assert.equal(owner.checkpoint(f.view).root.ledger.sources[0].output, exact);
  } finally {
    owner.release();
    otherOwner.release();
    f.runtime.close();
    other.runtime.close();
  }
});

test('durable root admission pins the history format before any first write', async () => {
  const f = fixture();
  const database = new DatabaseSync(':memory:');
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  try {
    const current = exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId);
    for (const initialFormat of [2, 3]) {
      const service = createRecoveryRootStorage(engine);
      try {
        const first = globalThis.structuredClone(current);
        first.metadata.binding.format = initialFormat;
        const state = reference(first);
        await service.begin(state, () => []);
        const changed = globalThis.structuredClone(first);
        changed.metadata.binding.format = initialFormat === 2 ? 3 : 2;
        await assert.rejects(
          service.begin(reference(changed), () => []),
          { code: 'context_recovery_storage_unavailable' }
        );
        await service.begin(state, () => []);
      } finally {
        service.close();
      }
    }
  } finally {
    f.runtime.close();
    engine.close();
    database.close();
  }
});

test('a real SQLite save ACK evicts resident originals while retaining metadata and exact async reads', async () => {
  const f = fixture();
  const database = new DatabaseSync(':memory:');
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const transactions = createRecoveryRootStorage(engine);
  const owner = f.acquire();
  try {
    const before = owner.metadata(f.view);
    const state = reference(before);
    const tx = await transactions.begin(state, (ids) => owner.payloads(f.view, ids));
    const ack = await tx.save(state);
    owner.evictPersisted(f.view, ack);
    owner.evictPersisted(f.view, ack);
    assert.deepEqual(owner.metadata(f.view), before);
    assert.throws(() => owner.checkpoint(f.view));
    assert.throws(() => owner.payloads(f.view, [f.receipt.sourceId]));
    owner.release();
    assert.deepEqual(exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId), before);
    attachContextRecoveryReaderStorage(f.runtime, engine);
    const reply = await f.view.replyAsync(READ, f.args);
    assert.equal(reply.ok, true);
    assert.equal(JSON.parse(reply.text).page.text, exact);
    assert.equal(
      exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId).metadata.expiresAt,
      before.metadata.expiresAt
    );
  } finally {
    owner.release();
    await f.runtime.shutdownAsync();
    transactions.close();
    engine.close();
    database.close();
  }
});

test('stale ACKs release only their unchanged sources and retain later captures', () => {
  const f = fixture();
  let owner = f.acquire();
  try {
    const ack = createRecoveryDurableAck(reference(owner.metadata(f.view)), 1);
    owner.release();
    const nextTool = globalThis.structuredClone(tool);
    nextTool.tool_calls[0].id = 'new-call';
    assert.equal(
      f.view.complete(
        [nextTool],
        [{ callId: 'new-call', toolName: 'lookup', arguments: {}, output: '', completed: true }],
        'new-response'
      ).ok,
      true
    );
    const next = f.runtime.begin(
      request([user('new result')], { previousResponseId: 'new-response' }),
      [{ callId: 'new-call', output: 'new original' }]
    );
    assert.equal(next.ok, true);
    owner = f.acquire();
    const before = owner.metadata(next);
    const added = before.stagedSources.find((source) => source.sourceId !== f.receipt.sourceId);
    assert.ok(added);
    owner.evictPersisted(next, ack);
    assert.deepEqual(owner.metadata(next), before);
    assert.deepEqual(owner.payloads(next, [added.sourceId]), [
      { sourceId: added.sourceId, output: 'new original' },
    ]);
    assert.throws(() => owner.payloads(next, [f.receipt.sourceId]));
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('late durable ACKs cannot revive a released, aborted, revoked, closed or expired capability', () => {
  for (const mode of ['release', 'abort', 'revoke', 'close', 'expiry']) {
    const f = fixture();
    const owner = f.acquire();
    const ack = createRecoveryDurableAck(reference(owner.metadata(f.view)), 1);
    try {
      if (mode === 'release') owner.release();
      if (mode === 'abort') f.view.abort();
      if (mode === 'revoke') f.runtime.revoke('owner');
      if (mode === 'close') f.runtime.close();
      if (mode === 'expiry') f.advance(f.receipt.expiresAt);
      assert.throws(() => owner.evictPersisted(f.view, ack), unavailable);
      if (mode === 'release')
        assert.equal(
          exportContextRecoveryRoot(f.runtime, f.root.snapshotId).ledger.sources[0].output,
          exact
        );
    } finally {
      owner.release();
      f.runtime.close();
    }
  }
});

test('owner selected payload export requires its live capability and lease and preserves budget', () => {
  const f = fixture();
  const owner = f.acquire();
  try {
    const before = owner.metadata(f.view);
    assert.deepEqual(owner.payloads(f.view, [f.receipt.sourceId]), [
      { sourceId: f.receipt.sourceId, output: exact },
    ]);
    assert.deepEqual(owner.payloads(f.view, []), []);
    assert.throws(() => owner.payloads({}, []), unavailable);
    assert.throws(() => owner.payloads(undefined, []), unavailable);
    assert.deepEqual(owner.metadata(f.view), before);
    owner.release();
    assert.throws(() => owner.payloads(f.view, []), unavailable);
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('owner exports metadata-only reader settlement and applies it without changing root authority or lifetime', () => {
  for (const name of [READ, LIST]) {
    const f = fixture();
    const owner = f.acquire();
    try {
      owner.assertReader(f.view);
      assert.throws(() => owner.assertReader({}), unavailable);
      const reservation = owner.reserveBudget();
      const before = owner.checkpoint(f.view);
      assert.throws(() => owner.readerSettlement(f.view, reservation), badBudget);
      assert.throws(() => owner.readerSettlement(f.view, {}), unavailable);
      const result = owner.replyReserved(f.view, reservation, name, name === READ ? f.args : {});
      assert.equal(result.ok, true);
      const delta = owner.readerSettlement(f.view, reservation);
      assert.equal(delta.version, 2);
      assert.equal(delta.ledger.sources.length, name === READ ? 1 : 0);
      const expected = owner.checkpoint(f.view, reservation);
      const applied = applyReaderSettlement(before, delta);
      assert.deepEqual(applied, expected);
      assert.equal(JSON.stringify(delta).includes(exact), false);
      assert.equal(applied.root.expiresAt, before.root.expiresAt);
      assert.deepEqual(applied.root.snapshots, before.root.snapshots);
      assert.deepEqual(applied.root.binding, before.root.binding);
      assert.equal(applied.root.ledger.sources[0].output, exact);
      delta.ledger.sources.push({
        sourceId: f.receipt.sourceId,
        coveredThrough: 0,
        readComplete: false,
      });
      assert.deepEqual(owner.checkpoint(f.view, reservation), expected);
      owner.release();
      assert.throws(() => owner.readerSettlement(f.view, reservation), unavailable);
    } finally {
      owner.release();
      f.runtime.close();
    }
  }
});

for (const version of [1, 2])
  test(`reader settlement v${version} rejects forged authority, unsafe data, counter rollback and invalid source progress`, () => {
    const f = fixture();
    const owner = f.acquire();
    const clone = (value) => globalThis.structuredClone(value);
    const failure = { code: 'invalid_recovery_reader_settlement' };
    let invoked = 0;
    try {
      const reservation = owner.reserveBudget();
      const before = owner.checkpoint(f.view);
      owner.replyReserved(f.view, reservation, READ, f.args);
      const delta = { ...owner.readerSettlement(f.view, reservation), version };
      for (const mutate of [
        (v) => {
          v.rootId = 'hbs_' + 'f'.repeat(32);
        },
        (v) => {
          v.observedAt = 99;
        },
        (v) => {
          v.observedAt = before.root.expiresAt;
        },
        (v) => {
          v.budget.calls++;
        },
        (v) => {
          v.budget.successfulReads = 2;
        },
        (v) => {
          v.budget.returnedBytes = before.root.budget.returnedBytes + 1;
        },
        (v) => {
          v.ledger.readCount = 2;
        },
        (v) => {
          v.ledger.readCount = 0;
        },
        ...(version === 1
          ? [
              (v) => {
                v.ledger.sources = [];
              },
            ]
          : []),
        (v) => {
          v.ledger.sources[0].sourceId = 'hce_' + 'f'.repeat(32);
        },
        (v) => {
          v.ledger.sources[0].coveredThrough = 1;
          v.ledger.sources[0].readComplete = false;
        },
        (v) => {
          v.ledger.sources[0].coveredThrough = 100000;
        },
        (v) => {
          v.ledger.sources[0].readComplete = false;
        },
        (v) => {
          v.ledger.sources.push({ ...v.ledger.sources[0] });
        },
      ]) {
        const value = clone(delta);
        mutate(value);
        assert.throws(() => applyReaderSettlement(before, value), failure);
      }
      for (const value of [
        null,
        [],
        {},
        { ...delta, version: 3 },
        { ...delta, output: exact },
        { ...delta, observedAt: Infinity },
        { ...delta, ledger: { ...delta.ledger, sources: Array(65).fill(delta.ledger.sources[0]) } },
        { ...delta, budget: { ...delta.budget, returnedBytes: -1 } },
        {
          ...delta,
          ledger: { ...delta.ledger, sources: [{ ...delta.ledger.sources[0], output: exact }] },
        },
        {
          ...delta,
          get rootId() {
            invoked++;
            return delta.rootId;
          },
        },
        {
          ...delta,
          toJSON() {
            invoked++;
            return {};
          },
        },
        Object.create(delta),
      ])
        assert.throws(() => parseReaderSettlement(value), failure);
      assert.throws(
        () =>
          applyReaderSettlement(
            {
              get root() {
                invoked++;
                return before.root;
              },
            },
            delta
          ),
        failure
      );
      assert.equal(invoked, 0);
    } finally {
      owner.release();
      f.runtime.close();
    }
  });

test('actual encrypted reader settlement preserves blob ciphertext, CAS, authority and original expiry', () => {
  const f = fixture(),
    owner = f.acquire(),
    database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64'),
    scope = 'a'.repeat(64);
  let time = 100;
  let storage = createRecoverySqliteStore({ database, dataKey, now: () => time });
  try {
    const reservation = owner.reserveBudget();
    const before = owner.checkpoint(f.view);
    storage.execute({
      operation: 'save',
      scope,
      expectedRevision: 0,
      expiresAt: before.root.expiresAt,
      state: before,
    });
    owner.replyReserved(f.view, reservation, READ, f.args);
    const settlement = owner.readerSettlement(f.view, reservation);
    const request = { operation: 'settle-reader', scope, expectedRevision: 1, settlement };
    const original = Buffer.from(
      database.prepare('SELECT envelope FROM recovery_blob').get().envelope
    );
    for (const change of [
      { expectedRevision: 0 },
      { expectedRevision: 2 },
      { scope: 'b'.repeat(64) },
      { settlement: { ...settlement, observedAt: 101 } },
      { settlement: { ...settlement, rootId: 'hbs_' + 'f'.repeat(32) } },
      { output: exact },
      { expectedRevision: Number.MAX_SAFE_INTEGER },
    ])
      assert.throws(() => storage.execute({ ...request, ...change }));
    assert.equal(storage.execute({ operation: 'load', scope }).revision, 1);
    assert.equal(storageRequest(request).settlement.kind, 'recovery-reader-settlement');
    assert.deepEqual(storage.execute(request), { revision: 2 });
    assert.throws(() => storage.execute(request));
    assert.deepEqual(
      Buffer.from(database.prepare('SELECT envelope FROM recovery_blob').get().envelope),
      original
    );
    storage.close();
    time = 200;
    storage = createRecoverySqliteStore({ database, dataKey, now: () => time });
    const restored = storage.execute({ operation: 'load', scope });
    assert.deepEqual(restored.state, owner.checkpoint(f.view, reservation));
    assert.equal(restored.expiresAt, before.root.expiresAt);
    assert.equal(restored.state.root.ledger.sources[0].output, exact);
    assert.deepEqual(storage.execute({ operation: 'revoke', scope, expectedRevision: 2 }), {
      revision: 3,
    });
    assert.throws(() => storage.execute({ ...request, expectedRevision: 3 }));
    assert.equal(storage.execute({ operation: 'load', scope }), null);
  } finally {
    owner.release();
    f.runtime.close();
    storage.close();
    database.close();
  }
});

test('reader settlement rolls back actual post-write failure and preserves the durable reservation', () => {
  const f = fixture(),
    owner = f.acquire(),
    database = new DatabaseSync(':memory:');
  let fault = false;
  const storage = createRecoverySqliteStore({
    database: recoverySqliteFaults(database, (sql) => {
      if (fault && sql.startsWith('INSERT INTO recovery_state'))
        throw new Error('synthetic post-write fault');
    }),
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const scope = 'a'.repeat(64);
  try {
    const reservation = owner.reserveBudget();
    const before = owner.checkpoint(f.view);
    storage.execute({
      operation: 'save',
      scope,
      expectedRevision: 0,
      expiresAt: before.root.expiresAt,
      state: before,
    });
    owner.replyReserved(f.view, reservation, READ, f.args);
    const request = {
      operation: 'settle-reader',
      scope,
      expectedRevision: 1,
      settlement: owner.readerSettlement(f.view, reservation),
    };
    fault = true;
    assert.throws(() => storage.execute(request), { code: 'context_recovery_storage_unavailable' });
    assert.deepEqual(storage.execute({ operation: 'load', scope }).state, before);
    assert.equal(storage.execute({ operation: 'load', scope }).revision, 1);
    fault = false;
    assert.deepEqual(storage.execute(request), { revision: 2 });
  } finally {
    owner.release();
    f.runtime.close();
    storage.close();
    database.close();
  }
});

test('owner metadata exports preserve root associations and remain distinct from full restore state', () => {
  const f = fixture(),
    owner = f.acquire();
  try {
    const full = owner.checkpoint(f.view);
    const metadata = owner.metadata(f.view);
    const reference = createReferenceWrite(full, null).reference;
    assert.deepEqual(
      JSON.parse(JSON.stringify(metadata)),
      JSON.parse(
        JSON.stringify({
          metadata: reference.metadata,
          stagedSources: reference.stagedSources,
        })
      )
    );
    assert.deepEqual(
      validateRecoveryRootMetadata(metadata),
      validateRecoveryRootMetadata(metadata)
    );
    assert.equal(metadata.metadata.ledger.sources[0].sourceId, f.receipt.sourceId);
    assert.equal(Object.hasOwn(metadata.metadata.ledger.sources[0], 'output'), false);
    assert.equal(Object.hasOwn(metadata.metadata.ledger.sources[0], 'locator'), false);
    assert.throws(() =>
      restoreContextRecoverySessions({ now: () => 100 }, [
        { binding: request(), state: metadata.metadata },
      ])
    );
    metadata.metadata.snapshots.length = 0;
    assert.equal(owner.metadata(f.view).metadata.snapshots.length, full.root.snapshots.length);
    assert.throws(() => owner.metadata({}), unavailable);
    assert.throws(() => owner.metadata(f.view, {}), unavailable);
    const reservation = owner.reserveBudget();
    assert.throws(() => owner.metadata(f.view, reservation), badBudget);
    assert.equal(owner.replyReserved(f.view, reservation, READ, f.args).ok, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(owner.metadata(f.view, reservation).metadata.budget)),
      JSON.parse(JSON.stringify(owner.checkpoint(f.view, reservation).root.budget))
    );
    owner.confirmBudget(reservation);
    assert.equal(owner.metadata(f.view).metadata.ledger.readCount, 1);
    owner.release();
    assert.throws(() => owner.metadata(f.view), unavailable);
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('root metadata rejects broken binding, branch, history, source and budget associations before hydration', () => {
  const f = fixture(),
    owner = f.acquire();
  const failure = { code: 'invalid_context_recovery_root_state' };
  let invoked = 0;
  try {
    const metadata = owner.metadata(f.view);
    let mutation = 0;
    for (const mutate of [
      (value) => {
        value.metadata.rootId = 'hbs_' + 'f'.repeat(32);
      },
      (value) => {
        value.metadata.target = 'other';
      },
      (value) => {
        value.metadata.sourceVersion = 11;
      },
      (value) => {
        value.metadata.version = 2;
      },
      (value) => {
        value.metadata.kind = 'recovery-root';
      },
      (value) => {
        value.metadata.observedAt = value.metadata.expiresAt;
      },
      (value) => {
        value.metadata.binding.snapshots[0].parentId = 'hbs_' + 'f'.repeat(32);
      },
      (value) => {
        value.metadata.history.tips = ['missing'];
      },
      (value) => {
        value.metadata.snapshots[1].captured = [];
      },
      (value) => {
        value.metadata.snapshots[1].visible = [];
      },
      (value) => {
        value.metadata.ledger.ownerBinding = 'f'.repeat(64);
      },
      (value) => {
        value.metadata.ledger.sources[0].output = exact;
      },
      (value) => {
        value.metadata.budget.calls = -1;
      },
      (value) => {
        value.metadata.snapshots[0].mappingId = 'missing';
      },
      (value) => {
        value.stagedSources = value.metadata.ledger.sources;
      },
      (value) => {
        value.extra = true;
      },
    ]) {
      const value = globalThis.structuredClone(metadata);
      mutate(value);
      assert.throws(() => validateRecoveryRootMetadata(value), failure, 'mutation ' + mutation++);
    }
    for (const value of [
      null,
      [],
      {},
      Object.create({ private: true }),
      Object.defineProperty({}, 'metadata', {
        enumerable: true,
        get() {
          invoked++;
          throw Error('private');
        },
      }),
    ])
      assert.throws(() => validateRecoveryRootMetadata(value), failure);
    assert.equal(invoked, 0);
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('metadata validates empty originals and roots without any captured sources', () => {
  const f = fixture(''),
    owner = f.acquire();
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  let lease;
  try {
    const empty = validateRecoveryRootMetadata(owner.metadata(f.view));
    assert.equal(empty.metadata.ledger.sources[0].bytes, 0);
    const root = runtime.begin(request());
    assert.equal(root.complete([{ role: 'assistant', content: 'done' }], [], 'empty').ok, true);
    const pending = runtime.begin(request([user('next')], { previousResponseId: 'empty' }));
    lease = acquireContextRecoveryRoot(runtime, root.snapshotId);
    assert.deepEqual(
      validateRecoveryRootMetadata(lease.metadata(pending)).metadata.ledger.sources,
      []
    );
  } finally {
    owner.release();
    lease?.release();
    f.runtime.close();
    runtime.close();
  }
});

test('legacy v1 reference metadata retains non-null policy fingerprints without inventing a policy basis', () => {
  const f = fixture(exact, { instructions: 'synthetic-policy' }),
    owner = f.acquire();
  try {
    const { legacyRecoveryRoot } = require('./helpers/recovery-retention-fixture.cjs');
    const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
    const root = legacyRecoveryRoot(owner.checkpoint(f.view).root, 1);
    const reference = createReferenceWrite(createRootCheckpoint(root, []), null).reference;
    assert.equal(reference.metadata.sourceVersion, 1);
    assert.equal(Object.hasOwn(reference.metadata, 'policyBasis'), false);
    assert.equal(reference.metadata.policyFingerprint, root.policyFingerprint);
    assert.equal(reference.metadata.expiresAt, root.expiresAt);
    assert.equal(
      materializeReferenceWrite(
        reference,
        [{ sourceId: root.ledger.sources[0].sourceId, output: exact }],
        null
      ).root.policyFingerprint,
      root.policyFingerprint
    );
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('reference journal validation rejects malformed publication states before payload hydration', () => {
  const f = fixture(),
    owner = f.acquire();
  try {
    const { digest: _digest, ...payload } = createReferenceWrite(
      owner.checkpoint(f.view),
      null
    ).reference;
    const id = payload.metadata.rootId;
    for (const publications of [
      [{ snapshotId: id, state: 'unknown' }],
      [{ snapshotId: 'hbs_' + 'f'.repeat(32), state: 'sending' }],
      [
        { snapshotId: id, state: 'sending' },
        { snapshotId: id, state: 'sending' },
      ],
      [{ snapshotId: id, state: 'sending', extra: true }],
    ]) {
      const value = { ...payload, publications };
      assert.throws(
        () => parseReferenceCheckpoint({ ...value, digest: fingerprintContextData(value) }),
        {
          code: 'invalid_recovery_reference_write',
        }
      );
    }
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('reference writes use a distinct wire schema and send originals only when absent from the prior checkpoint', () => {
  const f = fixture(),
    owner = f.acquire();
  try {
    const reservation = owner.reserveBudget();
    const before = owner.checkpoint(f.view);
    const first = createReferenceWrite(before, null);
    assert.equal(first.payloads.length, 1);
    assert.equal(first.payloads[0].output, exact);
    assert.equal(first.reference.metadata.kind, 'recovery-root-metadata');
    assert.equal(first.reference.metadata.version, 1);
    assert.equal(first.reference.metadata.sourceVersion, before.root.version);
    assert.equal(JSON.stringify(first.reference).includes(exact), false);
    assert.deepEqual(materializeReferenceWrite(first.reference, first.payloads, null), before);
    owner.replyReserved(f.view, reservation, READ, f.args);
    const after = owner.checkpoint(f.view, reservation);
    const next = createReferenceWrite(after, before);
    assert.deepEqual(next.payloads, []);
    assert.deepEqual(materializeReferenceWrite(next.reference, [], before), after);
    assert.throws(() => materializeReferenceWrite(next.reference, [], null));
    assert.equal(
      next.reference.metadata.ledger.sources[0].digest,
      before.root.ledger.sources[0].digest
    );
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('reference wire validates ledger accounting independently of payload hydration', () => {
  const f = fixture(),
    owner = f.acquire();
  try {
    const { reference } = createReferenceWrite(owner.checkpoint(f.view), null);
    for (const change of [
      { capturedCount: 0 },
      { observedAt: 0 },
      { readCount: -1 },
      { policy: { ...reference.metadata.ledger.policy, maxBytes: 0 } },
    ]) {
      const { digest: _digest, ...payload } = reference;
      const value = {
        ...payload,
        metadata: {
          ...payload.metadata,
          ledger: { ...payload.metadata.ledger, ...change },
        },
      };
      assert.throws(
        () => parseReferenceCheckpoint({ ...value, digest: fingerprintContextData(value) }),
        {
          code: 'invalid_recovery_reference_write',
        }
      );
    }
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('reference receivers pin byte capacity and reader budget before replacing an existing root', () => {
  const f = fixture(),
    owner = f.acquire();
  const database = new DatabaseSync(':memory:');
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  try {
    const current = owner.checkpoint(f.view);
    const legacy = createRootCheckpoint(
      {
        ...current.root,
        version: 8,
        ledger: {
          ...current.root.ledger,
          policy: { ...current.root.ledger.policy, maxBytes: 4 * 1024 * 1024 },
        },
      },
      current.stagedSources,
      current.publications
    );
    const oldBudget = createRootCheckpoint(
      {
        ...current.root,
        budget: { ...current.root.budget, version: 1 },
      },
      current.stagedSources,
      current.publications
    );
    const failure = { code: 'invalid_recovery_reference_write' };
    for (const [prior, next] of [
      [legacy, current],
      [current, legacy],
      [oldBudget, current],
      [current, oldBudget],
    ]) {
      const wire = createReferenceWrite(next, null);
      assert.throws(() => createReferenceWrite(next, prior), failure);
      assert.throws(() => materializeReferenceWrite(wire.reference, [], prior), failure);
      const same = createReferenceWrite(prior, prior);
      assert.deepEqual(materializeReferenceWrite(same.reference, [], prior), prior);
    }
    const scope = 'a'.repeat(64);
    store.execute({
      operation: 'save',
      scope,
      expectedRevision: 0,
      expiresAt: legacy.root.expiresAt,
      state: legacy,
    });
    const next = createReferenceWrite(current, null);
    assert.throws(
      () =>
        store.execute({
          operation: 'save-reference',
          scope,
          expectedRevision: 1,
          expiresAt: current.root.expiresAt,
          reference: next.reference,
          payloads: [],
        }),
      { code: 'context_recovery_storage_unavailable' }
    );
    const retained = store.execute({ operation: 'load', scope });
    assert.equal(retained.revision, 1);
    assert.equal(retained.state.root.version, 8);
    assert.equal(retained.state.root.expiresAt, legacy.root.expiresAt);
    assert.deepEqual(retained.state.root.ledger.sources, legacy.root.ledger.sources);
  } finally {
    store.close();
    database.close();
    owner.release();
    f.runtime.close();
  }
});

test('reference writes bind immutable source metadata, prior root, payload integrity and both digests', () => {
  const f = fixture(),
    owner = f.acquire();
  const clone = (value) => globalThis.structuredClone(value);
  const failure = { code: 'invalid_recovery_reference_write' };
  try {
    const state = owner.checkpoint(f.view);
    const first = createReferenceWrite(state, null);
    const repeat = createReferenceWrite(state, state);
    const rehash = (value) => {
      const { digest: _digest, ...payload } = value;
      value.digest = fingerprintContextData(payload);
      return value;
    };
    for (const mutate of [
      (v) => {
        v.sourceDigest = 'f'.repeat(64);
      },
      (v) => {
        v.metadata.principal = 'other';
      },
      (v) => {
        v.metadata.ledger.sources[0].callId = 'other';
      },
      (v) => {
        v.metadata.ledger.sources[0].digest = 'f'.repeat(64);
      },
      (v) => {
        v.metadata.ledger.sources[0].bytes++;
      },
      (v) => {
        v.metadata.ledger.sources[0].createdAt++;
      },
    ]) {
      const value = clone(repeat.reference);
      mutate(value);
      rehash(value);
      assert.throws(() => materializeReferenceWrite(value, [], state), failure);
    }
    assert.throws(
      () =>
        materializeReferenceWrite(
          first.reference,
          [{ ...first.payloads[0], output: 'forged' }],
          null
        ),
      failure
    );
    assert.throws(
      () => materializeReferenceWrite(repeat.reference, first.payloads, state),
      failure
    );
    assert.throws(
      () =>
        materializeReferenceWrite(
          first.reference,
          [...first.payloads, { sourceId: 'hce_' + 'f'.repeat(32), output: '' }],
          null
        ),
      failure
    );
    const other = { ...state.root, principal: 'other' };
    const forgedPrior =
      require('../lib/proxy/context-recovery-root-checkpoint').createRootCheckpoint(
        other,
        state.stagedSources
      );
    assert.throws(() => createReferenceWrite(state, forgedPrior), failure);
    const stale = clone(first.reference);
    stale.digest = 'f'.repeat(64);
    assert.throws(() => parseReferenceCheckpoint(stale), failure);
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('reference wire rejects hostile data, unknown versions, payload substitutions and extreme metadata safely', () => {
  const f = fixture(),
    owner = f.acquire();
  const failure = { code: 'invalid_recovery_reference_write' };
  let invoked = 0;
  try {
    const state = owner.checkpoint(f.view);
    const { reference, payloads } = createReferenceWrite(state, null);
    const rehash = (value) => {
      const { digest: _digest, ...payload } = value;
      return { ...payload, digest: fingerprintContextData(payload) };
    };
    for (const change of [
      { version: 2 },
      { sourceDigest: '' },
      { extra: true },
      { metadata: { ...reference.metadata, sourceVersion: 11 } },
      { metadata: { ...reference.metadata, kind: 'recovery-root' } },
      { stagedSources: Array(65).fill(reference.metadata.ledger.sources[0]) },
    ])
      assert.throws(() => parseReferenceCheckpoint(rehash({ ...reference, ...change })), failure);
    for (const source of [
      { ...reference.metadata.ledger.sources[0], output: exact },
      { ...reference.metadata.ledger.sources[0], bytes: 2097153 },
      { ...reference.metadata.ledger.sources[0], coveredThrough: -1 },
      { ...reference.metadata.ledger.sources[0], createdAt: -1 },
      { ...reference.metadata.ledger.sources[0], readComplete: true },
    ])
      assert.throws(
        () =>
          parseReferenceCheckpoint(
            rehash({
              ...reference,
              metadata: {
                ...reference.metadata,
                ledger: { ...reference.metadata.ledger, sources: [source] },
              },
            })
          ),
        failure
      );
    for (const bad of [
      null,
      {},
      Array(65).fill(payloads[0]),
      [payloads[0], payloads[0]],
      [{ ...payloads[0], output: '\ud800' }],
      [{ ...payloads[0], output: 'x'.repeat(2097153) }],
      [{ ...payloads[0], outputRef: '../private' }],
      [
        {
          ...payloads[0],
          get output() {
            invoked++;
            return exact;
          },
        },
      ],
    ])
      assert.throws(() => parseReferencePayloads(bad), failure);
    assert.throws(
      () =>
        parseReferenceCheckpoint({
          ...reference,
          get metadata() {
            invoked++;
            return {};
          },
        }),
      failure
    );
    assert.throws(
      () =>
        createReferenceWrite(
          {
            get root() {
              invoked++;
              return state.root;
            },
          },
          null
        ),
      failure
    );
    assert.equal(invoked, 0);
  } finally {
    owner.release();
    f.runtime.close();
  }
});

test('reference saves roll back real blob/state writes atomically and reuse ciphertext on the next commit', () => {
  for (const failedSql of ['INSERT INTO recovery_blob', 'INSERT INTO recovery_state']) {
    const f = fixture(),
      owner = f.acquire(),
      database = new DatabaseSync(':memory:');
    let fault = true;
    const storage = createRecoverySqliteStore({
      database: recoverySqliteFaults(database, (sql) => {
        if (fault && sql.startsWith(failedSql)) throw new Error('synthetic reference-write fault');
      }),
      dataKey: randomBytes(32).toString('base64'),
      now: () => 100,
    });
    const scope = 'a'.repeat(64);
    try {
      const state = owner.checkpoint(f.view);
      const first = {
        operation: 'save-reference',
        scope,
        expectedRevision: 0,
        expiresAt: state.root.expiresAt,
        ...createReferenceWrite(state, null),
      };
      assert.throws(() => storage.execute(first), { code: 'context_recovery_storage_unavailable' });
      assert.equal(storage.execute({ operation: 'load', scope }), null);
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
      fault = false;
      assert.deepEqual(storage.execute(first), { revision: 1 });
      const ciphertext = Buffer.from(
        database.prepare('SELECT envelope FROM recovery_blob').get().envelope
      );
      const repeat = {
        operation: 'save-reference',
        scope,
        expectedRevision: 1,
        expiresAt: state.root.expiresAt,
        ...createReferenceWrite(state, state),
      };
      assert.deepEqual(repeat.payloads, []);
      assert.deepEqual(storage.execute(repeat), { revision: 2 });
      assert.deepEqual(
        Buffer.from(database.prepare('SELECT envelope FROM recovery_blob').get().envelope),
        ciphertext
      );
      assert.deepEqual(storage.execute({ operation: 'load', scope }).state, state);
      assert.throws(() => storage.execute(repeat), {
        code: 'context_recovery_storage_unavailable',
      });
      assert.throws(
        () =>
          storage.execute({ ...repeat, expectedRevision: 2, expiresAt: state.root.expiresAt + 1 }),
        { code: 'context_recovery_storage_unavailable' }
      );
    } finally {
      owner.release();
      f.runtime.close();
      storage.close();
      database.close();
    }
  }
});

test('reference writes preserve empty originals and checkpoints without any source', () => {
  const f = fixture(''),
    owner = f.acquire();
  try {
    const state = owner.checkpoint(f.view);
    const first = createReferenceWrite(state, null);
    assert.equal(first.payloads[0].output, '');
    assert.deepEqual(materializeReferenceWrite(first.reference, first.payloads, null), state);
    const repeat = createReferenceWrite(state, state);
    assert.deepEqual(repeat.payloads, []);
    assert.deepEqual(materializeReferenceWrite(repeat.reference, [], state), state);
  } finally {
    owner.release();
    f.runtime.close();
  }
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  let emptyOwner;
  try {
    const root = runtime.begin(request());
    assert.equal(
      root.complete([{ role: 'assistant', content: 'ready' }], [], 'empty-response').ok,
      true
    );
    emptyOwner = acquireContextRecoveryRoot(runtime, root.snapshotId);
    const state = emptyOwner.checkpoint(root);
    const wire = createReferenceWrite(state, null);
    assert.deepEqual(wire.payloads, []);
    assert.deepEqual(materializeReferenceWrite(wire.reference, [], null), state);
  } finally {
    emptyOwner?.release();
    runtime.close();
  }
});

test('root lease is explicit, exclusive, nonforgeable and remains locked after invalidation', () => {
  const owner = createRecoveryRootOwner();
  assert.equal(owner.release(), false);
  assert.equal(owner.release(null), false);
  assert.equal(owner.available(), true);
  const token = owner.acquire();
  assert.equal(owner.available(), false);
  assert.equal(owner.available(token), true);
  assert.equal(owner.available({}), false);
  assert.throws(() => owner.acquire(), unavailable);
  assert.equal(owner.release({}), false);
  owner.invalidate();
  assert.equal(owner.available(token), false);
  assert.equal(owner.available(), false);
  assert.throws(() => owner.acquire(), unavailable);
  assert.equal(owner.release(token), true);
  const next = owner.acquire();
  assert.notEqual(next, token);
  assert.equal(owner.release(token), false);
  owner.close();
  assert.equal(owner.available(next), false);
  assert.equal(owner.release(next), true);
  assert.equal(owner.release(), false);
  assert.equal(owner.available(), false);
  assert.throws(() => owner.acquire(), unavailable);
});

test('actual root ownership blocks synchronous mutation and export but preserves independent roots', () => {
  const f = fixture();
  try {
    const other = f.runtime.begin(request([user('independent')]));
    const lease = f.acquire();
    assert.throws(f.acquire, unavailable);
    assert.throws(() => exportContextRecoveryRoot(f.runtime, f.root.snapshotId));
    assert.equal(f.view.reply(LIST, {}).code, 'context_recovery_busy');
    assert.equal(
      f.view.complete([{ role: 'assistant', content: 'busy' }]).code,
      'context_recovery_busy'
    );
    assert.equal(f.view.completeCompaction({}).code, 'context_recovery_busy');
    assert.equal(f.view.recovery({ messages: [user('read')] }).code, 'context_recovery_busy');
    assert.equal(
      f.runtime.begin(request([user('next')], { previousResponseId: 'source-response' })).code,
      'context_recovery_busy'
    );
    assert.equal(
      other.complete([{ role: 'assistant', content: 'other' }], [], 'independent-response').ok,
      true
    );
    assert.throws(() => lease.reply(other, LIST, {}), unavailable);
    assert.throws(() => lease.reply(undefined, LIST, {}), unavailable);
    assert.throws(() => lease.complete(undefined, []), unavailable);
    assert.throws(() => lease.completeCompaction(undefined, {}), unavailable);
    assert.throws(() => lease.complete({}, []), unavailable);
    assert.throws(() => lease.completeCompaction(other, {}), unavailable);
    assert.equal(lease.reply(f.view, LIST, {}).ok, true);
    assert.equal(
      lease.complete(f.view, [{ role: 'assistant', content: 'done' }], [], 'done-response').ok,
      true
    );
    assert.equal(lease.snapshot().snapshots.length, 3);
    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    assert.throws(() => lease.snapshot(), unavailable);
    assert.equal(f.view.reply(LIST, {}).ok, true);
    assert.equal(
      f.runtime.begin(request([user('next')], { previousResponseId: 'done-response' })).ok,
      true
    );
  } finally {
    f.runtime.close();
  }
});

test('abort or withdraw invalidates the owner without unlocking an outstanding transaction', () => {
  for (const action of ['abort', 'withdraw']) {
    const f = fixture();
    try {
      const lease = f.acquire();
      f.view[action]();
      assert.throws(() => lease.snapshot(), unavailable);
      assert.throws(() => lease.reply(f.view, LIST, {}), unavailable);
      assert.equal(
        f.runtime.begin(request([user('sibling')], { previousResponseId: 'source-response' })).code,
        'context_recovery_busy'
      );
      assert.equal(lease.release(), true);
      const next = f.acquire();
      assert.equal(next.snapshot().snapshots.length, 2);
      next.release();
    } finally {
      f.runtime.close();
    }
  }
});

test('one owner checkpoint partitions published and staged originals without granting pending authority', () => {
  const f = fixture();
  let lease;
  try {
    const nextTool = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'next-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    };
    assert.equal(
      f.view.complete(
        [nextTool],
        [{ callId: 'next-call', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
        'next-response'
      ).ok,
      true
    );
    const pending = f.runtime.begin(
      request(
        [{ role: 'tool', tool_call_id: 'next-call', content: 'staged original' }, user('next')],
        { previousResponseId: 'next-response' }
      ),
      [{ callId: 'next-call', output: 'staged original' }]
    );
    assert.equal(pending.ok, true);
    lease = f.acquire();
    const before = lease.checkpoint(pending);
    const metadata = validateRecoveryRootMetadata(lease.metadata(pending));
    assert.equal(metadata.metadata.ledger.sources.length, 1);
    assert.equal(metadata.stagedSources.length, 1);
    assert.equal(Object.hasOwn(metadata.stagedSources[0], 'output'), false);
    const forged = globalThis.structuredClone(metadata);
    forged.metadata.snapshots[0].visible.push(metadata.stagedSources[0].sourceId);
    assert.throws(() => validateRecoveryRootMetadata(forged));
    assert.deepEqual(parseRootCheckpoint(before, before.root), before);
    assert.equal(before.root.ledger.sources.length, 1);
    assert.equal(before.root.ledger.sources[0].sourceId, f.receipt.sourceId);
    assert.equal(before.root.ledger.sources[0].output, exact);
    assert.equal(before.stagedSources.length, 1);
    assert.equal(before.stagedSources[0].output, 'staged original');
    assert.equal(before.root.ledger.readCount, 0);
    assert.equal(before.root.budget.calls, 0);
    const stagedId = before.stagedSources[0].sourceId;
    assert.equal(
      before.root.snapshots.some((snapshot) => snapshot.visible.includes(stagedId)),
      false
    );
    before.stagedSources[0].output = 'caller mutation';
    assert.equal(lease.checkpoint(pending).stagedSources[0].output, 'staged original');
    assert.throws(() => lease.checkpoint({}, undefined), unavailable);
    assert.throws(() => lease.checkpoint(pending, {}), unavailable);
    const reservation = lease.reserveBudget();
    assert.throws(() => lease.checkpoint(pending, reservation), badBudget);
    const reserved = lease.checkpoint(pending);
    assert.equal(reserved.root.budget.calls, 1);
    assert.equal(reserved.root.ledger.readCount, 0);
    assert.equal(lease.replyReserved(pending, reservation, READ, f.args).ok, true);
    const settled = lease.checkpoint(pending, reservation);
    assert.equal(settled.root.ledger.readCount, 1);
    assert.equal(settled.root.ledger.sources[0].readComplete, true);
    assert.equal(settled.stagedSources[0].readComplete, false);
    assert.equal(
      parseRootCheckpoint(settled, settled.root).stagedSources[0].output,
      'staged original'
    );
    lease.confirmBudget(reservation);
    lease.release();
    assert.throws(() => lease.checkpoint(pending), unavailable);
  } finally {
    lease?.release();
    f.runtime.close();
  }
});

test('revoke, disable, close and expiry invalidate leases immediately and never revive authority', () => {
  for (const action of ['revoke', 'disable', 'close', 'expire']) {
    const f = fixture();
    try {
      const lease = f.acquire();
      const reservation = lease.reserveBudget();
      if (action === 'revoke') f.runtime.revoke('owner');
      if (action === 'disable') f.runtime.configure(false);
      if (action === 'close') f.runtime.close();
      if (action === 'expire') f.advance(100 + 24 * 60 * 60 * 1000);
      assert.throws(() => lease.snapshot(), unavailable);
      assert.throws(() => lease.metadata(f.view), unavailable);
      assert.throws(() => lease.settleBudget(reservation), unavailable);
      assert.throws(() => lease.replyReserved(f.view, reservation, READ, f.args), unavailable);
      lease.release();
      if (action === 'disable') f.runtime.configure(true);
      assert.throws(f.acquire, unavailable);
      assert.equal(f.view.inspect().active, false);
    } finally {
      f.runtime.close();
    }
  }
});

test('new root can be committed under its own lease and cancelled parents cannot be published', () => {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  try {
    const view = runtime.begin(request());
    const lease = acquireContextRecoveryRoot(runtime, view.snapshotId);
    assert.throws(() => lease.snapshot());
    assert.equal(lease.complete(view, [user('done')], [], 'committed').ok, true);
    assert.equal(lease.snapshot().snapshots.length, 1);
    view.withdraw();
    assert.throws(() => lease.snapshot(), unavailable);
    lease.release();
    assert.equal(runtime.begin(request([], { previousResponseId: 'committed' })).ok, false);
  } finally {
    runtime.close();
  }
});

test('existing recovery cannot mutate private history while another owner holds the root', async () => {
  const f = fixture();
  try {
    const run = f.view.recovery({ messages: [user('read')] });
    const lease = f.acquire();
    const done = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    };
    assert.equal(run.accept(done).code, 'context_recovery_busy');
    assert.equal((await run.acceptAsync(done)).code, 'context_recovery_busy');
    assert.equal(run.inspectProgress().rounds, 0);
    lease.release();
    assert.equal((await run.acceptAsync(done)).mode, 'release');
  } finally {
    f.runtime.close();
  }
});

test('shared budget reservations update existing readers in place and settlement preserves their identity', () => {
  const budget = createContextEvidenceBudget();
  const a = readers(budget),
    b = readers(budget);
  const reservation = reserveContextEvidenceBudget(budget);
  assert.equal(a.tools.inspect().calls, 1);
  assert.equal(b.tools.inspect().returnedBytes, 16384);
  assert.equal(a.tools.reply(LIST, {}).code, 'evidence_reader_busy');
  assert.equal(a.tools.reply('foreign', {}), null);
  assert.throws(() => reserveContextEvidenceBudget(budget), badBudget);
  assert.throws(() => exportContextEvidenceReservation(reservation), badBudget);
  assert.equal(readContextEvidenceReservation(a.tools, reservation, LIST, {}).ok, true);
  assert.throws(() => readContextEvidenceReservation(b.tools, reservation, LIST, {}), badBudget);
  const settled = exportContextEvidenceReservation(reservation);
  assert.ok(settled.returnedBytes > 0 && settled.returnedBytes < 16384);
  assert.equal(b.tools.inspect().returnedBytes, 16384);
  settleContextEvidenceReservation(reservation);
  assert.equal(a.tools.inspect().returnedBytes, settled.returnedBytes);
  assert.equal(b.tools.inspect().returnedBytes, settled.returnedBytes);
  assert.equal(b.tools.reply(LIST, {}).ok, true);
  assert.equal(a.tools.inspect().calls, 2);
  assert.throws(() => settleContextEvidenceReservation(reservation), badBudget);
});

test('abandoned reservations retain conservative spend with or without a completed read', () => {
  for (const consumed of [false, true]) {
    const budget = createContextEvidenceBudget(),
      f = readers(budget);
    const reservation = reserveContextEvidenceBudget(budget);
    if (consumed) readContextEvidenceReservation(f.tools, reservation, LIST, {});
    abandonContextEvidenceReservation(reservation);
    assert.equal(exportContextEvidenceBudget(budget).calls, 1);
    assert.equal(exportContextEvidenceBudget(budget).returnedBytes, 16384);
    assert.equal(f.tools.reply(LIST, {}).ok, true);
    assert.equal(f.tools.inspect().calls, 2);
    assert.throws(() => abandonContextEvidenceReservation(reservation), badBudget);
  }
});

test('invalid attempts and failed readers spend one reserved call without leaking or executing input', () => {
  let invoked = 0;
  for (const args of [
    { limit: 0 },
    {
      get limit() {
        invoked++;
        return 1;
      },
    },
    {},
  ]) {
    const budget = createContextEvidenceBudget();
    const f = readers(budget, {
      list: () => {
        throw new Error('private marker');
      },
    });
    const reservation = reserveContextEvidenceBudget(budget);
    const result = readContextEvidenceReservation(f.tools, reservation, LIST, args);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('private marker'), false);
    assert.equal(exportContextEvidenceReservation(reservation).calls, 1);
    settleContextEvidenceReservation(reservation);
    assert.equal(f.tools.inspect().calls, 1);
  }
  assert.equal(invoked, 0);
});

test('reservation tokens, foreign budgets and serialized counters never grant reader admission', () => {
  const budget = createContextEvidenceBudget(),
    f = readers(budget);
  const reservation = reserveContextEvidenceBudget(budget);
  const foreign = readers(createContextEvidenceBudget());
  assert.throws(
    () => readContextEvidenceReservation(foreign.tools, reservation, LIST, {}),
    badBudget
  );
  assert.throws(() => readContextEvidenceReservation({}, reservation, LIST, {}));
  assert.throws(() => readContextEvidenceReservation(f.tools, undefined, LIST, {}));
  for (const fake of [null, {}, [], exportContextEvidenceBudget(budget), 'token']) {
    assert.throws(() => exportContextEvidenceReservation(fake), badBudget);
    assert.throws(() => reserveContextEvidenceBudget(fake), badBudget);
    assert.throws(() => readContextEvidenceReservation(f.tools, fake, LIST, {}), badBudget);
  }
  readContextEvidenceReservation(f.tools, reservation, LIST, {});
  const candidate = exportContextEvidenceReservation(reservation);
  candidate.calls = 0;
  assert.equal(exportContextEvidenceReservation(reservation).calls, 1);
  abandonContextEvidenceReservation(reservation);
});

test('near-limit reservations respect existing call and byte caps without expanding admission', () => {
  for (const initial of [
    { calls: 64, returnedBytes: 0 },
    { calls: 1, returnedBytes: 512 * 1024 },
  ]) {
    const budget = restoreContextEvidenceBudget({ version: 1, successfulReads: 0, ...initial });
    assert.throws(() => reserveContextEvidenceBudget(budget), badBudget);
  }
  const budget = restoreContextEvidenceBudget({
    version: 1,
    calls: 63,
    returnedBytes: 512 * 1024 - 1,
    successfulReads: 0,
  });
  const f = readers(budget),
    reservation = reserveContextEvidenceBudget(budget);
  assert.equal(exportContextEvidenceBudget(budget).returnedBytes, 512 * 1024);
  assert.equal(
    readContextEvidenceReservation(f.tools, reservation, LIST, {}).code,
    'evidence_read_budget_exceeded'
  );
  assert.equal(exportContextEvidenceReservation(reservation).returnedBytes, 512 * 1024 - 1);
  settleContextEvidenceReservation(reservation);
  assert.equal(f.tools.inspect().calls, 64);
  assert.equal(f.tools.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
});

test('root lease coordinates shared reservation snapshots and actual exact read without a second storage root', () => {
  const f = fixture();
  try {
    const lease = f.acquire(),
      reservation = lease.reserveBudget();
    assert.equal(lease.snapshot().kind, 'recovery-root');
    assert.equal(lease.snapshot().budget.returnedBytes, 16384);
    assert.throws(() => lease.complete(f.view, []), unavailable);
    assert.throws(() => lease.completeCompaction(f.view, {}), unavailable);
    assert.throws(() => lease.settlementSnapshot({}), unavailable);
    assert.throws(() => lease.settleBudget({}), unavailable);
    assert.throws(() => lease.replyReserved(f.view, {}, READ, f.args), unavailable);
    assert.throws(() => settleContextEvidenceReservation(reservation), badBudget);
    const read = lease.replyReserved(f.view, reservation, READ, f.args);
    assert.equal(JSON.parse(read.text).page.text, exact);
    const candidate = lease.settlementSnapshot(reservation);
    assert.equal(candidate.budget.successfulReads, 1);
    assert.ok(candidate.budget.returnedBytes < 16384);
    assert.equal(f.view.inspect().readers.returnedBytes, 16384);
    lease.settleBudget(reservation);
    assert.equal(f.view.inspect().readers.returnedBytes, candidate.budget.returnedBytes);
    lease.release();
    assert.equal(f.view.reply(LIST, {}).ok, true);
  } finally {
    f.runtime.close();
  }
});

test('root release after cancellation preserves worst-case debit and discards read admission', () => {
  const f = fixture();
  try {
    const lease = f.acquire(),
      reservation = lease.reserveBudget();
    lease.replyReserved(f.view, reservation, READ, f.args);
    f.view.abort();
    assert.throws(() => lease.settleBudget(reservation), unavailable);
    lease.release();
    const next = f.acquire();
    assert.equal(next.snapshot().budget.returnedBytes, 16384);
    assert.equal(next.snapshot().budget.calls, 1);
    assert.equal(next.snapshot().budget.successfulReads, 0);
    assert.equal(next.snapshot().ledger.readCount, 1);
    next.release();
  } finally {
    f.runtime.close();
  }
});

test('encrypted SQLite saves pre-debit and settlement in the same complete root, then restores fresh readers', () => {
  const f = fixture(),
    database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64'),
    scope = 'a'.repeat(64);
  let storage = createRecoverySqliteStore({ database, dataKey, now: () => 100 });
  let restored;
  try {
    const lease = f.acquire(),
      reservation = lease.reserveBudget();
    const reserved = lease.snapshot();
    assert.equal(
      storage.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: reserved.expiresAt,
        state: reserved,
      }).revision,
      1
    );
    const read = lease.replyReserved(f.view, reservation, READ, f.args);
    assert.equal(JSON.parse(read.text).page.text, exact);
    const settled = lease.settlementSnapshot(reservation);
    assert.equal(
      storage.execute({
        operation: 'save',
        scope,
        expectedRevision: 1,
        expiresAt: settled.expiresAt,
        state: settled,
      }).revision,
      2
    );
    lease.settleBudget(reservation);
    assert.equal(
      lease.complete(f.view, [{ role: 'assistant', content: 'done' }], [], 'done-response').ok,
      true
    );
    const committed = lease.snapshot();
    storage.execute({
      operation: 'save',
      scope,
      expectedRevision: 2,
      expiresAt: committed.expiresAt,
      state: committed,
    });
    lease.release();
    assert.equal(storage.execute({ operation: 'inspect' }).records, 1);
    f.runtime.close();
    storage.close();
    storage = createRecoverySqliteStore({ database, dataKey, now: () => 200 });
    const loaded = storage.execute({ operation: 'load', scope });
    restored = restoreContextRecoverySessions({ now: () => 200 }, [
      { binding: request(), state: loaded.state },
    ]);
    const fresh = restored.begin(request([user('next')], { previousResponseId: 'done-response' }));
    assert.equal(fresh.inspect().readers.calls, 1);
    assert.equal(fresh.inspect().readers.returnedBytes, settled.budget.returnedBytes);
    assert.equal(JSON.parse(fresh.reply(READ, f.args).text).page.text, exact);
    const owner = acquireContextRecoveryRoot(restored, f.root.snapshotId);
    assert.equal(owner.snapshot().budget.calls, 2);
    owner.release();
    assert.throws(() => acquireContextRecoveryRoot(f.runtime, f.root.snapshotId), unavailable);
  } finally {
    restored?.close();
    f.runtime.close();
    storage.close();
    database.close();
  }
});

test('root ownership persists across asynchronous confirmation and cancellation keeps conservative debit', async () => {
  for (const afterRead of [false, true]) {
    const f = fixture();
    let confirmPreDebit, confirmSettlement, didRead;
    const preDebit = new Promise((resolve) => {
      confirmPreDebit = resolve;
    });
    const settlement = new Promise((resolve) => {
      confirmSettlement = resolve;
    });
    const readReady = new Promise((resolve) => {
      didRead = resolve;
    });
    try {
      const operation = (async () => {
        const lease = f.acquire();
        try {
          const reservation = lease.reserveBudget();
          await preDebit;
          const value = lease.replyReserved(f.view, reservation, READ, f.args);
          didRead();
          await settlement;
          lease.settlementSnapshot(reservation);
          lease.settleBudget(reservation);
          return value;
        } finally {
          lease.release();
        }
      })();
      if (afterRead) {
        confirmPreDebit();
        await readReady;
      }
      assert.equal(f.view.reply(READ, f.args).code, 'context_recovery_busy');
      f.view.abort();
      assert.equal(
        f.runtime.begin(request([user('sibling')], { previousResponseId: 'source-response' })).code,
        'context_recovery_busy'
      );
      confirmPreDebit();
      confirmSettlement();
      await assert.rejects(operation, unavailable);
      const state = exportContextRecoveryRoot(f.runtime, f.root.snapshotId);
      assert.equal(state.budget.calls, 1);
      assert.equal(state.budget.returnedBytes, 16384);
      assert.equal(state.budget.successfulReads, 0);
      assert.equal(state.ledger.readCount, afterRead ? 1 : 0);
    } finally {
      f.runtime.close();
    }
  }
});

test('owned native compaction preserves the canonical window and blocks unowned completion', () => {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  try {
    const scope = { principal: 'owner', protocol: 'responses', target: 'target' };
    const initial = [user('q')];
    const output = [
      {
        type: 'message',
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ready' }],
      },
    ];
    const root = runtime.begin({ ...scope, history: initial });
    assert.equal(root.complete(output, [], 'response').ok, true);
    const compact = runtime.beginCompaction({ ...scope, history: [...initial, ...output] });
    assert.equal(compact.ok, true);
    const lease = acquireContextRecoveryRoot(runtime, root.snapshotId);
    const canonical = {
      id: 'compact',
      object: 'response.compaction',
      created_at: 1,
      output: [
        user('retained'),
        { type: 'compaction', id: 'opaque', encrypted_content: 'synthetic-provider-fixture' },
      ],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    };
    const before = JSON.stringify(canonical);
    assert.equal(compact.completeCompaction(canonical).code, 'context_recovery_busy');
    assert.equal(lease.completeCompaction(compact, {}).code, 'context_recovery_compaction_invalid');
    assert.equal(lease.completeCompaction(compact, canonical).ok, true);
    assert.equal(JSON.stringify(canonical), before);
    assert.equal(lease.snapshot().snapshots.length, 2);
    lease.release();
    assert.equal(runtime.begin({ ...scope, history: canonical.output }).ok, true);
  } finally {
    runtime.close();
  }
});

test('root acquisition rejects unknown capabilities and executable labels without invoking them', () => {
  const f = fixture();
  let invoked = 0;
  try {
    const executable = {
      toString() {
        invoked++;
        return f.root.snapshotId;
      },
    };
    for (const service of [null, {}, [], 'service']) {
      assert.throws(() => acquireContextRecoveryRoot(service, f.root.snapshotId), unavailable);
    }
    for (const rootId of [undefined, null, '', 'unknown', {}, executable]) {
      assert.throws(() => acquireContextRecoveryRoot(f.runtime, rootId), unavailable);
    }
    assert.equal(invoked, 0);
  } finally {
    f.runtime.close();
  }
});
