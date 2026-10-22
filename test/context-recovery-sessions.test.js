'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  restoreContextRecoverySessions,
} = require('../lib/proxy/context-recovery-sessions');
const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');
const { projectContextEvidenceCoverage } = require('../lib/proxy/context-evidence-coverage');
const {
  createRecoverySnapshotMap,
  createRecoverySnapshotSet,
  recoverySnapshotOwnEntries,
  inspectRecoverySnapshotIndex,
} = require('../lib/proxy/context-recovery-snapshot-index');
const {
  createContextEvidenceTools,
  createContextEvidenceBudget,
  createContextEvidenceTaskBudget,
  exportContextEvidenceBudget,
  restoreContextEvidenceBudget,
  reserveContextEvidenceBudget,
  readContextEvidenceReservation,
  readContextEvidenceReservationAsync,
  exportContextEvidenceReservation,
  settleContextEvidenceReservation,
  abandonContextEvidenceReservation,
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const user = (content) => ({ role: 'user', content });
const { recoveryRootCapacity } = require('../lib/proxy/context-recovery-capacity');

test('root capacity versions are strict, immutable and preserve legacy limits', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(recoveryRootCapacity(version), {
      maxCalls: 128,
      maxSources: 64,
      maxSnapshots: 256,
    });
  const capacity = recoveryRootCapacity(8);
  assert.deepEqual(capacity, { maxCalls: 1024, maxSources: 512, maxSnapshots: 512 });
  assert.ok(Object.isFrozen(capacity));
  assert.equal(projectContextEvidenceCoverage(1024, 512, 1024).unavailableOrPendingCalls, 512);
  for (const maximum of [null, '1024', 0, 129, 1025])
    assert.throws(() => projectContextEvidenceCoverage(0, 0, maximum));
  assert.throws(() => projectContextEvidenceCoverage(1025, 512, 1024));
  assert.deepEqual(recoveryRootCapacity(9), capacity);
  assert.notEqual(recoveryRootCapacity(9), capacity);
  assert.deepEqual(recoveryRootCapacity(10), capacity);
  assert.notEqual(recoveryRootCapacity(10), recoveryRootCapacity(9));
  for (const version of [null, undefined, 0, 11, '8', 8.1, NaN, Infinity, {}, []])
    assert.throws(() => recoveryRootCapacity(version), /invalid_context_recovery_capacity_version/);
});

test('version 8 call accounting survives JSON reconstruction and refuses cumulative and per-round overflow', () => {
  let runtime = setup(() => 100);
  const basis = request();
  let rootId, responseId;
  try {
    for (let round = 0; round < 8; round++) {
      const view = runtime.begin(
        request([user('round-' + round)], responseId ? { previousResponseId: responseId } : {})
      );
      assert.equal(view.ok, true);
      rootId ??= view.snapshotId;
      const calls = Array.from({ length: 128 }, (_, index) => ({
        callId: `call-${round}-${index}`,
        toolName: 'lookup',
        arguments: {},
        completed: true,
        output: '',
      }));
      const output = [
        {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.callId,
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          })),
        },
      ];
      if (round === 0)
        assert.equal(
          view.complete(output, [...calls, { ...calls[0], callId: 'overflow' }]).ok,
          false
        );
      responseId = 'capacity-round-' + round;
      assert.equal(view.complete(output, calls, responseId).ok, true);
    }
    const state = exportContextRecoveryRoot(runtime, rootId);
    assert.equal(state.version, 10);
    assert.equal(state.callCount, 1024);
    assert.equal(state.ledger.policy.maxEntries, 512);
    runtime.close();
    runtime = restoreContextRecoverySessions({ now: () => 100 }, [
      { binding: basis, state: JSON.parse(JSON.stringify(state)) },
    ]);
    const view = runtime.begin(request([user('overflow')], { previousResponseId: responseId }));
    assert.equal(view.ok, true);
    assert.equal(
      view.complete(
        [{ role: 'assistant', content: 'done' }],
        [{ callId: 'extra', toolName: 'lookup', arguments: {}, output: '', completed: true }]
      ).code,
      'invalid_recovery_calls'
    );
    assert.equal(exportContextRecoveryRoot(runtime, rootId).callCount, 1024);
    view.abort();
  } finally {
    runtime.close();
  }
});

test('version 8 retains exactly 512 sources across encrypted storage and JSON reconstruction without evicting originals', () => {
  let runtime = setup(() => 100);
  const basis = request();
  let rootId,
    responseId,
    pending = [],
    serial = 0;
  try {
    for (let round = 0; round < 5; round++) {
      const calls = Array.from({ length: round < 4 ? 128 : 1 }, () => ({
        callId: 'source-' + serial++,
        toolName: 'lookup',
        arguments: {},
        completed: true,
        output: '',
      }));
      const view = runtime.begin(
        request([user('sources-' + round)], responseId ? { previousResponseId: responseId } : {}),
        pending.map((call) => ({ callId: call.callId, output: 'value-' + call.callId }))
      );
      assert.equal(view.ok, true);
      rootId ??= view.snapshotId;
      responseId = 'sources-round-' + round;
      const output = [
        {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.callId,
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          })),
        },
      ];
      assert.equal(view.complete(output, calls, responseId).ok, true);
      pending = calls;
    }
    const last = runtime.begin(
      request([user('source-overflow')], { previousResponseId: responseId }),
      [{ callId: pending[0].callId, output: 'extra' }]
    );
    assert.equal(last.ok, true);
    const listed = JSON.parse(last.reply(LIST, {}).text);
    assert.equal(listed.coverage.observedCalls, 513);
    assert.equal(listed.coverage.availableSources, 512);
    assert.equal(listed.coverage.unavailableOrPendingCalls, 1);
    assert.equal(
      last.complete([{ role: 'assistant', content: 'done' }], [], 'sources-final').ok,
      true
    );
    const state = exportContextRecoveryRoot(runtime, rootId);
    assert.equal(state.ledger.sources.length, 512);
    const { DatabaseSync } = require('node:sqlite');
    const { randomBytes } = require('node:crypto');
    const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
    const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
    const database = new DatabaseSync(':memory:');
    const dataKey = randomBytes(32).toString('base64');
    let store = createRecoverySqliteStore({ database, dataKey, now: () => 100 });
    let persisted;
    try {
      const scope = 'a'.repeat(64);
      store.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: state.expiresAt,
        state: createRootCheckpoint(state, []),
      });
      const {
        referenceStateFromCheckpoint,
      } = require('../lib/proxy/context-recovery-reference-state');
      const reference = referenceStateFromCheckpoint(createRootCheckpoint(state, []));
      store.execute({
        operation: 'save-reference-state',
        scope,
        expectedRevision: 1,
        expiresAt: state.expiresAt,
        reference,
        payloads: [],
      });
      store.close();
      store = createRecoverySqliteStore({ database, dataKey, now: () => 100 });
      persisted = store.execute({ operation: 'load', scope }).state.root;
      assert.deepEqual(persisted, state);
      assert.equal(
        store.execute({ operation: 'load-reference', scope }).reference.metadata.ledger.sources
          .length,
        512
      );
    } finally {
      store.close();
      database.close();
    }
    runtime.close();
    runtime = restoreContextRecoverySessions({ now: () => 100 }, [
      { binding: basis, state: JSON.parse(JSON.stringify(persisted)) },
    ]);
    const view = runtime.begin(
      request([user('read-earliest')], { previousResponseId: 'sources-final' })
    );
    const source = listed.sources[0];
    assert.equal(
      JSON.parse(view.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text).page
        .text,
      'value-source-0'
    );
    assert.equal(JSON.parse(view.reply(LIST, {}).text).coverage.availableSources, 512);
    view.abort();
  } finally {
    runtime.close();
  }
});

test('version 8 snapshot admission includes simultaneous pending branches and retains its ceiling after reopen', () => {
  let runtime = setup(() => 100);
  const basis = request();
  try {
    const first = runtime.begin(basis);
    assert.equal(
      first.complete([{ role: 'assistant', content: 'root', id: 'anchor' }], [], 'root-id').ok,
      true
    );
    for (let index = 0; index < 510; index++) {
      const child = runtime.begin(
        request([user('branch-' + index)], { previousResponseId: 'root-id' })
      );
      assert.equal(
        child.complete([{ role: 'assistant', content: 'done' }], [], 'branch-' + index).ok,
        true
      );
    }
    const left = runtime.begin(request([user('left')], { previousResponseId: 'root-id' }));
    const right = runtime.begin(request([user('right')], { previousResponseId: 'root-id' }));
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(left.complete([{ role: 'assistant', content: 'done' }], [], 'last').ok, true);
    assert.equal(
      right.complete([{ role: 'assistant', content: 'done' }], [], 'excess').code,
      'context_binding_quota'
    );
    right.abort();
    const state = exportContextRecoveryRoot(runtime, first.snapshotId);
    assert.equal(state.snapshots.length, 512);
    runtime.close();
    runtime = restoreContextRecoverySessions({ now: () => 100 }, [
      { binding: basis, state: JSON.parse(JSON.stringify(state)) },
    ]);
    assert.equal(
      runtime.begin(request([user('after reopen')], { previousResponseId: 'root-id' })).code,
      'context_binding_quota'
    );
  } finally {
    runtime.close();
  }
});

test('sealed snapshot indexes isolate parents and siblings while preserving ordered views', () => {
  const initial = createRecoverySnapshotMap();
  assert.equal(initial.set('root', 1), initial);
  const rootIndex = initial.freeze();
  assert.equal(initial.freeze(), rootIndex);
  assert.throws(() => initial.set('late', 2), /invalid_recovery_snapshot_index/);
  assert.equal(Object.hasOwn(rootIndex, 'set'), false);
  const left = createRecoverySnapshotMap(rootIndex);
  const right = createRecoverySnapshotMap(rootIndex);
  left.set('left', undefined);
  right.set('right', 3);
  assert.equal(left.has('left'), true);
  assert.equal(left.get('left'), undefined);
  assert.equal(left.get('missing'), undefined);
  assert.equal(right.has('left'), false);
  assert.equal(rootIndex.has('right'), false);
  assert.throws(() => left.set('root', 2), /invalid_recovery_snapshot_index/);
  const frozen = left.freeze();
  assert.deepEqual(
    [...frozen],
    [
      ['root', 1],
      ['left', undefined],
    ]
  );
  assert.deepEqual([...frozen.keys()], ['root', 'left']);
  assert.deepEqual([...frozen.values()], [1, undefined]);
  assert.deepEqual([...recoverySnapshotOwnEntries(frozen)], [['left', undefined]]);
  assert.equal(frozen.size, 2);
  assert.deepEqual(
    [...right.freeze()],
    [
      ['root', 1],
      ['right', 3],
    ]
  );
  const visible = createRecoverySnapshotSet();
  visible.add('source');
  const prior = visible.freeze();
  const next = createRecoverySnapshotSet(prior);
  next.add('new');
  assert.deepEqual([...next.freeze()], ['source', 'new']);
  assert.deepEqual([...recoverySnapshotOwnEntries(next.freeze())], ['new']);
  assert.equal(next.size, 2);
});

test('snapshot views preserve live size and sealed capabilities without allocating descriptor copies', (t) => {
  const descriptors = Object.getOwnPropertyDescriptors;
  let copies = 0;
  t.mock.method(Object, 'getOwnPropertyDescriptors', (value) => {
    copies++;
    return descriptors(value);
  });
  const map = createRecoverySnapshotMap();
  const set = createRecoverySnapshotSet();
  assert.equal(map.size, 0);
  assert.equal(set.size, 0);
  map.set('first', undefined);
  set.add('first');
  assert.equal(map.size, 1);
  assert.equal(set.size, 1);
  const mapView = map.freeze();
  const setView = set.freeze();
  assert.equal(copies, 0, 'fresh factory views must not materialize and copy descriptors');
  t.mock.restoreAll();
  for (const view of [map, set, mapView, setView]) {
    assert.equal(Object.isFrozen(view), true);
    assert.equal(Object.getPrototypeOf(view), Object.prototype);
    const size = Object.getOwnPropertyDescriptor(view, 'size');
    assert.equal(typeof size.get, 'function');
    assert.equal(size.set, undefined);
    assert.equal(size.enumerable, true);
    assert.equal(size.configurable, false);
    assert.equal(view.size, 1);
    assert.throws(() => {
      view.size = 999;
    }, TypeError);
  }
  assert.equal(map.freeze(), mapView);
  assert.equal(set.freeze(), setView);
  assert.equal(Object.hasOwn(mapView, 'set'), false);
  assert.equal(Object.hasOwn(setView, 'add'), false);
  assert.equal(Object.hasOwn(mapView, 'freeze'), false);
  const child = createRecoverySnapshotMap(mapView);
  child.set('second', 2);
  assert.equal(child.size, 2);
  assert.equal(mapView.size, 1);
  assert.deepEqual(
    [...child.freeze()],
    [
      ['first', undefined],
      ['second', 2],
    ]
  );
  assert.equal(mapView.has('second'), false);
  assert.throws(() => map.set('late', 3), /invalid_recovery_snapshot_index/);
  assert.throws(() => set.add('late'), /invalid_recovery_snapshot_index/);
});

test('snapshot indexes retain one local entry per round rather than full ancestor copies', () => {
  let parent;
  const retained = [];
  for (let round = 0; round < 480; round++) {
    const builder = createRecoverySnapshotMap(parent);
    builder.set('call-' + round, round);
    parent = builder.freeze();
    retained.push(parent);
  }
  assert.equal(
    retained.reduce((sum, entry) => sum + inspectRecoverySnapshotIndex(entry).ownEntries, 0),
    480
  );
  assert.equal(
    retained.reduce((sum, entry) => sum + entry.size, 0),
    115440
  );
  assert.equal(parent.get('call-0'), 0);
  assert.equal(parent.get('call-479'), 479);
  assert.equal([...parent.entries()].length, 480);
  assert.equal(inspectRecoverySnapshotIndex(parent).depth, 480);
});

test('snapshot indexes avoid walking most missing scalar keys without accepting sibling entries', (t) => {
  let parent;
  for (let index = 0; index < 480; index++) {
    const builder = createRecoverySnapshotMap(parent);
    builder.set('retained-' + index, index);
    parent = builder.freeze();
  }
  const has = Map.prototype.has;
  let probes = 0;
  t.mock.method(Map.prototype, 'has', function (key) {
    probes++;
    return has.call(this, key);
  });
  for (let index = 0; index < 128; index++) {
    assert.equal(parent.has('absent-' + index), false);
    assert.equal(parent.get('absent-' + index), undefined);
  }
  assert.ok(probes < 128 * 480, 'most missing keys must avoid ancestor map probes');
  const left = createRecoverySnapshotMap(parent);
  const right = createRecoverySnapshotMap(parent);
  left.set('sibling-only', 999);
  assert.equal(right.has('sibling-only'), false);
  assert.equal(parent.has('sibling-only'), false);
  assert.equal(left.get('retained-0'), 0);
  assert.equal(left.get('sibling-only'), 999);
});

test('snapshot membership acceleration preserves nonstring and saturated string key semantics without hooks', () => {
  const key = {
    toString() {
      throw Error('must not coerce keys');
    },
  };
  const builder = createRecoverySnapshotMap();
  const keys = [key, undefined, null, NaN, 0, false, Symbol('key'), '', 'x'.repeat(1024)];
  for (const [index, entry] of keys.entries()) builder.set(entry, index);
  for (let index = 0; index < 4096; index++) builder.set('saturated-' + index, index);
  const parent = builder.freeze();
  const child = createRecoverySnapshotMap(parent);
  for (const [index, entry] of keys.entries()) {
    assert.equal(child.has(entry), true);
    assert.equal(child.get(entry), index);
    assert.throws(() => child.set(entry, 1), /invalid_recovery_snapshot_index/);
  }
  for (let index = 0; index < 4096; index++) assert.equal(child.get('saturated-' + index), index);
  assert.equal(child.has('unknown-saturated'), false);
  assert.equal(child.get('y'.repeat(1024)), undefined);
  assert.equal(child.has({}), false);
  assert.equal(child.has(-0), true);
});

test('actual session and restored indexes retain branch deltas while exposing the same complete views', () => {
  const runtime = setup(() => 1000);
  let restored;
  try {
    let history = [user('chain')];
    let pending = [];
    let first;
    for (let index = 0; index < 60; index++) {
      const session = runtime.begin(request(history), pending);
      assert.equal(session.ok, true);
      first ??= session;
      const callId = 'chain-' + index;
      const output = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      };
      assert.equal(
        session.complete(
          [output],
          [{ callId, toolName: 'lookup', arguments: {}, completed: true, output: '' }],
          'chain-response-' + index
        ).ok,
        true
      );
      history = [
        ...history,
        output,
        { role: 'tool', tool_call_id: callId, content: 'value-' + index },
      ];
      pending = [{ callId, output: 'value-' + index }];
    }
    const final = runtime.begin(request(history), pending);
    assert.equal(
      final.complete([{ role: 'assistant', content: 'done' }], [], 'chain-final').ok,
      true
    );
    const before = runtime.inspect();
    assert.equal(before.snapshotIndexEntries, 180);
    assert.equal(before.snapshotIndexLogicalEntries, 5550);
    const state = exportContextRecoveryRoot(runtime, first.snapshotId);
    assert.equal(
      state.snapshots.reduce(
        (sum, view) => sum + view.calls.length + view.captured.length + view.visible.length,
        0
      ),
      180
    );
    assert.equal(state.ledger.sources.length, 60);
    restored = restoreContextRecoverySessions({ now: () => 1000 }, [
      { binding: request([user('chain')]), state },
    ]);
    assert.equal(restored.inspect().snapshotIndexEntries, 180);
    assert.equal(restored.inspect().snapshotIndexLogicalEntries, 5550);
    const view = restored.begin(request([user('after')], { previousResponseId: 'chain-final' }));
    assert.equal(view.ok, true);
    assert.equal(view.inspect().visibleSources, 60);
    const listed = JSON.parse(view.reply(LIST, {}).text);
    assert.equal(listed.coverage.observedCalls, 60);
    const source = listed.sources[0];
    assert.equal(
      JSON.parse(view.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text).page
        .text,
      'value-0'
    );
    runtime.close();
    assert.equal(runtime.inspect().snapshotIndexEntries, 0);
    assert.equal(runtime.inspect().snapshotIndexLogicalEntries, 0);
  } finally {
    runtime.close();
    restored?.close();
  }
});

test('snapshot index admission rejects forged, mutable, wrong-kind and excessive-depth parents without hooks', () => {
  let accessed = false;
  const hostile = {
    get size() {
      accessed = true;
      return 0;
    },
  };
  for (const input of [
    null,
    false,
    1,
    'index',
    {},
    [],
    hostile,
    new Map(),
    createRecoverySnapshotMap(),
  ]) {
    assert.throws(() => createRecoverySnapshotMap(input), /invalid_recovery_snapshot_index/);
    assert.throws(() => recoverySnapshotOwnEntries(input), /invalid_recovery_snapshot_index/);
    assert.throws(() => inspectRecoverySnapshotIndex(input), /invalid_recovery_snapshot_index/);
  }
  assert.equal(accessed, false);
  assert.throws(
    () => createRecoverySnapshotMap(createRecoverySnapshotSet().freeze()),
    /invalid_recovery_snapshot_index/
  );
  assert.throws(
    () => createRecoverySnapshotSet(createRecoverySnapshotMap().freeze()),
    /invalid_recovery_snapshot_index/
  );
  let parent;
  for (let depth = 0; depth < 4096; depth++) parent = createRecoverySnapshotSet(parent).freeze();
  assert.deepEqual([...parent], []);
  assert.equal(parent.has('missing'), false);
  assert.throws(() => createRecoverySnapshotSet(parent), /invalid_recovery_snapshot_index/);
});
const tool = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
};
const call = { callId: 'call-1', toolName: 'lookup', arguments: {}, completed: true, output: '' };
const request = (history = [user('q')], extra = {}) => ({
  principal: 'owner-a',
  protocol: 'chat',
  target: 'target-a',
  history,
  ...extra,
});
const budgetLedger = () => ({
  list: () => ({ ok: true, sources: [], nextAfterSourceId: null }),
  read: () => ({ ok: false, error: 'context_evidence_unavailable' }),
});

test('budget versions reject malformed and hostile state without coercion', () => {
  const { parseEvidenceBudgetState } = require('../lib/proxy/context-evidence-budget-state');
  const valid = { version: 2, calls: 0, returnedBytes: 0, successfulReads: 0 };
  let accessed = false;
  const hostile = { ...valid };
  Object.defineProperty(hostile, 'version', {
    enumerable: true,
    get() {
      accessed = true;
      return 2;
    },
  });
  for (const input of [
    null,
    [],
    {},
    hostile,
    ...[0, 3, '2', null].map((version) => ({ ...valid, version })),
    ...[-1, 4097, Infinity, 1.5, '1'].map((calls) => ({ ...valid, calls })),
    { ...valid, calls: 1, returnedBytes: 16777217 },
    { ...valid, returnedBytes: 1 },
    { ...valid, successfulReads: 1 },
    { ...valid, calls: 1, successfulReads: 1 },
    { ...valid, extra: true },
    { ...valid, version: 1, calls: 65 },
  ])
    assert.throws(() => parseEvidenceBudgetState(input), /invalid_evidence_budget_state/);
  assert.equal(accessed, false);
  assert.deepEqual(parseEvidenceBudgetState(valid), valid);
  assert.equal(
    parseEvidenceBudgetState({ ...valid, calls: 4096, returnedBytes: 16777216 }).calls,
    4096
  );
});

test('task caps survive reconstruction and multiple readers while old budgets stay unchanged', () => {
  const token = createContextEvidenceTaskBudget();
  const a = createContextEvidenceTools(budgetLedger(), token);
  for (let i = 0; i < 64; i++) assert.equal(a.reply(LIST, {}).ok, true);
  assert.equal(a.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
  const before = exportContextEvidenceBudget(token);
  const restored = restoreContextEvidenceBudget(JSON.parse(JSON.stringify(before)));
  const b = createContextEvidenceTools(budgetLedger(), restored);
  assert.equal(b.reply(LIST, {}).ok, true);
  assert.equal(exportContextEvidenceBudget(restored).calls, before.calls + 1);
  assert.equal(b.inspect().round.calls, 1);
  assert.equal(b.inspect().maxCalls, 4096);
  for (const exhausted of [
    { version: 2, calls: 4096, returnedBytes: 1, successfulReads: 0 },
    { version: 2, calls: 1, returnedBytes: 16777216, successfulReads: 0 },
    { version: 1, calls: 64, returnedBytes: 1, successfulReads: 0 },
  ]) {
    const shared = restoreContextEvidenceBudget(exhausted);
    for (let i = 0; i < 2; i++)
      assert.equal(
        createContextEvidenceTools(budgetLedger(), shared).reply(LIST, {}).code,
        'evidence_read_budget_exceeded'
      );
    assert.deepEqual(exportContextEvidenceBudget(shared), exhausted);
    assert.throws(() => reserveContextEvidenceBudget(shared), /invalid_evidence_budget_state/);
  }
});

test('task reservation keeps its version, pending exclusion and uncertain debit after restore', async () => {
  const token = createContextEvidenceTaskBudget();
  const tools = createContextEvidenceTools(budgetLedger(), token);
  const reservation = reserveContextEvidenceBudget(token);
  assert.equal(tools.reply(LIST, {}).code, 'evidence_reader_busy');
  assert.equal(readContextEvidenceReservation(tools, reservation, LIST, {}).ok, true);
  assert.equal(exportContextEvidenceReservation(reservation).version, 2);
  settleContextEvidenceReservation(reservation);
  assert.equal(exportContextEvidenceBudget(token).calls, 1);
  const abandoned = reserveContextEvidenceBudget(token);
  const charged = exportContextEvidenceBudget(token);
  abandonContextEvidenceReservation(abandoned);
  assert.deepEqual(exportContextEvidenceBudget(restoreContextEvidenceBudget(charged)), charged);
  assert.equal(charged.calls, 2);
  const last = restoreContextEvidenceBudget({
    version: 2,
    calls: 4095,
    returnedBytes: 16777200,
    successfulReads: 0,
  });
  const lastTools = createContextEvidenceTools(budgetLedger(), last);
  const final = reserveContextEvidenceBudget(last);
  assert.equal(
    readContextEvidenceReservation(lastTools, final, LIST, {}).code,
    'evidence_read_budget_exceeded'
  );
  settleContextEvidenceReservation(final);
  assert.equal(exportContextEvidenceBudget(last).calls, 4096);
  // An async failure holds its per-round maximum, even if the caller can start
  // another request view. The task's durable debit is never silently restored.
  const asyncTools = createContextEvidenceTools(budgetLedger(), token);
  const failed = reserveContextEvidenceBudget(token);
  assert.equal(
    (
      await readContextEvidenceReservationAsync(
        asyncTools,
        failed,
        READ,
        {
          sourceId: 'hce_' + 'a'.repeat(32),
          digest: 'b'.repeat(64),
        },
        async () => {
          throw Error('private');
        }
      )
    ).code,
    'context_evidence_unavailable'
  );
  abandonContextEvidenceReservation(failed);
  assert.equal(asyncTools.inspect().round.returnedBytes, 16384);
});

test('failed readers cannot bypass the per-round byte ceiling using fresh task allowance', () => {
  const token = createContextEvidenceTaskBudget();
  let invoked = 0;
  const tools = createContextEvidenceTools(
    {
      list() {
        invoked++;
        throw Error('private');
      },
      read() {
        throw Error('private');
      },
    },
    token
  );
  for (let i = 0; i < 32; i++)
    assert.equal(tools.reply(LIST, {}).code, 'context_evidence_unavailable');
  assert.equal(tools.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
  assert.equal(invoked, 32);
  assert.equal(tools.inspect().round.returnedBytes, 512 * 1024);
  const next = createContextEvidenceTools(budgetLedger(), token);
  assert.equal(next.reply(LIST, {}).ok, true);
  assert.equal(next.inspect().calls, 34);
});
function setup(now) {
  const runtime = createContextRecoverySessions(now ? { now } : {});
  runtime.configure(true);
  return runtime;
}

test('reported retention matches real admission and absolute expiry without evicting live chats', () => {
  let time = 1000;
  const runtime = setup(() => time);
  const { absoluteTtlMs, maxActiveRoots } = createContextRecoveryDiagnostics().inspect(
    {}
  ).retention;
  try {
    for (let index = 0; index < maxActiveRoots; index++) {
      const session = runtime.begin(request([user('independent-' + index)]));
      assert.equal(session.ok, true);
      assert.equal(
        session.complete([{ role: 'assistant', content: 'answer-' + index }], [], 'r-' + index).ok,
        true
      );
      time++;
    }
    const extra = request([user('extra')]);
    assert.equal(runtime.begin(extra).code, 'context_recovery_quota');
    assert.equal(runtime.inspect().roots, maxActiveRoots);
    time = 1000 + absoluteTtlMs - 1;
    assert.equal(runtime.inspect().roots, maxActiveRoots);
    time++;
    assert.equal(runtime.inspect().roots, maxActiveRoots - 1);
    assert.equal(runtime.begin(extra).ok, true);
    assert.equal(runtime.inspect().roots, maxActiveRoots);
  } finally {
    runtime.close();
  }
});
test('coverage projection bounds unknown inputs without coercion or private content', () => {
  assert.equal(projectContextEvidenceCoverage(0, 0).state, 'no_observed_calls');
  assert.equal(projectContextEvidenceCoverage(1, 1).state, 'complete_for_observed_calls');
  assert.equal(projectContextEvidenceCoverage(128, 0).unavailableOrPendingCalls, 128);
  let accessed = false;
  const hostile = {
    valueOf() {
      accessed = true;
      throw new Error('synthetic-private-content');
    },
  };
  for (const value of [
    null,
    undefined,
    -1,
    129,
    Infinity,
    NaN,
    0.5,
    '1',
    {},
    [],
    hostile,
    Symbol('private'),
    1n,
  ]) {
    assert.throws(() => projectContextEvidenceCoverage(value, 0), {
      message: 'invalid_context_evidence_coverage',
    });
    assert.throws(() => projectContextEvidenceCoverage(1, value), {
      message: 'invalid_context_evidence_coverage',
    });
  }
  assert.throws(() => projectContextEvidenceCoverage(1, 2), {
    message: 'invalid_context_evidence_coverage',
  });
  assert.equal(accessed, false);
});

test('retention gaps are visible on the owning branch, survive reopen and do not reveal sibling captures', () => {
  let runtime = setup(() => 1000);
  let restored;
  try {
    const initial = request();
    const first = runtime.begin(initial);
    const observed = Array.from({ length: 65 }, (_, index) => ({
      callId: 'capacity-' + index,
      toolName: 'lookup',
      arguments: {},
      completed: true,
      output: '',
    }));
    const output = {
      role: 'assistant',
      content: null,
      tool_calls: observed.map((entry) => ({
        id: entry.callId,
        type: 'function',
        function: { name: entry.toolName, arguments: '{}' },
      })),
    };
    assert.equal(first.complete([output], observed, 'capacity-parent').ok, true);
    // Reconstruct an actual old-capacity root. New roots admit 65 sources;
    // old records must retain their original 64-source accounting limit.
    const legacy = exportContextRecoveryRoot(runtime, first.snapshotId);
    legacy.version = 6;
    legacy.binding.format = 2;
    legacy.ledger.policy.maxEntries = 64;
    legacy.ledger.policy.maxBytes = 4 * 1024 * 1024;
    runtime.close();
    runtime = restoreContextRecoverySessions({ now: () => 1000 }, [
      { binding: initial, state: legacy },
    ]);
    const results = observed.map((entry, index) => ({
      callId: entry.callId,
      output: 'synthetic-source-' + index,
    }));
    const history = [
      ...initial.history,
      output,
      ...results.map((entry) => ({
        role: 'tool',
        tool_call_id: entry.callId,
        content: entry.output,
      })),
    ];
    const current = runtime.begin(request(history), results);
    assert.equal(current.ok, true);
    const listed = JSON.parse(current.reply(LIST, {}).text);
    const expected = {
      scope: 'observed_calls_on_branch',
      state: 'incomplete_or_pending',
      observedCalls: 65,
      availableSources: 64,
      unavailableOrPendingCalls: 1,
    };
    assert.deepEqual(listed.coverage, expected);
    const answer = { role: 'assistant', content: 'done' };
    assert.equal(current.complete([answer], [], 'capacity-child').ok, true);
    const sibling = runtime.begin(
      request([user('sibling')], { previousResponseId: 'capacity-parent' })
    );
    assert.equal(sibling.ok, true);
    const siblingIndex = JSON.parse(sibling.reply(LIST, {}).text);
    assert.equal(siblingIndex.sources.length, 0);
    assert.deepEqual(siblingIndex.coverage, {
      ...expected,
      availableSources: 0,
      unavailableOrPendingCalls: 65,
    });
    sibling.abort();
    const state = exportContextRecoveryRoot(runtime, first.snapshotId);
    runtime.close();
    restored = restoreContextRecoverySessions({ now: () => 1001 }, [{ binding: initial, state }]);
    const next = restored.begin(request([...history, answer, user('after reopen')]));
    assert.equal(next.ok, true);
    const index = JSON.parse(next.reply(LIST, {}).text);
    assert.deepEqual(index.coverage, expected);
    assert.equal(
      JSON.parse(
        next.reply(READ, { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest })
          .text
      ).page.text,
      results[0].output
    );
    next.abort();
  } finally {
    runtime.close();
    restored?.close();
  }
});

function root(runtime) {
  const session = runtime.begin(request());
  assert.equal(session.ok, true);
  assert.equal(session.complete([tool], [call], 'response-1').ok, true);
  return session;
}
const result = (value) => ({ callId: 'call-1', output: value });
const continuation = (value) =>
  request([user('q'), tool, { role: 'tool', tool_call_id: 'call-1', content: value }]);
const readList = (session) => JSON.parse(session.reply(LIST, {}).text);

test('transport references prove exact owned source bytes without spending reader budgets or crossing sibling/expiry boundaries', () => {
  let time = 100;
  const runtime = setup(() => time);
  try {
    root(runtime);
    const original = 'original 中文🙂';
    const current = runtime.begin(continuation(original), [result(original)]);
    assert.equal(current.ok, true);
    const source = readList(current).sources[0];
    const before = current.inspect();
    assert.deepEqual(current.retainedTransportReference('call-1', source.digest), {
      sourceId: source.sourceId,
      digest: source.digest,
      bytes: Buffer.byteLength(original),
    });
    assert.deepEqual(current.inspect(), before);
    for (const [id, digest] of [
      ['other', source.digest],
      ['call-1', 'f'.repeat(64)],
      [null, source.digest],
      ['x'.repeat(257), source.digest],
      ['call-1', {}],
    ])
      assert.equal(current.retainedTransportReference(id, digest), null);
    const sibling = runtime.begin(request([user('sibling')], { previousResponseId: 'response-1' }));
    assert.equal(sibling.ok, true);
    assert.equal(sibling.retainedTransportReference('call-1', source.digest), null);
    time += 24 * 60 * 60 * 1000;
    assert.equal(current.retainedTransportReference('call-1', source.digest), null);
  } finally {
    runtime.close();
  }
});

test('Claude cache-marked single text and native string history bind without rewriting public payloads', () => {
  const runtime = setup();
  try {
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
    const policy = { instructions: null, system: null, tools, toolChoice: null };
    const scope = { principal: 'owner-a', protocol: 'claude', target: 'target-a', policy };
    const firstInput = {
      role: 'user',
      content: [{ type: 'text', text: 'owned 中文🙂', cache_control: { type: 'ephemeral' } }],
    };
    const external = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'native-read', name: 'Read', input: {} }],
    };
    const first = runtime.begin({ ...scope, history: [firstInput] });
    assert.equal(
      first.complete(
        [external],
        [{ callId: 'native-read', toolName: 'Read', arguments: {}, completed: true, output: '' }],
        'm1'
      ).ok,
      true
    );
    const history = [
      { role: 'user', content: 'owned 中文🙂' },
      {
        ...external,
        content: [{ ...external.content[0], cache_control: { type: 'ephemeral' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'native-read',
            content: 'exact original',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ];
    const next = runtime.begin({ ...scope, history }, [
      { callId: 'native-read', output: 'exact original' },
    ]);
    assert.equal(next.reason, 'observed_continuation');
    assert.equal(next.inspect().visibleSources, 1);
    const body = { model: 'fixture', messages: history, tools };
    const recovery = next.recovery(body);
    assert.equal(recovery.ok, true, recovery.code);
    assert.deepEqual(JSON.parse(JSON.stringify(recovery.initialRequest.messages)), history);
    const response = (id, name, input) => ({
      id,
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name, input }],
    });
    const listed = recovery.accept(response('private-list', LIST, {}));
    assert.equal(listed.mode, 'continue');
    const index = JSON.parse(listed.request.messages.at(-1).content[0].content);
    const read = recovery.accept(
      response('private-read', READ, {
        sourceId: index.sources[0].sourceId,
        digest: index.sources[0].digest,
      })
    );
    assert.equal(read.mode, 'continue');
    assert.equal(
      JSON.parse(read.request.messages.at(-1).content[0].content).page.text,
      'exact original'
    );
    const final = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'native-read-two', name: 'Read', input: {} }],
    };
    const released = recovery.accept({
      id: 'm2',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: final.content,
    });
    assert.equal(released.mode, 'release');
    assert.equal(
      next.complete(
        [final],
        [
          {
            callId: 'native-read-two',
            toolName: 'Read',
            arguments: {},
            completed: true,
            output: '',
          },
        ],
        'm2'
      ).ok,
      true
    );
    const subsequent = [
      firstInput,
      external,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'native-read', content: 'exact original' }],
      },
      final,
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'native-read-two',
            content: 'second original',
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      },
    ];
    const third = runtime.begin({ ...scope, history: subsequent }, [
      { callId: 'native-read-two', output: 'second original' },
    ]);
    assert.equal(third.reason, 'observed_continuation');
    const rebuilt = third.recovery({ ...body, messages: subsequent });
    assert.equal(rebuilt.ok, true, rebuilt.code);
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt.initialRequest.messages[0])), firstInput);
    const privateCalls = rebuilt.initialRequest.messages
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((block) => block.type === 'tool_use' && [LIST, READ].includes(block.name));
    assert.deepEqual(
      privateCalls.map((block) => block.name),
      [LIST, READ]
    );
    third.abort();
  } finally {
    runtime.close();
  }
});
for (const mode of ['memory', 'admission', 'export', 'failure', 'coordinatorFailure']) {
  test(`fresh-process recovery cold imports preserve ${mode} boundaries`, () => {
    const child = spawnSync(
      process.execPath,
      [path.join(__dirname, 'helpers/context-recovery-cold-imports.cjs'), mode],
      {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
      }
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'cold_boundary_verified');
    assert.equal(child.stderr, '');
  });
}
const completion = (calls = [], content = 'final') => ({
  choices: [
    {
      finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content,
        ...(calls.length
          ? {
              tool_calls: calls.map((entry) => ({
                id: entry.id,
                type: 'function',
                function: { name: entry.name, arguments: JSON.stringify(entry.args ?? {}) },
              })),
            }
          : {}),
      },
    },
  ],
});

test('automatic session captures only prospectively observed completed calls and reads exact Unicode', () => {
  const runtime = setup();
  root(runtime);
  const output = '原文🙂\n数据';
  const session = runtime.begin(continuation(output), [result(output)]);
  assert.equal(session.reason, 'observed_continuation');
  const index = readList(session);
  assert.equal(index.sources.length, 1);
  assert.equal(index.observation, 'client_reported');
  assert.equal(index.verification, 'not_verified');
  const receipt = index.sources[0];
  const read = JSON.parse(
    session.reply(READ, { sourceId: receipt.sourceId, digest: receipt.digest }).text
  );
  assert.equal(read.page.text, output);
  assert.equal(read.source.trust, 'tool_data_not_instructions');
  assert.equal(
    session.complete([{ role: 'assistant', content: 'done' }], [], 'response-2').ok,
    true
  );
  const next = runtime.begin(request([user('next')], { previousResponseId: 'response-2' }));
  assert.equal(readList(next).sources[0].sourceId, receipt.sourceId);
  runtime.close();
});

test('publication withdrawal revokes committed descendants and preserves the original ancestor evidence', () => {
  const runtime = setup();
  root(runtime);
  const session = runtime.begin(continuation('source'), [result('source')]);
  assert.equal(
    session.complete([{ role: 'assistant', content: 'final' }], [], 'final-response').ok,
    true
  );
  const descendant = runtime.begin(
    request([user('next')], { previousResponseId: 'final-response' })
  );
  const sibling = runtime.begin(request([user('sibling')], { previousResponseId: 'response-1' }));
  assert.equal(descendant.inspect().active, true);
  session.withdraw();
  assert.equal(descendant.inspect().active, false);
  assert.equal(sibling.inspect().active, true);
  const replay = runtime.begin(request([user('retry')], { previousResponseId: 'final-response' }));
  assert.equal(replay.code, 'context_binding_previous_unavailable');
  session.withdraw();
  runtime.close();
});

test('old unobserved tool history is never accepted as new source evidence', () => {
  const runtime = setup();
  const session = runtime.begin(continuation('old'), [result('old')]);
  assert.equal(session.ok, true);
  assert.equal(readList(session).sources.length, 0);
  runtime.close();
});

test('parallel siblings have independent evidence views even for one ancestral call', () => {
  const runtime = setup();
  root(runtime);
  const a = runtime.begin(continuation('branch-a'), [result('branch-a')]);
  const b = runtime.begin(continuation('branch-b'), [result('branch-b')]);
  const ra = readList(a).sources[0],
    rb = readList(b).sources[0];
  assert.notEqual(ra.sourceId, rb.sourceId);
  assert.equal(
    JSON.parse(b.reply(READ, { sourceId: ra.sourceId, digest: ra.digest }).text).ok,
    false
  );
  assert.equal(
    JSON.parse(a.reply(READ, { sourceId: rb.sourceId, digest: rb.digest }).text).ok,
    false
  );
  assert.equal(
    a.complete([{ role: 'assistant', id: 'msg-a', content: 'a' }], [], 'response-a').ok,
    true
  );
  assert.equal(
    b.complete([{ role: 'assistant', id: 'msg-b', content: 'b' }], [], 'response-b').ok,
    true
  );
  const later = runtime.begin(request([user('later')], { previousResponseId: 'response-a' }));
  assert.deepEqual(
    readList(later).sources.map((s) => s.sourceId),
    [ra.sourceId]
  );
  runtime.close();
});

test('changing retained original bytes refuses a continuation without modifying earlier evidence', () => {
  const runtime = setup();
  root(runtime);
  const original = runtime.begin(continuation('original'), [result('original')]);
  original.complete([{ role: 'assistant', content: 'done' }], [], 'response-2');
  const changed = runtime.begin(request([user('next')], { previousResponseId: 'response-2' }), [
    result('changed'),
  ]);
  assert.equal(changed.code, 'context_recovery_source_conflict');
  const receipt = readList(original).sources[0];
  assert.equal(
    JSON.parse(original.reply(READ, { sourceId: receipt.sourceId, digest: receipt.digest }).text)
      .page.text,
    'original'
  );
  runtime.close();
});

test('new request views share task accounting while each round keeps its own small limit', () => {
  const runtime = setup();
  const first = root(runtime);
  const next = runtime.begin(continuation('value'), [result('value')]);
  for (let i = 0; i < 64; i++) {
    assert.equal(first.reply(LIST, {}).ok, true);
    assert.equal(next.reply(READ, {}).code, 'invalid_evidence_arguments');
  }
  assert.equal(first.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
  assert.equal(next.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
  assert.equal(next.inspect().readers.calls, 130);
  assert.equal(next.inspect().readers.round.calls, 64);
  runtime.close();
});

test('reader budget capability cannot be forged and independent budgets stay independent', () => {
  const ledger = {
    list() {
      return { ok: true, sources: [], nextAfterSourceId: null };
    },
    read() {
      return { ok: false, error: 'context_evidence_unavailable' };
    },
  };
  assert.throws(() => createContextEvidenceTools(ledger, {}), /Invalid evidence reader budget/);
  const budget = createContextEvidenceBudget();
  const a = createContextEvidenceTools(ledger, budget),
    b = createContextEvidenceTools(ledger, budget),
    c = createContextEvidenceTools(ledger);
  for (let i = 0; i < 64; i++) a.reply(LIST, {});
  assert.equal(b.reply(LIST, {}).ok, false);
  assert.equal(c.reply(LIST, {}).ok, true);
});

test('disable, revoke, expiry and close invalidate live views without token revival', () => {
  for (const action of ['disable', 'revoke', 'expire', 'close']) {
    let now = 1;
    const runtime = setup(() => now);
    const session = root(runtime);
    if (action === 'disable') runtime.configure(false);
    if (action === 'revoke') runtime.revoke('owner-a');
    if (action === 'expire') now = 24 * 60 * 60 * 1000 + 1;
    if (action === 'close') runtime.close();
    assert.equal(session.reply(LIST, {}).ok, false);
    if (action === 'disable') {
      runtime.configure(true);
      assert.equal(session.reply(LIST, {}).ok, false);
      assert.equal(runtime.begin(request()).ok, true);
    }
    runtime.close();
  }
});

test('failed, cancelled and malformed completions do not publish a history alias', () => {
  const runtime = setup();
  const session = runtime.begin(request());
  assert.equal(
    session.complete([tool], [{ ...call, arguments: null }]).code,
    'invalid_recovery_calls'
  );
  assert.equal(session.complete([tool], [call, call]).code, 'invalid_recovery_calls');
  session.abort();
  assert.equal(session.complete([tool], [call]).ok, false);
  assert.equal(runtime.inspect().roots, 0);
  assert.equal(runtime.begin(continuation('old'), [result('old')]).reason, 'isolated_request');
  runtime.close();
});

test('sensitive and incomplete results are excluded with safe counters', () => {
  for (const output of ['Bearer abcdefghijklmnop', 'Process running with session ID 42']) {
    const runtime = setup();
    root(runtime);
    const session = runtime.begin(continuation(output), [result(output)]);
    assert.equal(readList(session).sources.length, 0);
    assert.equal(runtime.inspect().rejected, 1);
    assert.equal(JSON.stringify(runtime.inspect()).includes(output), false);
    runtime.close();
  }
});

test('unknown, empty, invalid, oversized and accessor results cannot create raw evidence', () => {
  const runtime = setup();
  root(runtime);
  for (const reports of [
    null,
    {},
    [{ callId: 'call-1', output: 'a', sessionId: 'selected' }],
    [result('a'), result('b')],
    [{ callId: 'bad id', output: 'a' }],
    Array.from({ length: 129 }, (_, i) => ({ callId: 'call-' + i, output: 'a' })),
  ]) {
    assert.equal(runtime.begin(continuation('a'), reports).code, 'invalid_recovery_results');
  }
  let invoked = 0;
  const bad = { callId: 'call-1' };
  Object.defineProperty(bad, 'output', {
    enumerable: true,
    get() {
      invoked++;
      return 'data';
    },
  });
  assert.equal(runtime.begin(continuation('a'), [bad]).ok, false);
  assert.equal(invoked, 0);
  const empty = runtime.begin(continuation(''), [result('')]);
  const receipt = readList(empty).sources[0];
  assert.equal(
    JSON.parse(empty.reply(READ, { sourceId: receipt.sourceId, digest: receipt.digest }).text).page
      .text,
    ''
  );
  runtime.close();
});

test('active roots are never evicted to admit new conversations and abort releases new roots', () => {
  const runtime = setup();
  const roots = [];
  for (let i = 0; i < 4; i++) roots.push(runtime.begin(request([user('q' + i)])));
  assert.equal(runtime.begin(request()).code, 'context_recovery_quota');
  roots[0].abort();
  assert.equal(runtime.begin(request()).ok, true);
  runtime.close();
});

test('foreign principals, target changes and invalid clocks cannot read retained evidence', () => {
  const runtime = setup();
  root(runtime);
  assert.equal(
    runtime.begin(request([], { principal: 'owner-b', previousResponseId: 'response-1' })).ok,
    false
  );
  assert.equal(
    runtime.begin(request([], { target: 'target-b', previousResponseId: 'response-1' })).ok,
    false
  );
  runtime.close();
  for (const bad of [NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER]) {
    let now = 1;
    const broken = setup(() => now);
    const session = root(broken);
    now = bad;
    assert.equal(session.reply(LIST, {}).ok, false);
    now = 2;
    assert.equal(broken.begin(request()).ok, false);
  }
  assert.throws(() => createContextRecoverySessions({ now: 0 }));
  const disabled = createContextRecoverySessions();
  assert.equal(disabled.begin(request()).code, 'context_recovery_disabled');
  assert.throws(() => disabled.configure('true'));
  disabled.close();
});

test('async session commits exact hidden history and rebuilds it only for its committed branch', async () => {
  const runtime = setup();
  try {
    root(runtime);
    const source = '原文\r\nélève🙂';
    const input = continuation(source);
    const session = runtime.begin(input, [result(source)]);
    const receipt = readList(session).sources[0];
    const run = session.recovery({ messages: input.history });
    const next = await run.acceptAsync(
      completion([
        {
          id: 'async-read',
          name: READ,
          args: { sourceId: receipt.sourceId, digest: receipt.digest },
        },
      ])
    );
    assert.equal(next.mode, 'continue');
    assert.equal(JSON.parse(next.request.messages.at(-1).content).page.text, source);
    const released = await run.acceptAsync(completion());
    assert.equal(released.mode, 'release');
    assert.equal(session.complete(released.output, [], 'async-response').ok, true);
    const clientHistory = [...input.history, ...released.output, user('next')];
    const continued = runtime.begin(
      request(clientHistory, { previousResponseId: 'async-response' })
    );
    const resumed = continued.recovery({ messages: clientHistory });
    assert.equal(resumed.ok, true);
    const retained = resumed.initialRequest.messages.find(
      (item) => item.tool_call_id === 'async-read'
    );
    assert.equal(JSON.parse(retained.content).page.text, source);
    const sibling = runtime.begin(request([user('sibling')], { previousResponseId: 'response-1' }));
    assert.doesNotMatch(
      JSON.stringify(sibling.recovery({ messages: [user('sibling')] }).initialRequest),
      /async-read/
    );
  } finally {
    runtime.close();
  }
});

test('async session cancellation and revocation before a late reader cannot stage or commit history', async () => {
  for (const revoke of [false, true]) {
    const runtime = setup();
    try {
      root(runtime);
      const input = continuation('source');
      const session = runtime.begin(input, [result('source')]);
      let resolve;
      const gate = new Promise((yes) => {
        resolve = yes;
      });
      session.replyAsync = () => gate;
      const run = session.recovery({ messages: input.history });
      const pending = run.acceptAsync(completion([{ id: 'late-read', name: LIST }]));
      if (revoke) runtime.configure(false);
      else run.cancel();
      resolve({ ok: true, text: '{}' });
      const failed = await pending;
      assert.equal(failed.mode, 'failed');
      assert.equal(
        session.complete([{ role: 'assistant', content: 'done' }], [], 'late-response').ok,
        false
      );
      if (revoke) runtime.configure(true);
      assert.equal(
        runtime.begin(request([user('next')], { previousResponseId: 'late-response' })).ok,
        false
      );
    } finally {
      runtime.close();
    }
  }
});

test('session commits hidden history with public output and rebuilds it on the authorized next request', () => {
  const runtime = setup();
  root(runtime);
  const source = 'original🙂';
  const input = continuation(source);
  const session = runtime.begin(input, [result(source)]);
  const run = session.recovery({ messages: input.history });
  assert.equal(run.ok, true);
  assert.equal(session.recovery({ messages: input.history }).code, 'context_recovery_stale');
  assert.equal(
    session.complete([{ role: 'assistant', content: 'premature' }]).code,
    'context_recovery_output_conflict'
  );
  assert.equal(run.accept(completion([{ id: 'list-private', name: LIST }])).mode, 'continue');
  const released = run.accept(completion());
  assert.equal(released.mode, 'release');
  assert.equal(
    session.complete([user('wrong')], [], 'wrong-response').code,
    'context_recovery_output_conflict'
  );
  const reorderedOutput = released.output.map((item) =>
    Object.fromEntries(Object.entries(item).reverse())
  );
  assert.equal(session.complete(reorderedOutput, [], 'response-2').ok, true);
  const clientHistory = [...input.history, ...released.output, user('next')];
  const next = runtime.begin(request(clientHistory, { previousResponseId: 'response-2' }), [
    result(source),
  ]);
  assert.equal(next.ok, true);
  const continued = next.recovery({ messages: clientHistory });
  assert.equal(continued.ok, true);
  assert.match(JSON.stringify(continued.initialRequest.messages), /list-private/);
  assert.match(JSON.stringify(continued.initialRequest.messages), /nextAfterSourceId/);
  assert.doesNotMatch(JSON.stringify(clientHistory), /list-private/);
  runtime.revoke('owner-a');
  assert.equal(continued.accept(completion()).ok, false);
  runtime.close();
});

test('cancelled recovery does not publish hidden mappings or a response alias', () => {
  const runtime = setup();
  const session = runtime.begin(request());
  const run = session.recovery({ messages: request().history });
  assert.equal(run.accept(completion([{ id: 'private', name: LIST }])).mode, 'continue');
  assert.equal(run.accept(completion()).mode, 'release');
  run.cancel();
  assert.equal(
    session.complete([{ role: 'assistant', content: 'final' }], [], 'cancelled-response').ok,
    false
  );
  assert.equal(runtime.begin(request([], { previousResponseId: 'cancelled-response' })).ok, false);
  runtime.close();
});

test('withdrawing a committed private recovery makes its hidden mapping and response alias unusable', () => {
  const runtime = setup();
  root(runtime);
  const input = continuation('original');
  const session = runtime.begin(input, [result('original')]);
  const run = session.recovery({ messages: input.history });
  assert.equal(run.accept(completion([{ id: 'withdraw-private', name: LIST }])).mode, 'continue');
  const released = run.accept(completion());
  assert.equal(session.complete(released.output, [], 'withdrawn-response').ok, true);
  const clientHistory = [...input.history, ...released.output];
  const child = runtime.begin(request(clientHistory, { previousResponseId: 'withdrawn-response' }));
  const pending = child.recovery({ messages: clientHistory });
  assert.equal(pending.ok, true);
  session.withdraw();
  assert.equal(pending.accept(completion()).ok, false);
  assert.equal(
    runtime.begin(request(clientHistory, { previousResponseId: 'withdrawn-response' })).code,
    'context_binding_previous_unavailable'
  );
  assert.equal(
    runtime.begin(request([user('sibling')], { previousResponseId: 'response-1' })).ok,
    true
  );
  runtime.close();
});

test('recovery rejects changed public history, policy and accessor output without calling getters', () => {
  const runtime = setup();
  const history = request().history;
  const policy = { instructions: null, system: null, tools: null, toolChoice: null };
  const session = runtime.begin(request(history, { policy }));
  assert.equal(
    session.recovery({ messages: [user('changed')] }).code,
    'context_recovery_history_conflict'
  );
  assert.equal(
    session.recovery({ messages: history, tool_choice: 'none' }).code,
    'context_recovery_policy_conflict'
  );
  const run = session.recovery({ messages: history });
  assert.equal(run.ok, true);
  let invoked = false;
  const output = [
    {
      get role() {
        invoked = true;
        return 'assistant';
      },
    },
  ];
  assert.equal(session.complete(output).code, 'invalid_recovery_output');
  assert.equal(invoked, false);
  run.cancel();
  runtime.close();
});

test('Responses recovery cannot replace or omit its admitted provider ancestry', () => {
  const runtime = setup();
  const input = request([user('q')], { protocol: 'responses' });
  const first = runtime.begin(input);
  assert.equal(
    first.complete([{ type: 'message', role: 'assistant', content: [] }], [], 'r1').ok,
    true
  );
  for (const previous of ['r1', '']) {
    const root = runtime.begin(request([user('new')], { protocol: 'responses' }));
    assert.equal(
      root.recovery({ input: [user('new')], previous_response_id: previous }).code,
      'context_recovery_history_conflict'
    );
    root.abort();
  }
  for (const previous of [undefined, 'foreign', null, '']) {
    const next = runtime.begin({ ...input, history: [], previousResponseId: 'r1' });
    assert.equal(next.ok, true);
    assert.equal(
      next.recovery({
        input: [],
        ...(previous === undefined ? {} : { previous_response_id: previous }),
      }).code,
      'context_recovery_history_conflict'
    );
    next.abort();
  }
  assert.equal(runtime.begin({ ...input, previousResponseId: 'unobserved' }).ok, false);
  runtime.close();
});

test('Responses explicit null is equivalent to an omitted ancestor only for a full window', () => {
  const runtime = setup();
  try {
    const input = request([user('full window')], { protocol: 'responses' });
    const session = runtime.begin(input);
    assert.equal(session.ok, true);
    const recovery = session.recovery({ input: input.history, previous_response_id: null });
    assert.equal(recovery.ok, true);
    assert.equal(recovery.initialRequest.previous_response_id, null);
    recovery.cancel();
    session.abort();
    // Null is a wire-level alias for no ancestry, never a binding ID capability.
    assert.equal(runtime.begin({ ...input, previousResponseId: null }).ok, false);
  } finally {
    runtime.close();
  }
});

test('unsupported recovery controls retain a safe abort path for ordinary observation', () => {
  const runtime = setup();
  const session = runtime.begin(request());
  assert.equal(session.recovery({ messages: request().history, tool_choice: 'none' }).ok, false);
  assert.doesNotThrow(() => session.abort());
  assert.equal(runtime.inspect().roots, 0);
  runtime.close();
});
