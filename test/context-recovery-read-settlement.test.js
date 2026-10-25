'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createRecoveryReadSettlement,
  prepareRecoveryReadSettlement,
  assertRecoveryReadSettlement,
} = require('../lib/proxy/context-recovery-read-settlement');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const {
  createReferenceState,
  referenceStateFromCheckpoint,
} = require('../lib/proxy/context-recovery-reference-state');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { buildContextArtifactPage } = require('../lib/proxy/context-artifact-page');
const {
  contextEvidencePageBudget,
  attachContextEvidencePageSource,
} = require('../lib/proxy/context-evidence-page');
const { encodeContextEvidenceOutput } = require('../lib/proxy/context-evidence-output');
const { tagContextEvidenceResult } = require('../lib/proxy/context-evidence-observation');
const {
  supportsRecoveryReadSettlement,
} = require('../lib/proxy/context-recovery-storage-contract');

const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.cause === undefined;
const clone = (value) => globalThis.structuredClone(value);
function fixture(output = 'é🙂abc') {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  const binding = {
    principal: 'synthetic-owner',
    protocol: 'chat',
    target: 'synthetic-target',
    history: [{ role: 'user', content: 'synthetic' }],
  };
  const first = runtime.begin(binding);
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  assert.equal(
    first.complete(
      [tool],
      [{ callId: 'call', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
      'response'
    ).ok,
    true
  );
  const next = runtime.begin(
    {
      ...binding,
      history: [...binding.history, tool, { role: 'tool', tool_call_id: 'call', content: output }],
    },
    [{ callId: 'call', output }]
  );
  assert.equal(next.complete([{ role: 'assistant', content: 'done' }], [], 'next').ok, true);
  const state = createRootCheckpoint(exportContextRecoveryRoot(runtime, first.snapshotId), []);
  runtime.close();
  const initial = referenceStateFromCheckpoint(state),
    before = initial.metadata.budget;
  const reserved = createReferenceState(
    {
      ...initial.metadata,
      budget: { ...before, calls: before.calls + 1, returnedBytes: before.returnedBytes + 16384 },
    },
    []
  );
  const { sourceId, digest, bytes, callId, toolName, argumentsDigest, expiresAt } =
    initial.metadata.ledger.sources[0];
  const source = {
    sourceId,
    digest,
    bytes,
    callId,
    toolName,
    argumentsDigest,
    expiresAt,
    trust: 'tool_data_not_instructions',
  };
  const request = {
    operation: 'read-source-and-settle',
    scope: 'a'.repeat(64),
    expectedRevision: 2,
    source,
    arguments: { sourceId, digest, limitBytes: 2 },
    maxResultBytes: 16224,
    beforeBudget: before,
    observedAt: reserved.metadata.observedAt,
  };
  const page = (args = request.arguments) =>
    attachContextEvidencePageSource(
      buildContextArtifactPage(
        output,
        'utf8',
        digest,
        Object.fromEntries(
          Object.entries(args).filter(([name]) => ['offsetBytes', 'limitBytes'].includes(name))
        ),
        contextEvidencePageBudget(source, request.maxResultBytes)
      ),
      source,
      request.maxResultBytes
    );
  return { state, initial, reserved, request, page, output };
}
function engineFixture(output, createStore = createRecoverySqliteStore) {
  const f = fixture(output),
    database = new DatabaseSync(':memory:');
  let time = 100,
    failCommit = false,
    commits = 0,
    reads = 0;
  const store = createStore({
    database: {
      exec(sql) {
        if (sql === 'COMMIT') {
          commits++;
          if (failCommit) throw Error('PRIVATE');
        }
        return database.exec(sql);
      },
      prepare(sql) {
        const statement = database.prepare(sql);
        if (sql !== 'SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?') return statement;
        return {
          get(...args) {
            reads++;
            return statement.get(...args);
          },
        };
      },
    },
    dataKey: randomBytes(32).toString('base64'),
    now: () => time,
  });
  store.prepareAnchoredFormat();
  const save = (reference, payloads, expectedRevision) =>
    store.execute({
      operation: 'save-reference-state',
      scope: f.request.scope,
      expectedRevision,
      expiresAt: reference.metadata.expiresAt,
      reference,
      payloads,
    });
  save(
    f.initial,
    f.state.root.ledger.sources.map(({ sourceId, output }) => ({ sourceId, output })),
    0
  );
  save(f.reserved, [], 1);
  commits = reads = 0;
  return {
    ...f,
    database,
    store,
    get commits() {
      return commits;
    },
    get reads() {
      return reads;
    },
    time(value) {
      time = value;
    },
    failCommit() {
      failCommit = true;
    },
    row() {
      return database.prepare('SELECT * FROM recovery_state').get();
    },
    header() {
      return database.prepare('SELECT * FROM recovery_header').get();
    },
    close() {
      store.close();
      database.close();
    },
  };
}

test('composite settlement uses canonical encoded bytes and exact contiguous UTF-8 progress', () => {
  const f = fixture();
  const page = f.page();
  const result = createRecoveryReadSettlement(f.reserved, f.request, page, 101);
  assert.equal(result.budget.calls, 1);
  assert.equal(
    result.budget.returnedBytes,
    encodeContextEvidenceOutput(tagContextEvidenceResult(page)).bytes
  );
  assert.ok(
    result.budget.returnedBytes > encodeContextEvidenceOutput(page).bytes,
    'successful replies include the real session provenance envelope'
  );
  assert.equal(result.budget.successfulReads, 1);
  assert.equal(result.ledger.readCount, 1);
  assert.deepEqual(clone(result.ledger.sources), [
    { sourceId: f.request.source.sourceId, coveredThrough: 2, readComplete: false },
  ]);
  assertRecoveryReadSettlement(result, { ...result, observedAt: 102 });
  assertRecoveryReadSettlement(result, clone(result));
});

test('empty, repeated, seeking and failed pages preserve settlement semantics', () => {
  const empty = fixture('');
  const e = createRecoveryReadSettlement(empty.reserved, empty.request, empty.page(), 101);
  assert.equal(e.ledger.readCount, 1);
  assert.equal(e.budget.successfulReads, 1);
  const f = fixture();
  const seek = {
    ...f.request,
    arguments: { ...f.request.arguments, offsetBytes: 2, limitBytes: 4 },
  };
  const s = createRecoveryReadSettlement(f.reserved, seek, f.page(seek.arguments), 101);
  assert.deepEqual(s.ledger.sources, []);
  assert.equal(s.ledger.readCount, 1);
  const ref = createReferenceState(
    {
      ...f.reserved.metadata,
      budget: { ...f.reserved.metadata.budget, successfulReads: 1 },
      ledger: {
        ...f.reserved.metadata.ledger,
        readCount: 1,
        sources: f.reserved.metadata.ledger.sources.map((source) => ({
          ...source,
          coveredThrough: 2,
        })),
      },
    },
    []
  );
  const before = { ...f.request.beforeBudget, calls: 1, returnedBytes: 1000, successfulReads: 1 };
  const twice = createReferenceState(
    { ...ref.metadata, budget: { ...before, calls: 2, returnedBytes: 17384 } },
    []
  );
  const repeated = createRecoveryReadSettlement(
    twice,
    { ...f.request, beforeBudget: before },
    f.page(),
    101
  );
  assert.deepEqual(repeated.ledger.sources, []);
  assert.equal(repeated.ledger.readCount, 2);
  const failed = { ok: false, error: 'context_artifact_invalid_range' };
  const failure = createRecoveryReadSettlement(f.reserved, f.request, failed, 101);
  assert.equal(
    failure.budget.returnedBytes,
    encodeContextEvidenceOutput(tagContextEvidenceResult(failed)).bytes
  );
  assert.equal(failure.budget.successfulReads, 0);
  assert.equal(failure.ledger.readCount, 0);
  assert.deepEqual(failure.ledger.sources, []);
});

test('reservation/page admission rejects malformed, hostile, over-budget, rollback and expiry boundaries', () => {
  const f = fixture();
  let touched = 0;
  const hostile = Object.defineProperty({}, 'beforeBudget', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const request of [
    null,
    hostile,
    new Proxy(f.request, {}),
    { ...f.request, extra: true },
    { ...f.request, operation: 'read-source' },
    { ...f.request, beforeBudget: { ...f.request.beforeBudget, calls: 1 } },
    { ...f.request, beforeBudget: { ...f.request.beforeBudget, version: 1 } },
    { ...f.request, observedAt: 101 },
    { ...f.request, expectedRevision: 0 },
    { ...f.request, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...f.request, maxResultBytes: 0 },
    { ...f.request, maxResultBytes: 16225 },
    { ...f.request, maxResultBytes: 1 },
    { ...f.request, source: { ...f.request.source, bytes: 100 } },
    { ...f.request, arguments: { ...f.request.arguments, digest: 'f'.repeat(64) } },
  ])
    assert.throws(() => createRecoveryReadSettlement(f.reserved, request, f.page(), 101), safe);
  for (const time of [-1, NaN, 99, f.reserved.metadata.expiresAt])
    assert.throws(() => createRecoveryReadSettlement(f.reserved, f.request, f.page(), time), safe);
  for (const page of [
    null,
    {},
    { ...f.page(), page: { ...f.page().page, text: '\ud800' } },
    { ok: false, error: 'PRIVATE' },
  ])
    assert.throws(() => createRecoveryReadSettlement(f.reserved, f.request, page, 101), safe);
  assert.equal(touched, 0);
});

test('host comparison rejects accounting/progress substitutions and backward observed time', () => {
  const f = fixture();
  const result = createRecoveryReadSettlement(f.reserved, f.request, f.page(), 101);
  for (const mutate of [
    (value) => {
      value.observedAt = 100;
    },
    (value) => {
      value.budget.calls++;
    },
    (value) => {
      value.budget.returnedBytes++;
    },
    (value) => {
      value.budget.successfulReads = 0;
    },
    (value) => {
      value.ledger.readCount++;
    },
    (value) => {
      value.ledger.sources = [];
    },
    (value) => {
      value.rootId = 'hbs_' + 'b'.repeat(32);
    },
  ]) {
    const changed = clone(result);
    mutate(changed);
    assert.throws(() => assertRecoveryReadSettlement(result, changed), safe);
  }
});

test('engine combines page and settlement in exactly one commit preserving ciphertext and expiry', () => {
  const f = engineFixture();
  try {
    assert.equal(supportsRecoveryReadSettlement(f.store.execute), true);
    const row = f.row();
    const blobs = f.database.prepare('SELECT * FROM recovery_blob').all();
    f.time(101);
    const result = f.store.execute(f.request);
    assert.equal(f.commits, 1);
    assert.equal(result.revision, 3);
    assert.deepEqual(clone(result.page), f.page());
    assert.deepEqual(
      result.settlement,
      createRecoveryReadSettlement(f.reserved, f.request, result.page, 101)
    );
    const loaded = f.store.execute({ operation: 'load', scope: f.request.scope });
    assert.equal(loaded.expiresAt, row.expires_at);
    assert.equal(loaded.state.root.ledger.sources[0].output, f.output);
    assert.equal(loaded.state.root.budget.returnedBytes, result.settlement.budget.returnedBytes);
    assert.deepEqual(f.database.prepare('SELECT * FROM recovery_blob').all(), blobs);
  } finally {
    f.close();
  }
});

test('engine rejects bad CAS/debit before payload reads and rolls back failed commit and clock writes', () => {
  for (const mode of ['revision', 'budget', 'future', 'expiry', 'rollback', 'commit']) {
    const f = engineFixture();
    try {
      const before = f.row(),
        header = f.header();
      const request = clone(f.request);
      f.time(101);
      if (mode === 'revision') request.expectedRevision--;
      if (mode === 'budget') request.beforeBudget.calls++;
      if (mode === 'future') request.observedAt = 102;
      if (mode === 'expiry') f.time(f.reserved.metadata.expiresAt);
      if (mode === 'rollback') f.time(99);
      if (mode === 'commit') f.failCommit();
      assert.throws(() => f.store.execute(request), safe);
      if (mode !== 'commit') assert.equal(f.reads, 0);
      assert.deepEqual(f.row(), before);
      assert.deepEqual(f.header(), header);
    } finally {
      f.close();
    }
  }
});

test('engine settles a refused UTF-8 range without publishing bytes or advancing source progress', () => {
  const f = engineFixture();
  try {
    const result = f.store.execute({
      ...f.request,
      arguments: { ...f.request.arguments, offsetBytes: 1 },
    });
    assert.equal(result.page.ok, false);
    assert.equal(f.commits, 1);
    assert.equal(result.revision, 3);
    assert.equal(
      result.settlement.budget.returnedBytes,
      encodeContextEvidenceOutput(tagContextEvidenceResult(result.page)).bytes
    );
    assert.equal(result.settlement.budget.successfulReads, 0);
    assert.equal(result.settlement.ledger.readCount, 0);
    assert.deepEqual(result.settlement.ledger.sources, []);
  } finally {
    f.close();
  }
});

test('engine rejects corrupt selected ciphertext and legacy checkpoints without changing the pre-debit', () => {
  const f = engineFixture();
  try {
    const prior = f.row();
    const blob = f.database.prepare('SELECT * FROM recovery_blob').get();
    const corrupt = Buffer.from(blob.envelope);
    corrupt[corrupt.length - 1] ^= 1;
    f.database.prepare('UPDATE recovery_blob SET envelope=?').run(corrupt);
    assert.throws(() => f.store.execute(f.request), safe);
    assert.deepEqual(f.row(), prior);
    assert.equal(f.commits, 0);
  } finally {
    f.close();
  }
  const fixtureData = fixture(),
    database = new DatabaseSync(':memory:');
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  try {
    store.prepareAnchoredFormat();
    store.execute({
      operation: 'save',
      scope: fixtureData.request.scope,
      expectedRevision: 0,
      expiresAt: fixtureData.state.root.expiresAt,
      state: fixtureData.state,
    });
    const reserved = createRootCheckpoint(
      { ...fixtureData.state.root, budget: fixtureData.reserved.metadata.budget },
      []
    );
    store.execute({
      operation: 'save',
      scope: fixtureData.request.scope,
      expectedRevision: 1,
      expiresAt: reserved.root.expiresAt,
      state: reserved,
    });
    const prior = database.prepare('SELECT * FROM recovery_state').get();
    assert.throws(() => store.execute(fixtureData.request), safe);
    assert.deepEqual(database.prepare('SELECT * FROM recovery_state').get(), prior);
  } finally {
    store.close();
    database.close();
  }
});

test('bounded final allowance refunds canonical failure bytes without inventing a full reservation', () => {
  const f = fixture();
  const before = { ...f.request.beforeBudget, calls: 1, returnedBytes: 16 * 1024 * 1024 - 1000 };
  const reference = createReferenceState(
    { ...f.reserved.metadata, budget: { ...before, calls: 2, returnedBytes: 16 * 1024 * 1024 } },
    []
  );
  const page = { ok: false, error: 'context_artifact_budget_exceeded' };
  const result = createRecoveryReadSettlement(
    reference,
    { ...f.request, beforeBudget: before, maxResultBytes: 840 },
    page,
    101
  );
  assert.equal(
    result.budget.returnedBytes,
    before.returnedBytes + encodeContextEvidenceOutput(tagContextEvidenceResult(page)).bytes
  );
  const exhausted = { ...before, returnedBytes: 16 * 1024 * 1024 };
  assert.throws(
    () =>
      createRecoveryReadSettlement(reference, { ...f.request, beforeBudget: exhausted }, page, 101),
    safe
  );
});

test('combined evidence read and settlement authenticate the selected prior envelope once', (t) => {
  const f = engineFixture();
  try {
    const decode = TextDecoder.prototype.decode;
    let priorOpens = 0;
    t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
      const text = Reflect.apply(decode, this, args);
      const value = JSON.parse(text);
      if (
        value.kind === 'recovery-referenced-checkpoint' &&
        value.reference?.metadata.rootId === f.reserved.metadata.rootId &&
        value.reference.metadata.budget.returnedBytes === f.reserved.metadata.budget.returnedBytes
      )
        priorOpens++;
      return text;
    });
    const result = f.store.execute(f.request);
    assert.equal(priorOpens, 1);
    assert.equal(f.commits, 1);
    assert.equal(result.revision, f.request.expectedRevision + 1);
    assert.deepEqual(clone(result.page), f.page());
    assert.deepEqual(
      result.settlement,
      createRecoveryReadSettlement(f.reserved, f.request, result.page, 100)
    );
  } finally {
    f.close();
  }
});

test('combined read validates its owned reservation once before reading payloads', () => {
  const Module = require('node:module');
  const load = (file, replacements) => {
    const instance = new Module(file);
    const actual = Module.createRequire(file);
    instance.require = (name) => replacements[name] ?? actual(name);
    instance.load(file);
    return instance.exports;
  };
  let validations = 0;
  const reference = require('../lib/proxy/context-recovery-reference-state');
  const settlementFile = require.resolve('../lib/proxy/context-recovery-read-settlement');
  const settlement = load(settlementFile, {
    './context-recovery-reference-state': {
      ...reference,
      parseReferenceState(...args) {
        validations++;
        return reference.parseReferenceState(...args);
      },
    },
  });
  const engine = load(require.resolve('../lib/proxy/context-recovery-storage-sqlite'), {
    './context-recovery-read-settlement': settlement,
  });
  const f = engineFixture(undefined, engine.createRecoverySqliteStore);
  try {
    validations = 0;
    const result = f.store.execute(f.request);
    assert.equal(validations, 1);
    assert.equal(f.commits, 1);
    assert.equal(result.revision, f.request.expectedRevision + 1);
    assert.deepEqual(clone(result.page), f.page());
    assert.deepEqual(
      result.settlement,
      createRecoveryReadSettlement(f.reserved, f.request, result.page, 100)
    );
  } finally {
    f.close();
  }
});

test('prepared read settlement owns copied facts and can be consumed only once', () => {
  for (const output of ['', 'é🙂abc', 'x'.repeat(16384)]) {
    const f = fixture(output);
    const page = f.page();
    const expected = createRecoveryReadSettlement(f.reserved, f.request, page, 100);
    const settle = prepareRecoveryReadSettlement(f.reserved, f.request, 100);
    assert.equal(Object.isFrozen(settle), true);
    f.reserved.metadata.budget.calls = 999;
    f.request.beforeBudget.returnedBytes = 999;
    f.request.arguments.digest = '0'.repeat(64);
    f.request.maxResultBytes = 1;
    assert.deepEqual(settle(page), expected);
    assert.throws(() => settle(page), safe);
  }
});

test('prepared read settlement rejects invalid reservations and consumes failed page validation', () => {
  const f = fixture();
  for (const time of [-1, NaN, Number.MAX_SAFE_INTEGER, f.reserved.metadata.expiresAt])
    assert.throws(() => prepareRecoveryReadSettlement(f.reserved, f.request, time), safe);
  const unreserved = clone(f.reserved);
  unreserved.metadata.budget.calls = f.request.beforeBudget.calls;
  assert.throws(() => prepareRecoveryReadSettlement(unreserved, f.request, 100), safe);
  let touched = 0;
  const hostile = {
    get ok() {
      touched++;
      throw Error('PRIVATE');
    },
  };
  const proxy = new Proxy(
    {},
    {
      get() {
        touched++;
        throw Error('PRIVATE');
      },
    }
  );
  for (const page of [null, '', {}, hostile, proxy, { ok: true, private: 'x'.repeat(17000) }]) {
    const settle = prepareRecoveryReadSettlement(f.reserved, f.request, 100);
    assert.throws(() => settle(page), safe);
    assert.throws(() => settle(f.page()), safe);
  }
  assert.equal(touched, 0);
});
