'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  openContextRecoveryStorage,
  validateStorageResult,
} = require('../lib/proxy/context-recovery-storage');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createStorageCipher } = require('../lib/proxy/context-recovery-storage-cipher');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../lib/proxy/context-recovery-sessions');
const { recoverySqliteFaults } = require('./helpers/recovery-sqlite-fault.cjs');
const {
  createReferenceState,
  parseReferenceState,
  referenceStateFromCheckpoint,
  validateReferenceTransition,
  validateReferenceAgainstCurrent,
  hydrateReferenceState,
} = require('../lib/proxy/context-recovery-reference-state');
const { fingerprintContextData } = require('../lib/proxy/context-recovery-fingerprint');
const {
  storageRequest,
  supportsRecoveryReferenceStates,
  supportsRecoveryReferenceScan,
  declareRecoveryReferenceScan,
  storageReferenceScanPage,
} = require('../lib/proxy/context-recovery-storage-contract');
const { visitRecoveryReferenceStorage } = require('../lib/proxy/context-recovery-storage-scan');
const { discoverRecoveryStorage } = require('../lib/proxy/context-recovery-storage-discovery');
const { parseRecoveryReferenceRecord } = require('../lib/proxy/context-recovery-storage-record');
const {
  parseReaderSettlement,
  applyReaderSettlement,
  applyReferenceReaderSettlement,
} = require('../lib/proxy/context-recovery-reader-settlement');

const unavailable = { code: 'context_recovery_storage_unavailable' };
const original = 'synthetic-original\r\nélève🙂\u0000';
const sha = (value) => createHash('sha256').update(value).digest('hex');
function checkpoint(output = original, time = 100) {
  const outputs = Array.isArray(output) ? output : [output];
  const calls = outputs.map((value, index) => ({
    callId: 'call' + (index || ''),
    toolName: 'lookup',
    arguments: {},
    completed: true,
    output: '',
  }));
  const runtime = createContextRecoverySessions({ now: () => time });
  runtime.configure(true);
  const request = {
    principal: 'owner',
    protocol: 'chat',
    target: 'target',
    history: [{ role: 'user', content: 'q' }],
  };
  const tool = outputs.length
    ? {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.callId,
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        })),
      }
    : { role: 'assistant', content: 'done' };
  try {
    const session = runtime.begin(request);
    assert.equal(session.complete([tool], calls, 'r-1').ok, true);
    const next = runtime.begin(
      {
        ...request,
        history: [
          ...request.history,
          tool,
          ...outputs.map((value, index) => ({
            role: 'tool',
            tool_call_id: calls[index].callId,
            content: value,
          })),
        ],
      },
      outputs.map((value, index) => ({ callId: calls[index].callId, output: value }))
    );
    assert.equal(next.ok, true);
    assert.equal(next.complete([{ role: 'assistant', content: 'done' }], [], 'r-2').ok, true);
    return createRootCheckpoint(exportContextRecoveryRoot(runtime, session.snapshotId), []);
  } finally {
    runtime.close();
  }
}
function fixture(afterWrite = () => {}, rootScope) {
  const database = new DatabaseSync(':memory:');
  const key = randomBytes(32).toString('base64');
  let time = 100;
  const open = () =>
    createRecoverySqliteStore({
      database: recoverySqliteFaults(database, afterWrite),
      dataKey: key,
      now: () => time,
    });
  let store = open();
  const cipher = createStorageCipher(key);
  const scope = rootScope ?? sha('synthetic-scope');
  function context(row) {
    return {
      storeId: database.prepare('SELECT store_id FROM recovery_header').get().store_id,
      scope: row.scope,
      revision: row.revision,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      kind: row.kind,
      version: 1,
    };
  }
  return {
    database,
    scope,
    cipher,
    context,
    execute: (request) => store.execute(request),
    snapshot: () => store.snapshot(),
    save: (state, revision = 0, target = scope) =>
      store.execute({
        operation: 'save',
        scope: target,
        expectedRevision: revision,
        expiresAt: state.root?.expiresAt ?? 86400100,
        state,
      }),
    load: (target = scope) => store.execute({ operation: 'load', scope: target }),
    row: () => database.prepare('SELECT * FROM recovery_state WHERE scope=?').get(scope),
    version: () => database.prepare('PRAGMA user_version').get().user_version,
    reopen() {
      store.close();
      store = open();
    },
    time(value) {
      time = value;
    },
    close() {
      store.close();
      cipher.close();
      database.close();
    },
  };
}

function sourceRequest(state, scope) {
  const { sourceId, digest, bytes, callId, toolName, argumentsDigest, expiresAt } =
    state.root.ledger.sources[0];
  return {
    operation: 'read-source',
    scope,
    expectedRevision: 1,
    source: {
      sourceId,
      digest,
      bytes,
      callId,
      toolName,
      argumentsDigest,
      expiresAt,
      trust: 'tool_data_not_instructions',
    },
    arguments: { sourceId, digest },
    maxResultBytes: 16384,
  };
}

const stateRequest = (f, reference, payloads, expectedRevision = 0) => ({
  operation: 'save-reference-state',
  scope: f.scope,
  expectedRevision,
  expiresAt: reference.metadata.expiresAt,
  reference,
  payloads,
});
const checkpointPayloads = (state) =>
  [...state.root.ledger.sources, ...state.stagedSources].map(({ sourceId, output }) => ({
    sourceId,
    output,
  }));

test('reference hydration validates its created checkpoint without a third envelope clone', () => {
  const state = checkpoint('private synthetic output🙂'.repeat(1000));
  const reference = referenceStateFromCheckpoint(state);
  const payloads = checkpointPayloads(state);
  const file = require.resolve('../lib/proxy/context-recovery-root-checkpoint');
  const cached = require.cache[file];
  const data = require('../lib/proxy/context-recovery-state-data');
  const originalNormalize = data.normalizeRecoveryCheckpointData;
  let calls = 0;
  try {
    data.normalizeRecoveryCheckpointData = (...args) => {
      calls++;
      return originalNormalize(...args);
    };
    delete require.cache[file];
    const codec = require(file);
    data.normalizeRecoveryCheckpointData = originalNormalize;
    assert.deepEqual(hydrateReferenceState(reference, payloads), state);
    assert.equal(calls, 2);
    assert.deepEqual(codec.parseRootCheckpoint(state, state.root), state);
    assert.equal(calls, 3);
    const forged = globalThis.structuredClone(state);
    forged.root.budget.calls++;
    assert.throws(() => codec.parseRootCheckpoint(forged, state.root), unavailable);
  } finally {
    data.normalizeRecoveryCheckpointData = originalNormalize;
    require.cache[file] = cached;
  }
});

test('created checkpoint validation retains empty, malformed, capacity and hostile input boundaries', () => {
  const {
    createValidatedRootCheckpoint,
    parseRootCheckpoint,
  } = require('../lib/proxy/context-recovery-root-checkpoint');
  const rejectLikeOriginal = (root, staged, publications) => {
    let expected;
    assert.throws(
      () => parseRootCheckpoint(createRootCheckpoint(root, staged, publications), root),
      (error) => {
        expected = error;
        return true;
      }
    );
    assert.throws(
      () => createValidatedRootCheckpoint(root, staged, publications),
      (error) => {
        assert.equal(error.code, expected.code);
        assert.equal(error.message, expected.message);
        return true;
      }
    );
  };
  for (const output of [[], '', original, 'x'.repeat(600000)]) {
    const state = checkpoint(output);
    const actual = createValidatedRootCheckpoint(
      state.root,
      state.stagedSources,
      state.publications
    );
    assert.deepEqual(actual, parseRootCheckpoint(state, state.root));
    actual.root.budget.calls++;
    assert.notEqual(actual.root.budget.calls, state.root.budget.calls);
  }
  const state = checkpoint();
  for (const change of [
    (value) => {
      value.root.budget.calls = -1;
    },
    (value) => {
      value.root.callCount = Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.root.snapshots = [];
    },
    (value) => {
      value.root.ledger.sources[0].output = 'different';
    },
    (value) => {
      value.root.ledger.sources[0].output = 'x'.repeat(12 * 1024 * 1024 + 1);
    },
    (value) => {
      value.stagedSources = [null];
    },
    (value) => {
      value.publications = [{ snapshotId: 'hbs_' + 'a'.repeat(32), state: 'sending' }];
    },
  ]) {
    const value = globalThis.structuredClone(state);
    change(value);
    rejectLikeOriginal(value.root, value.stagedSources, value.publications);
  }
  for (const root of [null, {}, undefined]) rejectLikeOriginal(root, [], []);
  let traps = 0;
  const hostile = globalThis.structuredClone(state.root);
  Object.defineProperty(hostile, 'budget', {
    enumerable: true,
    get() {
      traps++;
      throw new Error('synthetic private input');
    },
  });
  rejectLikeOriginal(hostile, [], []);
  assert.equal(traps, 0);
  const proxy = new Proxy(state.root, {
    getOwnPropertyDescriptor() {
      traps++;
      throw new Error('synthetic private input');
    },
  });
  rejectLikeOriginal(proxy, [], []);
  assert.equal(traps, 0);
  const { normalizeRecoveryCheckpointData } = require('../lib/proxy/context-recovery-state-data');
  const inputProxy = new Proxy(
    { root: state.root },
    {
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error('synthetic private input');
      },
    }
  );
  assert.throws(() => normalizeRecoveryCheckpointData(inputProxy), {
    message: 'invalid_context_recovery_state_data',
  });
  assert.equal(traps, 0);
});

test('reference snapshots authenticate all payloads without hydrating a plaintext checkpoint', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const state = checkpoint(['x'.repeat(600000), 'é🙂', '']);
  f.execute(stateRequest(f, referenceStateFromCheckpoint(state), checkpointPayloads(state)));
  const codec = require('../lib/proxy/context-recovery-root-checkpoint');
  const hydrate = codec.createValidatedRootCheckpoint;
  let hydrated = 0;
  t.mock.method(codec, 'createValidatedRootCheckpoint', (...args) => {
    hydrated++;
    return hydrate(...args);
  });
  const prepare = f.database.prepare.bind(f.database);
  let payloads = 0,
    encryptedBytes = 0;
  t.mock.method(f.database, 'prepare', (sql) => {
    const statement = prepare(sql);
    if (sql !== 'SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?') return statement;
    return {
      get(...args) {
        const row = statement.get(...args);
        payloads++;
        encryptedBytes += row?.envelope.length ?? 0;
        return row;
      },
    };
  });
  for (let index = 0; index < 2; index++) {
    payloads = encryptedBytes = 0;
    const snapshot = f.snapshot();
    assert.equal(snapshot.scopes.length, 1);
    assert.equal(snapshot.scopes[0].revision, 1);
    assert.equal(snapshot.scopes[0].expiresAt, state.root.expiresAt);
    assert.equal(payloads, 3, 'every payload is authenticated again under each transaction');
    assert.ok(encryptedBytes > 600000);
    assert.equal(hydrated, 0, 'snapshot does not rebuild or normalize a full plaintext checkpoint');
  }
  assert.deepEqual(f.load().state, state);
  assert.equal(hydrated, 1, 'a full load still uses the original hydration validator');
});

test('reference snapshot authentication keeps empty roots and legacy checkpoint hydration', () => {
  for (const referenced of [false, true]) {
    const f = fixture();
    try {
      const state = checkpoint([]);
      if (referenced) f.execute(stateRequest(f, referenceStateFromCheckpoint(state), []));
      else f.save(state);
      assert.equal(f.snapshot().scopes[0].expiresAt, state.root.expiresAt);
      assert.deepEqual(f.load().state, state);
    } finally {
      f.close();
    }
  }
});

test('snapshot witnesses and quota agree with the fully hydrated checkpoint metadata', () => {
  for (const referenced of [false, true]) {
    const f = fixture();
    try {
      const state = checkpoint(['x'.repeat(600000), 'é🙂']);
      const reference = referenceStateFromCheckpoint(state);
      if (referenced) f.execute(stateRequest(f, reference, checkpointPayloads(state)));
      else f.save(state);
      const full = referenced ? hydrateReferenceState(reference, checkpointPayloads(state)) : state;
      assert.deepEqual(parseReferenceState(reference), referenceStateFromCheckpoint(full));
      const row = f.row();
      const context = f.context(row);
      const header = f.database.prepare('SELECT store_id, envelope FROM recovery_header').get();
      const payloadBytes = f.database
        .prepare('SELECT sum(length(envelope)) AS bytes FROM recovery_blob WHERE scope=?')
        .get(f.scope).bytes;
      const snapshot = f.snapshot();
      assert.deepEqual(snapshot, {
        storeId: header.store_id,
        maxTime: full.root.observedAt,
        scopes: [
          {
            scope: f.scope,
            revision: row.revision,
            createdAt: row.created_at,
            expiresAt: full.root.expiresAt,
            kind: 'state',
            tag: createHash('sha256')
              .update(row.envelope)
              .update(JSON.stringify(context))
              .digest('hex'),
          },
        ],
      });
      assert.deepEqual(f.execute({ operation: 'inspect' }), {
        records: 1,
        bytes: row.envelope.length + payloadBytes,
      });
      assert.deepEqual(f.load().state, full);
    } finally {
      f.close();
    }
  }
});

test('reference snapshot rejects missing, extra, substituted and authenticated malformed payloads', () => {
  for (const mode of [
    'missing',
    'extra',
    'swapped',
    'sourceId',
    'bytes',
    'digest',
    'utf8',
    'policy',
    'checksum',
    'metadata',
  ]) {
    const f = fixture();
    try {
      const state = checkpoint(['é🙂x', 'another']);
      const reference = referenceStateFromCheckpoint(state);
      f.execute(stateRequest(f, reference, checkpointPayloads(state)));
      assert.equal(f.snapshot().scopes.length, 1);
      const blobs = f.database
        .prepare('SELECT * FROM recovery_blob WHERE scope=? ORDER BY blob_id')
        .all(f.scope);
      const source = reference.metadata.ledger.sources[0];
      const id = (value) =>
        sha(
          JSON.stringify([
            'hpm/recovery/blob/v1',
            value.sourceId,
            value.digest,
            value.bytes,
            value.createdAt,
            value.expiresAt,
          ])
        );
      const blob = blobs.find((row) => row.blob_id === id(source));
      const blobContext = (row) => ({
        storeId: f.context(f.row()).storeId,
        scope: sha('hpm/recovery/blob/aad/v1\0' + row.scope + '\0' + row.blob_id),
        revision: 1,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        kind: 'state',
        version: 1,
      });
      if (mode === 'missing') {
        f.database
          .prepare('DELETE FROM recovery_blob WHERE scope=? AND blob_id=?')
          .run(f.scope, blob.blob_id);
      } else if (mode === 'extra') {
        f.database
          .prepare('INSERT INTO recovery_blob VALUES(?,?,?,?,?)')
          .run(f.scope, 'f'.repeat(64), blob.created_at, blob.expires_at, blob.envelope);
      } else if (mode === 'swapped') {
        const other = blobs.find((row) => row.blob_id !== blob.blob_id);
        f.database
          .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=? AND blob_id=?')
          .run(other.envelope, f.scope, blob.blob_id);
      } else if (mode === 'checksum' || mode === 'metadata') {
        const row = f.row();
        const envelope = f.cipher.open(f.context(row), row.envelope);
        if (mode === 'checksum') envelope.reference.digest = 'f'.repeat(64);
        else {
          envelope.reference.metadata.budget.calls = -1;
          const { digest: _digest, ...payload } = envelope.reference;
          envelope.reference.digest = fingerprintContextData(payload);
        }
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(f.cipher.seal(f.context(row), envelope), f.scope);
      } else if (mode === 'utf8') {
        const metadata = {
          ...reference.metadata,
          budget: { ...reference.metadata.budget, calls: 1 },
          ledger: {
            ...reference.metadata.ledger,
            readCount: 1,
            sources: reference.metadata.ledger.sources.map((value, index) =>
              index === 0 ? { ...value, coveredThrough: 1 } : value
            ),
          },
        };
        const row = f.row(),
          envelope = f.cipher.open(f.context(row), row.envelope);
        envelope.reference = createReferenceState(metadata, []);
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(f.cipher.seal(f.context(row), envelope), f.scope);
      } else {
        const value = f.cipher.open(blobContext(blob), blob.envelope);
        if (mode === 'policy') {
          value.output = 'Bearer syntheticcredential123456';
          value.bytes = Buffer.byteLength(value.output);
          value.digest = sha(value.output);
          const changed = { ...source, bytes: value.bytes, digest: value.digest };
          const metadata = {
            ...reference.metadata,
            ledger: {
              ...reference.metadata.ledger,
              sources: reference.metadata.ledger.sources.map((item, index) =>
                index === 0 ? changed : item
              ),
            },
          };
          const row = f.row(),
            envelope = f.cipher.open(f.context(row), row.envelope);
          envelope.reference = createReferenceState(metadata, []);
          f.database
            .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
            .run(f.cipher.seal(f.context(row), envelope), f.scope);
          const next = { ...blob, blob_id: id(changed) };
          f.database
            .prepare('UPDATE recovery_blob SET blob_id=?,envelope=? WHERE scope=? AND blob_id=?')
            .run(next.blob_id, f.cipher.seal(blobContext(next), value), f.scope, blob.blob_id);
        } else {
          if (mode === 'sourceId') value.sourceId = 'hce_' + 'e'.repeat(32);
          if (mode === 'bytes') value.bytes++;
          if (mode === 'digest') value.digest = 'e'.repeat(64);
          f.database
            .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=? AND blob_id=?')
            .run(f.cipher.seal(blobContext(blob), value), f.scope, blob.blob_id);
        }
      }
      for (let index = 0; index < 2; index++) assert.throws(() => f.snapshot(), unavailable);
    } finally {
      f.close();
    }
  }
});

test('reference snapshots retain whole hydrated envelope admission for dense escapes and aggregate payloads', () => {
  for (const [count, output, accepted] of [
    [8, '\0'.repeat(160000), true],
    [20, 'x'.repeat(160000), true],
    [16, '\0'.repeat(160000), false],
  ]) {
    const f = fixture();
    try {
      const state = checkpoint(Array.from({ length: count }, () => 'tiny'));
      const daily = referenceStateFromCheckpoint(state);
      f.execute(stateRequest(f, daily, checkpointPayloads(state)));
      const legacy = createReferenceState(
        {
          ...daily.metadata,
          sourceVersion: 8,
          ledger: {
            ...daily.metadata.ledger,
            policy: { ...daily.metadata.ledger.policy, maxBytes: 4 * 1024 * 1024 },
            sources: daily.metadata.ledger.sources.map((source) => ({
              ...source,
              bytes: Buffer.byteLength(output),
              digest: sha(output),
            })),
          },
        },
        []
      );
      // Authenticate an old-capacity manifest using the same retained payloads.
      // Metadata/raw-byte quota alone cannot prove the escaped full envelope fits.
      const row = f.row(),
        stored = f.cipher.open(f.context(row), row.envelope);
      const id = (source) =>
        sha(
          JSON.stringify([
            'hpm/recovery/blob/v1',
            source.sourceId,
            source.digest,
            source.bytes,
            source.createdAt,
            source.expiresAt,
          ])
        );
      for (const [index, source] of legacy.metadata.ledger.sources.entries()) {
        const newId = id(source);
        const context = {
          storeId: f.context(row).storeId,
          scope: sha('hpm/recovery/blob/aad/v1\0' + f.scope + '\0' + newId),
          revision: 1,
          createdAt: source.createdAt,
          expiresAt: source.expiresAt,
          kind: 'state',
          version: 1,
        };
        const envelope = f.cipher.seal(context, {
          version: 1,
          sourceId: source.sourceId,
          bytes: source.bytes,
          digest: source.digest,
          output,
        });
        f.database
          .prepare('UPDATE recovery_blob SET blob_id=?,envelope=? WHERE scope=? AND blob_id=?')
          .run(newId, envelope, f.scope, id(daily.metadata.ledger.sources[index]));
      }
      const payloads = legacy.metadata.ledger.sources.map(({ sourceId }) => ({ sourceId, output }));
      stored.reference = legacy;
      f.database
        .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
        .run(f.cipher.seal(f.context(row), stored), f.scope);
      if (accepted) {
        const full = hydrateReferenceState(legacy, payloads);
        assert.equal(f.snapshot().scopes[0].expiresAt, full.root.expiresAt);
        assert.deepEqual(f.load().state, full);
      } else {
        assert.throws(() => hydrateReferenceState(legacy, payloads), {
          code: 'invalid_recovery_reference_state',
        });
        assert.throws(() => f.load(), unavailable);
        assert.throws(() => f.snapshot(), unavailable);
      }
    } finally {
      f.close();
    }
  }
});

test('snapshots authenticate each reference inventory once and recheck expiry and ciphertext', (t) => {
  const f = fixture();
  try {
    assert.equal(f.snapshot().scopes.length, 0);
    const state = checkpoint();
    f.execute(stateRequest(f, referenceStateFromCheckpoint(state), checkpointPayloads(state)));
    const prepare = f.database.prepare.bind(f.database);
    let inventories = 0;
    t.mock.method(f.database, 'prepare', (sql) => {
      if (sql.startsWith('SELECT blob_id,created_at,expires_at,length(envelope)')) inventories++;
      return prepare(sql);
    });
    for (let index = 0; index < 2; index++) {
      inventories = 0;
      assert.equal(f.snapshot().scopes[0].expiresAt, state.root.expiresAt);
      assert.equal(inventories, 1, 'one authenticated inventory per snapshot; no cross-call cache');
    }
    const row = f.row();
    const opened = f.cipher.open(f.context(row), row.envelope);
    const changed = { ...row, expires_at: row.expires_at - 1 };
    f.database
      .prepare('UPDATE recovery_state SET expires_at=?,envelope=? WHERE scope=?')
      .run(changed.expires_at, f.cipher.seal(f.context(changed), opened), f.scope);
    assert.throws(() => f.snapshot(), unavailable);
    f.database
      .prepare('UPDATE recovery_state SET expires_at=?,envelope=? WHERE scope=?')
      .run(row.expires_at, row.envelope, f.scope);
    assert.equal(f.snapshot().scopes.length, 1);
    const blob = f.database.prepare('SELECT * FROM recovery_blob WHERE scope=?').get(f.scope);
    const corrupt = Buffer.from(blob.envelope);
    corrupt[corrupt.length - 1] ^= 1;
    f.database
      .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=? AND blob_id=?')
      .run(corrupt, f.scope, blob.blob_id);
    for (let index = 0; index < 2; index++) assert.throws(() => f.snapshot(), unavailable);
    f.database.prepare('DELETE FROM recovery_blob WHERE scope=?').run(f.scope);
    assert.throws(() => f.snapshot(), unavailable);
  } finally {
    f.close();
  }
});

test('reader settlement normalizes reserved reference input once while preserving complete validation', () => {
  const state = checkpoint();
  const reserved = referenceStateFromCheckpoint(
    createRootCheckpoint(
      { ...state.root, budget: { ...state.root.budget, calls: 1, returnedBytes: 16384 } },
      []
    )
  );
  const patch = {
    version: 2,
    kind: 'recovery-reader-settlement',
    rootId: reserved.metadata.rootId,
    observedAt: reserved.metadata.observedAt,
    budget: { ...reserved.metadata.budget, returnedBytes: 10 },
    ledger: { readCount: reserved.metadata.ledger.readCount, sources: [] },
  };
  const envelope = require('../lib/proxy/context-compaction-envelope');
  const stateData = require('../lib/proxy/context-recovery-state-data');
  const files = [
    require.resolve('../lib/proxy/context-recovery-reference-state'),
    require.resolve('../lib/proxy/context-recovery-reader-settlement'),
  ];
  const cached = files.map((file) => require.cache[file]);
  const normalizers = [
    [envelope, 'normalizeCompactionData'],
    [stateData, 'normalizeRecoveryReferenceData'],
  ];
  const originals = normalizers.map(([owner, name]) => owner[name]);
  let calls = 0;
  normalizers.forEach(([owner, name], index) => {
    owner[name] = (input, ...rest) => {
      if (
        input?.kind === 'recovery-reference-state' &&
        input.metadata?.budget?.returnedBytes === 16384
      )
        calls++;
      return Reflect.apply(originals[index], owner, [input, ...rest]);
    };
  });
  for (const file of files) delete require.cache[file];
  try {
    const codec = require('../lib/proxy/context-recovery-reader-settlement');
    const settled = codec.applyReferenceReaderSettlement(reserved, patch);
    assert.equal(calls, 1, 'one bounded clone before semantic validation and settlement');
    assert.equal(settled.metadata.budget.returnedBytes, 10);
    assert.equal(settled.metadata.expiresAt, reserved.metadata.expiresAt);
    assert.notEqual(settled.metadata, reserved.metadata);
    assert.equal(reserved.metadata.budget.returnedBytes, 16384);
    assert.deepEqual(codec.applyReferenceReaderSettlement(reserved, patch), settled);
    assert.equal(calls, 2, 'later callers still parse their own input');
    reserved.metadata.target = 'changed-after-first-read';
    assert.throws(() => codec.applyReferenceReaderSettlement(reserved, patch), {
      code: 'invalid_recovery_reader_settlement',
    });
  } finally {
    normalizers.forEach(([owner, name], index) => {
      owner[name] = originals[index];
    });
    files.forEach((file, index) => {
      require.cache[file] = cached[index];
    });
  }
});

test('reader reference parsing retains descriptor, checksum and independent-input boundaries', () => {
  const { parseReaderReferenceState } = require('../lib/proxy/context-recovery-reference-state');
  const reference = referenceStateFromCheckpoint(checkpoint());
  const parsed = parseReaderReferenceState(reference);
  assert.deepEqual(parsed, reference);
  assert.notEqual(parsed.metadata, reference.metadata);
  let hooks = 0;
  const accessor = Object.defineProperty({ ...reference }, 'metadata', {
    enumerable: true,
    get() {
      hooks++;
      throw new Error('PRIVATE');
    },
  });
  const coercion = {
    ...reference,
    toJSON() {
      hooks++;
      throw new Error('PRIVATE');
    },
  };
  const cycle = { ...reference };
  cycle.metadata = cycle;
  let deep = {};
  for (let index = 0; index < 65; index++) deep = { child: deep };
  for (const value of [
    undefined,
    null,
    {},
    [],
    '',
    accessor,
    coercion,
    cycle,
    { ...reference, metadata: deep },
    { ...reference, stagedSources: new Array(1) },
    { ...reference, stagedSources: Array(65536).fill(null) },
    { ...reference, digest: 'f'.repeat(64) },
    { ...reference, [Symbol('unknown')]: true },
    Object.assign(Object.create({ inherited: true }), reference),
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('PRIVATE');
        },
      }
    ),
  ]) {
    assert.throws(() => parseReaderReferenceState(value), {
      code: 'invalid_recovery_reference_state',
      message: 'invalid_recovery_reference_state',
    });
  }
  assert.equal(hooks, 0);
  reference.metadata.expiresAt++;
  assert.throws(() => parseReaderReferenceState(reference), {
    code: 'invalid_recovery_reference_state',
  });
  assert.notEqual(parsed.metadata.expiresAt, reference.metadata.expiresAt);
});

test('reader reference size admission preserves the old 12 MiB and reference-codec intersection', (t) => {
  const { parseReaderReferenceState } = require('../lib/proxy/context-recovery-reference-state');
  const { fingerprintNormalizedValue } = require('../lib/proxy/context-recovery-fingerprint-value');
  const rootCodec = require('../lib/proxy/context-recovery-root-state');
  let validations = 0;
  // Stop at the semantic boundary to measure exact byte admission separately.
  // These synthetic envelopes are never asserted to be valid recovery roots.
  t.mock.method(rootCodec, 'validateRecoveryRootMetadata', () => {
    validations++;
    throw new Error('PRIVATE');
  });
  for (const sourceVersion of [9, 10, 11, '10']) {
    const maximum = (sourceVersion === 10 ? 12 : 2) * 1024 * 1024;
    const payload = {
      version: 1,
      kind: 'recovery-reference-state',
      metadata: { kind: 'recovery-root-metadata', sourceVersion, padding: '' },
      stagedSources: [],
      publications: [],
    };
    const overhead = Buffer.byteLength(JSON.stringify({ ...payload, digest: '0'.repeat(64) }));
    for (const extra of [0, 1]) {
      payload.metadata.padding = 'x'.repeat(maximum - overhead + extra);
      const input = { ...payload, digest: fingerprintNormalizedValue(payload) };
      assert.equal(Buffer.byteLength(JSON.stringify(input)), maximum + extra);
      const before = validations;
      assert.throws(() => parseReaderReferenceState(input), {
        code: 'invalid_recovery_reference_state',
        message: 'invalid_recovery_reference_state',
      });
      assert.equal(validations - before, extra === 0 ? 1 : 0);
    }
  }
  const payload = {
    version: 1,
    kind: 'recovery-reference-state',
    metadata: { kind: 'recovery-root-metadata', sourceVersion: 9 },
    stagedSources: [],
    publications: [],
  };
  let versionReads = 0;
  const changing = new Proxy(payload.metadata, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'sourceVersion' && versionReads++ === 0
        ? { ...descriptor, value: 10 }
        : descriptor;
    },
  });
  const before = validations;
  assert.throws(
    () =>
      parseReaderReferenceState({
        ...payload,
        metadata: changing,
        digest: fingerprintNormalizedValue(payload),
      }),
    { code: 'invalid_recovery_reference_state' }
  );
  assert.equal(validations, before, 'a changing size selector is rejected before semantics');
});

function largeCheckpoint({
  count = 16,
  bytes = 1024 * 1024,
  escaped = false,
  now = () => 100,
  task = 0,
} = {}) {
  const runtime = createContextRecoverySessions({ now });
  runtime.configure(true);
  const request = {
    principal: 'large-owner',
    protocol: 'chat',
    target: 'large-target-' + task,
    history: [{ role: 'user', content: 'large-' + task }],
  };
  try {
    const first = runtime.begin(request);
    const calls = Array.from({ length: count }, (_, index) => ({
      callId: 'large-' + index,
      toolName: 'lookup',
      arguments: {},
      completed: true,
      output: '',
    }));
    const tool = {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.callId,
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      })),
    };
    assert.equal(first.complete([tool], calls, 'large-parent').ok, true);
    for (const [index, call] of calls.entries()) {
      const child = runtime.begin(
        {
          ...request,
          history: [{ role: 'user', content: 'capture-' + index }],
          previousResponseId: 'large-parent',
        },
        [{ callId: call.callId, output: (escaped ? '\u0000' : String(index % 10)).repeat(bytes) }]
      );
      assert.equal(child.ok, true);
      assert.equal(
        child.complete([{ role: 'assistant', content: 'saved' }], [], 'large-child-' + index).ok,
        true
      );
    }
    const root = exportContextRecoveryRoot(runtime, first.snapshotId);
    assert.equal(root.ledger.sources.length, count);
    return createRootCheckpoint(root, []);
  } finally {
    runtime.close();
  }
}

test('version 9 full and reference storage preserve escaped originals above the old transport ceiling', () => {
  const f = fixture();
  try {
    const state = largeCheckpoint({ count: 20, bytes: 160 * 1024, escaped: true });
    assert.ok(Buffer.byteLength(JSON.stringify(state)) > 12 * 1024 * 1024);
    f.save(state);
    f.reopen();
    assert.equal(f.load().state.digest, state.digest);
    const reference = referenceStateFromCheckpoint(state);
    f.execute(stateRequest(f, reference, [], 1));
    f.reopen();
    assert.equal(f.load().state.digest, state.digest);
    const reply = f.execute({ ...sourceRequest(state, f.scope), expectedRevision: 2 });
    assert.equal(reply.page.text, '\u0000'.repeat(reply.page.text.length));
    assert.ok(reply.page.text.length > 0);
    assert.equal(f.load().expiresAt, state.root.expiresAt);
    const mismatch = globalThis.structuredClone(state.root);
    mismatch.version = 8;
    mismatch.ledger.policy.maxBytes = 4 * 1024 * 1024;
    assert.throws(() => f.save(createRootCheckpoint(mismatch, []), 2), unavailable);
    assert.equal(f.load().revision, 2);
    assert.equal(f.load().state.root.version, 10);
    f.time(state.root.expiresAt);
    const before = f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n;
    assert.equal(before, 20);
    assert.equal(f.execute({ operation: 'sweep' }).removedRecords, 1);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
  } finally {
    f.close();
  }
});

test('full saves reject root capacity and budget category replacement without altering encrypted state', () => {
  const current = checkpoint();
  const legacy = createRootCheckpoint(
    {
      ...current.root,
      version: 8,
      ledger: {
        ...current.root.ledger,
        policy: { ...current.root.ledger.policy, maxBytes: 4 * 1024 * 1024 },
      },
    },
    []
  );
  const oldBudget = createRootCheckpoint(
    { ...current.root, budget: { ...current.root.budget, version: 1 } },
    []
  );
  for (const [prior, next] of [
    [legacy, current],
    [current, legacy],
    [oldBudget, current],
    [current, oldBudget],
  ]) {
    const f = fixture();
    try {
      f.save(prior);
      assert.throws(() => f.save(next, 1), unavailable);
      const loaded = f.load();
      assert.equal(loaded.revision, 1);
      assert.equal(loaded.state.digest, prior.digest);
      assert.equal(loaded.expiresAt, prior.root.expiresAt);
    } finally {
      f.close();
    }
  }
});

test(
  'actual encrypted worker reopens four sixteen-MiB roots with bounded full replies and exact source pages',
  { timeout: 120000 },
  async () => {
    if (process.platform !== 'win32') return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-large-storage-test-'));
    let storage;
    const states = [];
    try {
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      for (let task = 0; task < 4; task++) {
        const state = largeCheckpoint({ now: Date.now, task });
        const reference = referenceStateFromCheckpoint(state),
          scope = sha('hpm/recovery-root/v1\0' + state.root.rootId);
        assert.equal(
          (
            await storage.execute({
              operation: 'save-reference-state',
              scope,
              expectedRevision: 0,
              expiresAt: state.root.expiresAt,
              reference,
              payloads: checkpointPayloads(state),
            })
          ).revision,
          1
        );
        states.push({ state, reference, scope });
      }
      const usage = await storage.execute({ operation: 'inspect' });
      assert.equal(usage.records, 4);
      assert.ok(usage.bytes > 64 * 1024 * 1024);
      assert.ok(usage.bytes < 128 * 1024 * 1024);
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      for (const { state, reference, scope } of states) {
        const loaded = await storage.execute({ operation: 'load-reference', scope });
        assert.equal(loaded.reference.digest, reference.digest);
        assert.equal(loaded.expiresAt, state.root.expiresAt);
        const reply = await storage.execute(sourceRequest(state, scope));
        assert.equal(
          reply.page.text,
          state.root.ledger.sources[0].output.slice(0, reply.page.text.length)
        );
        assert.ok(reply.page.text.length > 0);
      }
      const first = states[0];
      const full = await storage.execute({ operation: 'load', scope: first.scope });
      assert.equal(full.state.digest, first.state.digest);
      assert.equal(full.expiresAt, first.state.root.expiresAt);
      for (let index = 0; index < 16; index++)
        assert.equal(
          full.state.root.ledger.sources[index].output,
          first.state.root.ledger.sources[index].output
        );
      const page = await storage.execute({ operation: 'scan', after: null });
      assert.equal(page.catalog.length, 4);
      assert.equal(page.record.state.root.ledger.sources.length, 16);
      await assert.rejects(
        storage.execute({
          operation: 'save',
          scope: 'f'.repeat(64),
          expectedRevision: 0,
          expiresAt: Date.now() + 60000,
          state: { synthetic: true },
        }),
        unavailable
      );
      assert.equal((await storage.execute({ operation: 'inspect' })).records, 4);
    } finally {
      try {
        await storage?.close();
      } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('hpm-large-storage-test-'));
        fs.rmSync(path.resolve(directory), { recursive: true, force: true });
      }
    }
  }
);

test('reference state has an independent metadata digest and cannot masquerade as a full checkpoint', () => {
  const state = checkpoint();
  const reference = referenceStateFromCheckpoint(state);
  assert.equal(reference.kind, 'recovery-reference-state');
  assert.equal(Object.hasOwn(reference, 'sourceDigest'), false);
  assert.equal(Object.hasOwn(reference.metadata.ledger.sources[0], 'output'), false);
  assert.deepEqual(hydrateReferenceState(reference, checkpointPayloads(state)), state);
  assert.deepEqual(validateReferenceTransition(reference, reference), reference);
  assert.deepEqual(validateReferenceTransition(reference, null), reference);
  const failure = { code: 'invalid_recovery_reference_state' };
  let invoked = 0;
  for (const input of [
    null,
    [],
    {},
    { ...reference, version: 2 },
    { ...reference, sourceDigest: state.digest },
    { ...reference, digest: 'f'.repeat(64) },
    Object.create({ secret: true }),
    Object.defineProperty({}, 'metadata', {
      enumerable: true,
      get() {
        invoked++;
        throw Error('private');
      },
    }),
    { ...reference, extra: 'x'.repeat(2 * 1024 * 1024) },
  ])
    assert.throws(() => parseReferenceState(input), failure);
  for (const payloads of [
    [],
    [...checkpointPayloads(state), ...checkpointPayloads(state)],
    [{ ...checkpointPayloads(state)[0], output: 'forged' }],
  ])
    assert.throws(() => hydrateReferenceState(reference, payloads), failure);
  assert.throws(() => referenceStateFromCheckpoint(reference), failure);
  assert.equal(invoked, 0);
});

test('reference state transitions reject immutable substitutions, counters and live-source loss', () => {
  const reference = referenceStateFromCheckpoint(checkpoint());
  const failure = { code: 'invalid_recovery_reference_state' };
  for (const mutate of [
    (value) => {
      value.metadata.binding.format = 2;
    },
    (value) => {
      value.metadata.ledger.sources[0].digest = 'f'.repeat(64);
    },
    (value) => {
      value.metadata.observedAt--;
    },
    (value) => {
      value.metadata.callCount = 0;
    },
    (value) => {
      value.metadata.budget.version = value.metadata.budget.version === 1 ? 2 : 1;
    },
    (value) => {
      value.metadata.ledger.capturedCount = 0;
    },
    (value) => {
      value.metadata.ledger.readCount = -1;
    },
    (value) => {
      value.metadata.rootId = 'hbs_' + 'f'.repeat(32);
    },
  ]) {
    const value = globalThis.structuredClone(reference);
    mutate(value);
    const { digest: _digest, ...payload } = value;
    value.digest = fingerprintContextData(payload);
    assert.throws(() => validateReferenceTransition(value, reference), failure);
  }
  const staged = {
    ...reference.metadata.ledger.sources[0],
    sourceId: 'hce_' + 'e'.repeat(32),
    callId: 'staged',
  };
  const prior = createReferenceState(
    { ...reference.metadata, ledger: { ...reference.metadata.ledger, capturedCount: 2 } },
    [staged]
  );
  const next = createReferenceState(prior.metadata, []);
  assert.throws(() => validateReferenceTransition(next, prior), failure);
});

test('reference scan visits one authenticated metadata generation without reading payload ciphertext', async () => {
  const first = checkpoint(),
    second = checkpoint('second');
  const scope = sha('hpm/recovery-root/v1\0' + first.root.rootId);
  const f = fixture(undefined, scope);
  try {
    const references = [first, second].map(referenceStateFromCheckpoint);
    for (const [index, state] of [first, second].entries())
      f.execute(
        stateRequest(
          { scope: sha('hpm/recovery-root/v1\0' + state.root.rootId) },
          references[index],
          checkpointPayloads(state)
        )
      );
    const queries = [],
      prepare = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    const visited = [];
    await visitRecoveryReferenceStorage(
      (request) => f.execute(request),
      (entry, record) => {
        assert.deepEqual(parseRecoveryReferenceRecord(record, entry), record);
        assert.equal(Object.hasOwn(record, 'state'), false);
        visited.push(record.reference.metadata.rootId);
      }
    );
    assert.deepEqual(visited.sort(), [first.root.rootId, second.root.rootId].sort());
    assert.equal(
      queries.some((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
      false
    );
    assert.equal(f.row().revision, 1);
    assert.deepEqual(f.load().state, first);
  } finally {
    f.close();
  }
});

test('reference scan rejects malformed pages, cursor/generation changes and never retries a failed declared operation', async () => {
  const first = checkpoint(),
    second = checkpoint('second');
  const f = fixture(undefined, sha('hpm/recovery-root/v1\0' + first.root.rootId));
  try {
    const empty = f.execute({ operation: 'scan-reference', after: null });
    assert.deepEqual(empty, { catalog: [], scope: null, record: null });
    for (const state of [first, second])
      f.execute(
        stateRequest(
          { scope: sha('hpm/recovery-root/v1\0' + state.root.rootId) },
          referenceStateFromCheckpoint(state),
          checkpointPayloads(state)
        )
      );
    const page = f.execute({ operation: 'scan-reference', after: null });
    assert.deepEqual(
      JSON.parse(JSON.stringify(validateStorageResult('scan-reference', page, null))),
      JSON.parse(JSON.stringify(page))
    );
    assert.throws(() => validateStorageResult('scan-reference', page, page.scope), unavailable);
    for (const value of [
      null,
      {},
      { ...page, extra: true },
      { ...page, scope: null, record: null },
      { ...page, record: { ...page.record, revision: 2 } },
      {
        ...page,
        record: { ...page.record, reference: { ...page.record.reference, digest: 'f'.repeat(64) } },
      },
    ])
      assert.throws(() => storageReferenceScanPage(value, null), unavailable);
    for (const after of ['', {}, 'f'.repeat(64)])
      assert.throws(() => f.execute({ operation: 'scan-reference', after }), unavailable);
    assert.throws(
      () =>
        parseRecoveryReferenceRecord(page.record, { ...page.catalog[0], scope: 'f'.repeat(64) }),
      unavailable
    );
    let calls = 0;
    await assert.rejects(
      visitRecoveryReferenceStorage(
        (request) => {
          calls++;
          const result = f.execute(request);
          if (calls === 2) result.catalog[0].revision++;
          return result;
        },
        () => {}
      ),
      unavailable
    );
    assert.equal(calls, 2);
    const operations = [];
    await assert.rejects(
      visitRecoveryReferenceStorage(
        (request) => {
          operations.push(request.operation);
          throw Error('private');
        },
        () => {}
      )
    );
    assert.deepEqual(operations, ['scan-reference']);
  } finally {
    f.close();
  }
});

test('startup reference discovery enrolls denial identities without hydrating live originals', async () => {
  const state = checkpoint();
  const f = fixture(undefined, sha('hpm/recovery-root/v1\0' + state.root.rootId));
  try {
    f.execute(stateRequest(f, referenceStateFromCheckpoint(state), checkpointPayloads(state)));
    const operations = [],
      queries = [],
      prepare = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    const execute = declareRecoveryReferenceScan((request) => {
      operations.push(request.operation);
      return f.execute(request);
    });
    assert.equal(supportsRecoveryReferenceScan(execute), true);
    assert.equal(supportsRecoveryReferenceScan(f.execute), false);
    assert.deepEqual(await discoverRecoveryStorage({ execute }), [
      {
        rootId: state.root.rootId,
        principal: state.root.principal,
        createdAt: state.root.createdAt,
        expiresAt: state.root.expiresAt,
      },
    ]);
    assert.deepEqual(operations, ['scan-reference']);
    assert.equal(
      queries.some((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
      false
    );
    assert.equal(f.row().revision, 1);
  } finally {
    f.close();
  }
});

test('reference startup explicitly authenticates staged cleanup and preserves published evidence and accounting', async () => {
  for (const corrupt of [false, true]) {
    const state = checkpoint();
    const initial = referenceStateFromCheckpoint(state);
    const staged = {
      ...initial.metadata.ledger.sources[0],
      sourceId: 'hce_' + 'e'.repeat(32),
      callId: 'abandoned',
    };
    const reference = createReferenceState(
      { ...initial.metadata, ledger: { ...initial.metadata.ledger, capturedCount: 2 } },
      [staged]
    );
    const f = fixture(undefined, sha('hpm/recovery-root/v1\0' + state.root.rootId));
    try {
      f.execute(
        stateRequest(f, reference, [
          ...checkpointPayloads(state),
          { sourceId: staged.sourceId, output: original },
        ])
      );
      if (corrupt)
        f.database.prepare('UPDATE recovery_blob SET envelope=zeroblob(length(envelope))').run();
      const operations = [];
      const execute = declareRecoveryReferenceScan((request) => {
        operations.push(request.operation);
        return f.execute(request);
      });
      if (corrupt) {
        await assert.rejects(discoverRecoveryStorage({ execute }), unavailable);
        assert.equal(f.row().revision, 1);
        assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 2);
        assert.deepEqual(operations, ['scan-reference', 'load']);
      } else {
        assert.equal((await discoverRecoveryStorage({ execute })).length, 1);
        assert.deepEqual(operations, ['scan-reference', 'load', 'save', 'load', 'catalog']);
        const loaded = f.load();
        assert.equal(loaded.revision, 2);
        assert.deepEqual(loaded.state.stagedSources, []);
        assert.equal(loaded.state.root.ledger.sources[0].output, original);
        assert.equal(loaded.state.root.ledger.capturedCount, 2);
        assert.deepEqual(loaded.state.root.budget, state.root.budget);
        assert.equal(loaded.expiresAt, state.root.expiresAt);
      }
    } finally {
      f.close();
    }
  }
});

test('reference transport replies reject malformed acknowledgements and executable input', () => {
  const reference = referenceStateFromCheckpoint(checkpoint());
  const valid = { createdAt: 100, expiresAt: reference.metadata.expiresAt, revision: 1, reference };
  assert.equal(validateStorageResult('load-reference', null), null);
  assert.deepEqual(validateStorageResult('load-reference', valid).reference, reference);
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'reference', {
    enumerable: true,
    get() {
      invoked++;
      throw Error('private');
    },
  });
  for (const input of [
    {},
    [],
    accessor,
    { ...valid, extra: true },
    { ...valid, revision: 0 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, createdAt: -1 },
    { ...valid, createdAt: valid.expiresAt },
    { ...valid, expiresAt: valid.expiresAt + 1 },
    { ...valid, createdAt: 101, expiresAt: valid.expiresAt + 1 },
    { ...valid, reference: { ...reference, version: 2 } },
  ])
    assert.throws(() => validateStorageResult('load-reference', input), unavailable);
  for (const input of [null, {}, { revision: 0 }, { revision: 1, extra: true }, { revision: 1.5 }])
    assert.throws(() => validateStorageResult('save-reference-state', input), unavailable);
  assert.equal(validateStorageResult('save-reference-state', { revision: 1 }).revision, 1);
  assert.equal(invoked, 0);
});

test('reference-state SQLite saves reuse ciphertext without raw reads and preserve legacy load and reopen', () => {
  for (const output of [original, '', []]) {
    const f = fixture();
    try {
      const state = checkpoint(output),
        reference = referenceStateFromCheckpoint(state);
      assert.equal(supportsRecoveryReferenceStates(f.execute), false);
      assert.deepEqual(f.execute(stateRequest(f, reference, checkpointPayloads(state))), {
        revision: 1,
      });
      assert.equal(f.cipher.open(f.context(f.row()), f.row().envelope).version, 3);
      const cipher = f.database.prepare('SELECT envelope FROM recovery_blob').get()?.envelope;
      const queries = [],
        prepare = f.database.prepare.bind(f.database);
      f.database.prepare = (sql) => {
        queries.push(sql);
        return prepare(sql);
      };
      const loaded = f.execute({ operation: 'load-reference', scope: f.scope });
      assert.deepEqual(loaded.reference, reference);
      assert.deepEqual(f.execute(stateRequest(f, reference, [], 1)), { revision: 2 });
      assert.equal(
        queries.some((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
        false
      );
      assert.deepEqual(
        f.database.prepare('SELECT envelope FROM recovery_blob').get()?.envelope,
        cipher
      );
      assert.deepEqual(f.load().state, state);
      f.reopen();
      const reopened = f.execute({ operation: 'load-reference', scope: f.scope });
      assert.deepEqual(reopened.reference, reference);
      assert.equal(reopened.revision, 2);
      assert.equal(reopened.expiresAt, state.root.expiresAt);
      if (state.root.ledger.sources.length)
        assert.equal(
          f.execute({ ...sourceRequest(state, f.scope), expectedRevision: 2 }).page.text,
          output
        );
      else assert.deepEqual(reopened.reference.metadata.ledger.sources, []);
      assert.deepEqual(f.load().state, state);
      assert.throws(() => f.execute(stateRequest(f, reference, [], 1)), unavailable);
    } finally {
      f.close();
    }
  }
});

test('reference progress authenticates only the changed source and rejects UTF-8 splits and regression', () => {
  const f = fixture();
  try {
    const state = checkpoint(['é🙂x', 'unselected']),
      initial = referenceStateFromCheckpoint(state);
    f.execute(stateRequest(f, initial, checkpointPayloads(state)));
    const progress = (coveredThrough, readComplete = false) =>
      createReferenceState(
        {
          ...initial.metadata,
          budget: { ...initial.metadata.budget, calls: 1 },
          ledger: {
            ...initial.metadata.ledger,
            readCount: 1,
            sources: initial.metadata.ledger.sources.map((source, index) =>
              index === 0 ? { ...source, coveredThrough, readComplete } : source
            ),
          },
        },
        []
      );
    const queries = [],
      prepare = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    for (const offset of [1, 3, 5]) {
      assert.throws(() => f.execute(stateRequest(f, progress(offset), [], 1)), unavailable);
      assert.equal(f.row().revision, 1);
    }
    queries.length = 0;
    const partial = progress(2);
    f.execute(stateRequest(f, partial, [], 1));
    assert.deepEqual(
      queries.filter((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
      ['SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?']
    );
    assert.throws(() => f.execute(stateRequest(f, progress(0), [], 2)), unavailable);
    const complete = progress(7, true);
    f.execute(stateRequest(f, complete, [], 2));
    assert.throws(() => f.execute(stateRequest(f, partial, [], 3)), unavailable);
    assert.equal(f.row().revision, 3);
    assert.deepEqual(
      f.execute({ operation: 'load-reference', scope: f.scope }).reference,
      complete
    );
    assert.equal(f.load().state.root.ledger.sources[0].readComplete, true);
  } finally {
    f.close();
  }
});

for (const version of [1, 2])
  test(`reference reader settlement v${version} keeps format three and authenticates changed-source progress only`, () => {
    let fault = false,
      observed = 0;
    const f = fixture((sql, args, result) => {
      if (fault && sql.startsWith('INSERT INTO recovery_state')) {
        observed++;
        assert.equal(result.changes, 1);
        throw Error('private');
      }
    });
    try {
      const state = checkpoint(['é🙂x', 'unselected']),
        initial = referenceStateFromCheckpoint(state);
      const reserved = createReferenceState(
        {
          ...initial.metadata,
          budget: { ...initial.metadata.budget, calls: 1, returnedBytes: 16384 },
        },
        []
      );
      f.execute(stateRequest(f, reserved, checkpointPayloads(state)));
      const blobs = f.database.prepare('SELECT * FROM recovery_blob').all();
      f.database
        .prepare('UPDATE recovery_blob SET envelope=zeroblob(length(envelope)) WHERE blob_id=?')
        .run(blobs[1].blob_id);
      const settlement = {
        version,
        kind: 'recovery-reader-settlement',
        rootId: reserved.metadata.rootId,
        observedAt: 100,
        budget: { ...reserved.metadata.budget, returnedBytes: 100, successfulReads: 1 },
        ledger: {
          readCount: 1,
          sources: reserved.metadata.ledger.sources
            .slice(0, version === 1 ? 2 : 1)
            .map((source, index) => ({
              sourceId: source.sourceId,
              coveredThrough: index === 0 ? 2 : 0,
              readComplete: false,
            })),
        },
      };
      const request = {
        operation: 'settle-reader',
        scope: f.scope,
        expectedRevision: 1,
        settlement,
      };
      for (const patch of [
        { observedAt: 101 },
        { rootId: 'hbs_' + 'f'.repeat(32) },
        { budget: { ...settlement.budget, calls: 2 } },
        { budget: { ...settlement.budget, version: settlement.budget.version === 1 ? 2 : 1 } },
        { budget: { ...settlement.budget, returnedBytes: 16385 } },
        { ledger: { ...settlement.ledger, readCount: 2 } },
        ...(version === 1 ? [{ ledger: { ...settlement.ledger, sources: [] } }] : []),
        {
          ledger: {
            ...settlement.ledger,
            sources: settlement.ledger.sources.map((source, index) =>
              index === 0 ? { ...source, coveredThrough: 1 } : source
            ),
          },
        },
      ]) {
        assert.throws(
          () => f.execute({ ...request, settlement: { ...settlement, ...patch } }),
          unavailable
        );
        assert.equal(f.row().revision, 1);
      }
      fault = true;
      assert.throws(() => f.execute(request), unavailable);
      assert.equal(observed, 1);
      assert.equal(f.row().revision, 1);
      assert.equal(
        f.cipher.open(f.context(f.row()), f.row().envelope).reference.metadata.budget.returnedBytes,
        16384
      );
      fault = false;
      const queries = [],
        prepare = f.database.prepare.bind(f.database);
      f.database.prepare = (sql) => {
        queries.push(sql);
        return prepare(sql);
      };
      assert.deepEqual(f.execute(request), { revision: 2 });
      assert.deepEqual(
        queries.filter((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
        ['SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?']
      );
      const persisted = f.cipher.open(f.context(f.row()), f.row().envelope);
      assert.equal(persisted.version, 3);
      assert.equal(persisted.reference.metadata.budget.returnedBytes, 100);
      assert.equal(persisted.reference.metadata.ledger.readCount, 1);
      assert.equal(persisted.reference.metadata.ledger.sources[0].coveredThrough, 2);
      assert.equal(f.row().expires_at, initial.metadata.expiresAt);
      assert.throws(() => f.execute(request), unavailable);
      assert.throws(() => f.load(), unavailable);
      f.database
        .prepare('UPDATE recovery_blob SET envelope=? WHERE blob_id=?')
        .run(blobs[1].envelope, blobs[1].blob_id);
      assert.equal(f.load().state.root.budget.successfulReads, 1);
    } finally {
      f.close();
    }
  });

test('sparse settlements preserve omitted progress and reject malformed or widening updates', () => {
  const state = checkpoint(['é🙂x', '', 'unchanged']);
  const reserved = createRootCheckpoint(
    { ...state.root, budget: { ...state.root.budget, calls: 1, returnedBytes: 16384 } },
    []
  );
  const source = reserved.root.ledger.sources[0];
  const delta = {
    version: 2,
    kind: 'recovery-reader-settlement',
    rootId: reserved.root.rootId,
    observedAt: 100,
    budget: { ...reserved.root.budget, returnedBytes: 100, successfulReads: 1 },
    ledger: {
      readCount: 1,
      sources: [{ sourceId: source.sourceId, coveredThrough: 2, readComplete: false }],
    },
  };
  for (const referenceOnly of [false, true]) {
    const apply = referenceOnly ? applyReferenceReaderSettlement : applyReaderSettlement;
    const initial = referenceOnly ? referenceStateFromCheckpoint(reserved) : reserved;
    const settled = apply(initial, delta);
    const root = referenceOnly ? settled.metadata : settled.root;
    assert.equal(root.ledger.sources[0].coveredThrough, 2);
    assert.deepEqual(
      root.ledger.sources.slice(1),
      (referenceOnly ? initial.metadata : initial.root).ledger.sources.slice(1)
    );
    assert.equal(root.expiresAt, state.root.expiresAt);
    assert.equal(root.budget.calls, 1);

    // An omitted source on a LIST/re-read/denied result retains its prior
    // progress. A v1 complete-inventory message must still name every source.
    const unchanged = { ...delta, budget: root.budget, ledger: { readCount: 1, sources: [] } };
    assert.deepEqual(apply(settled, unchanged), settled);
    assert.throws(() => apply(settled, { ...unchanged, version: 1 }), {
      code: 'invalid_recovery_reader_settlement',
    });
    for (const patch of [
      { version: 0 },
      { version: 3 },
      { observedAt: state.root.expiresAt },
      { principal: 'other-owner' },
      { budget: { ...delta.budget, calls: 2 } },
      {
        budget: { ...delta.budget, returnedBytes: 0 },
        ledger: { readCount: 0, sources: delta.ledger.sources },
      },
      {
        ledger: {
          readCount: 1,
          sources: [{ ...delta.ledger.sources[0], sourceId: 'hce_' + 'f'.repeat(32) }],
        },
      },
      { ledger: { readCount: 1, sources: [...delta.ledger.sources, ...delta.ledger.sources] } },
      {
        ledger: {
          readCount: 1,
          sources: [{ ...delta.ledger.sources[0], coveredThrough: source.bytes + 1 }],
        },
      },
      { ledger: { readCount: 1, sources: [{ ...delta.ledger.sources[0], readComplete: true }] } },
    ])
      assert.throws(() => apply(initial, { ...delta, ...patch }), {
        code: 'invalid_recovery_reader_settlement',
      });

    assert.throws(
      () =>
        apply(settled, {
          ...delta,
          ledger: { readCount: 2, sources: [{ ...delta.ledger.sources[0], coveredThrough: 0 }] },
        }),
      { code: 'invalid_recovery_reader_settlement' }
    );
  }
  let invoked = false;
  const hostile = { ...delta };
  Object.defineProperty(hostile, 'ledger', {
    enumerable: true,
    get() {
      invoked = true;
      throw Error('private');
    },
  });
  for (const input of [
    null,
    [],
    hostile,
    { ...delta, ledger: { readCount: 1, sources: new Array(1) } },
    {
      ...delta,
      ledger: {
        readCount: 1,
        sources: [{ ...delta.ledger.sources[0], coveredThrough: Number.MAX_SAFE_INTEGER }],
      },
    },
    { ...delta, padding: 'x'.repeat(16384) },
  ])
    assert.throws(() => parseReaderSettlement(input), {
      code: 'invalid_recovery_reader_settlement',
    });
  assert.equal(invoked, false);
});

test('version 8 encrypted references retain 100 sources across reopen, selected read settlement and revocation', () => {
  const f = fixture();
  try {
    const state = checkpoint(Array.from({ length: 100 }, (_, index) => 'value-' + index));
    const initial = referenceStateFromCheckpoint(state);
    assert.equal(initial.metadata.sourceVersion, 10);
    f.execute(stateRequest(f, initial, checkpointPayloads(state)));
    f.reopen();
    assert.deepEqual(f.load().state.root.ledger.sources, state.root.ledger.sources);
    const reserved = createReferenceState(
      {
        ...initial.metadata,
        budget: { ...initial.metadata.budget, calls: 1, returnedBytes: 16384 },
      },
      []
    );
    f.execute(stateRequest(f, reserved, [], 1));
    const source = initial.metadata.ledger.sources[99];
    const delta = {
      version: 2,
      kind: 'recovery-reader-settlement',
      rootId: initial.metadata.rootId,
      observedAt: 100,
      budget: { ...reserved.metadata.budget, returnedBytes: 100, successfulReads: 1 },
      ledger: {
        readCount: 1,
        sources: [{ sourceId: source.sourceId, coveredThrough: source.bytes, readComplete: true }],
      },
    };
    f.execute({
      operation: 'settle-reader',
      scope: f.scope,
      expectedRevision: 2,
      settlement: delta,
    });
    f.reopen();
    const loaded = f.load();
    assert.equal(loaded.state.root.ledger.sources.length, 100);
    assert.equal(loaded.state.root.ledger.sources[99].output, 'value-99');
    assert.equal(loaded.state.root.ledger.sources[99].readComplete, true);
    assert.deepEqual(
      loaded.state.root.ledger.sources.slice(0, 99),
      state.root.ledger.sources.slice(0, 99)
    );
    assert.equal(loaded.expiresAt, initial.metadata.expiresAt);
    f.execute({ operation: 'revoke', scope: f.scope, expectedRevision: 3 });
    assert.equal(f.load(), null);
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM recovery_blob').get().count, 0);
  } finally {
    f.close();
  }
});

test('sparse settlement size stays bounded with 64 retained sources and LIST reads no payloads', () => {
  const f = fixture();
  try {
    const state = checkpoint(Array.from({ length: 64 }, (_, index) => 'value-' + index));
    const initial = referenceStateFromCheckpoint(state);
    const reserved = createReferenceState(
      {
        ...initial.metadata,
        budget: { ...initial.metadata.budget, calls: 1, returnedBytes: 16384 },
      },
      []
    );
    f.execute(stateRequest(f, reserved, checkpointPayloads(state)));
    const queries = [];
    const prepare = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    const delta = {
      version: 2,
      kind: 'recovery-reader-settlement',
      rootId: reserved.metadata.rootId,
      observedAt: 100,
      budget: { ...reserved.metadata.budget, returnedBytes: 100 },
      ledger: { readCount: 0, sources: [] },
    };
    f.execute({
      operation: 'settle-reader',
      scope: f.scope,
      expectedRevision: 1,
      settlement: delta,
    });
    assert.equal(queries.filter((sql) => sql.startsWith('SELECT * FROM recovery_blob')).length, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(delta)) < 512);
    const restored = f.load();
    assert.deepEqual(restored.state.root.ledger.sources, state.root.ledger.sources);
    assert.equal(restored.expiresAt, initial.metadata.expiresAt);
    assert.equal(restored.state.root.budget.returnedBytes, 100);
    f.reopen();
    assert.deepEqual(f.load(), restored);
  } finally {
    f.close();
  }
});

test('reference LIST settlement supports no sources without payload queries or deadline renewal', () => {
  const f = fixture();
  try {
    const initial = referenceStateFromCheckpoint(checkpoint([]));
    const reserved = createReferenceState(
      {
        ...initial.metadata,
        budget: { ...initial.metadata.budget, calls: 1, returnedBytes: 16384 },
      },
      []
    );
    f.execute(stateRequest(f, reserved, []));
    const settlement = {
      version: 1,
      kind: 'recovery-reader-settlement',
      rootId: reserved.metadata.rootId,
      observedAt: 100,
      budget: { ...reserved.metadata.budget, returnedBytes: 0 },
      ledger: { readCount: 0, sources: [] },
    };
    f.execute({ operation: 'settle-reader', scope: f.scope, expectedRevision: 1, settlement });
    const loaded = f.execute({ operation: 'load-reference', scope: f.scope });
    assert.equal(loaded.revision, 2);
    assert.equal(loaded.reference.metadata.budget.calls, 1);
    assert.equal(loaded.reference.metadata.budget.returnedBytes, 0);
    assert.equal(loaded.expiresAt, initial.metadata.expiresAt);
    assert.deepEqual(f.load().state.root.ledger.sources, []);
    assert.equal(f.cipher.open(f.context(f.row()), f.row().envelope).version, 3);
  } finally {
    f.close();
  }
});

test('reference revocation and expiry preserve the absolute deadline and remove authenticated payloads', () => {
  for (const mode of ['revoke', 'expiry']) {
    const f = fixture();
    try {
      const state = checkpoint(),
        initial = referenceStateFromCheckpoint(state);
      f.execute(stateRequest(f, initial, checkpointPayloads(state)));
      f.time(200);
      const next = createReferenceState({ ...initial.metadata, observedAt: 200 }, []);
      f.execute(stateRequest(f, next, [], 1));
      assert.equal(f.row().created_at, 100);
      assert.equal(f.row().expires_at, initial.metadata.expiresAt);
      if (mode === 'revoke')
        f.execute({ operation: 'revoke', scope: f.scope, expectedRevision: 2 });
      else {
        const bytes = f.execute({ operation: 'inspect' }).bytes;
        f.time(initial.metadata.expiresAt);
        assert.deepEqual(f.execute({ operation: 'load-reference', scope: f.scope }), null);
        assert.deepEqual(f.execute({ operation: 'sweep' }), {
          removedRecords: 1,
          removedBytes: bytes,
        });
      }
      assert.equal(f.execute({ operation: 'load-reference', scope: f.scope }), null);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
      assert.throws(() => f.execute(stateRequest(f, next, [], 2)), unavailable);
    } finally {
      f.close();
    }
  }
});

test('authenticated reference envelopes reject malformed formats and header substitutions without mutation', () => {
  const f = fixture();
  try {
    const state = checkpoint(),
      reference = referenceStateFromCheckpoint(state);
    f.execute(stateRequest(f, reference, checkpointPayloads(state)));
    const row = f.row(),
      envelope = f.cipher.open(f.context(row), row.envelope);
    for (const value of [
      { ...envelope, version: 4 },
      { ...envelope, extra: true },
      { ...envelope, reference: { ...reference, digest: 'f'.repeat(64) } },
    ]) {
      f.database
        .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
        .run(f.cipher.seal(f.context(row), value), f.scope);
      assert.throws(() => f.execute({ operation: 'load-reference', scope: f.scope }), unavailable);
      assert.equal(f.row().revision, 1);
    }
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(row.envelope, f.scope);
    const blob = f.database.prepare('SELECT * FROM recovery_blob').get();
    for (const [column, value] of [
      ['created_at', blob.created_at + 1],
      ['expires_at', blob.expires_at - 1],
    ]) {
      f.database.prepare('UPDATE recovery_blob SET ' + column + '=?').run(value);
      assert.throws(() => f.execute({ operation: 'load-reference', scope: f.scope }), unavailable);
      f.database.prepare('UPDATE recovery_blob SET ' + column + '=?').run(blob[column]);
    }
    assert.deepEqual(
      f.execute({ operation: 'load-reference', scope: f.scope }).reference,
      reference
    );
    assert.ok(Buffer.from(f.row().envelope).equals(Buffer.from(row.envelope)));
  } finally {
    f.close();
  }
});

test('reference operations reject malformed transport, missing payloads, future clocks and missing blobs', () => {
  const f = fixture();
  try {
    const state = checkpoint(),
      reference = referenceStateFromCheckpoint(state);
    const request = stateRequest(f, reference, checkpointPayloads(state));
    for (const value of [
      { ...request, scope: 'invalid' },
      { ...request, expectedRevision: -1 },
      { ...request, expectedRevision: Number.MAX_SAFE_INTEGER },
      { ...request, expiresAt: reference.metadata.expiresAt + 1 },
      { ...request, extra: true },
      { operation: 'load-reference', scope: f.scope, extra: true },
      {
        ...request,
        payloads: [{ sourceId: reference.metadata.ledger.sources[0].sourceId, output: '\ud800' }],
      },
      { ...request, reference: { ...reference, version: 2 } },
    ])
      assert.throws(() => storageRequest(value), unavailable);
    for (const payloads of [
      [],
      [{ ...request.payloads[0], output: 'forged' }],
      [...request.payloads, { sourceId: 'hce_' + 'f'.repeat(32), output: 'unused' }],
    ])
      assert.throws(() => f.execute({ ...request, payloads }), unavailable);
    assert.equal(f.row(), undefined);
    const future = createReferenceState(
      { ...reference.metadata, observedAt: 101 },
      reference.stagedSources
    );
    assert.throws(() => f.execute({ ...request, reference: future }), unavailable);
    f.execute(request);
    assert.throws(() => f.execute({ ...request, expectedRevision: 1 }), unavailable);
    f.database.prepare('DELETE FROM recovery_blob').run();
    assert.throws(() => f.execute({ operation: 'load-reference', scope: f.scope }), unavailable);
    assert.throws(() => f.execute({ ...request, payloads: [], expectedRevision: 1 }), unavailable);
  } finally {
    f.close();
  }
});

test(
  'actual encrypted worker exposes reference save/load, exact pages and legacy load across reopen',
  { timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-reference-worker-'));
    const directory = path.join(root, 'store');
    let storage;
    t.after(async () => {
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-reference-worker-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    });
    const state = checkpoint(original, Date.now()),
      reference = referenceStateFromCheckpoint(state);
    const scope = sha('actual-reference-worker');
    storage = await openContextRecoveryStorage({ directory });
    assert.equal(supportsRecoveryReferenceStates(storage.execute), true);
    assert.equal(
      (await storage.execute(stateRequest({ scope }, reference, checkpointPayloads(state))))
        .revision,
      1
    );
    const before = await storage.execute({ operation: 'load-reference', scope });
    assert.deepEqual(before.reference, reference);
    assert.equal((await storage.execute(sourceRequest(state, scope))).page.text, original);
    assert.deepEqual((await storage.execute({ operation: 'load', scope })).state, state);
    await storage.close();
    storage = undefined;
    storage = await openContextRecoveryStorage({ directory });
    assert.deepEqual(await storage.execute({ operation: 'load-reference', scope }), before);
    assert.equal((await storage.execute(sourceRequest(state, scope))).page.text, original);
    assert.equal(
      fs.readFileSync(path.join(directory, 'checkpoint.sqlite')).includes(Buffer.from(original)),
      false
    );
  }
);

test('reference-only loads and unchanged saves preserve a corrupt unselected payload until a checked read', () => {
  const f = fixture();
  try {
    const state = checkpoint([original, 'second-synthetic']),
      reference = referenceStateFromCheckpoint(state);
    f.execute(stateRequest(f, reference, checkpointPayloads(state)));
    const rows = f.database.prepare('SELECT * FROM recovery_blob').all();
    const second = state.root.ledger.sources[1];
    // Locate by the independently encrypted source metadata, never SQL order.
    const secondId = sha(
      JSON.stringify([
        'hpm/recovery/blob/v1',
        second.sourceId,
        second.digest,
        second.bytes,
        second.createdAt,
        second.expiresAt,
      ])
    );
    const corrupt = rows.find((row) => row.blob_id === secondId);
    const changed = Buffer.from(corrupt.envelope);
    changed[changed.length - 1] ^= 1;
    f.database
      .prepare('UPDATE recovery_blob SET envelope=? WHERE blob_id=?')
      .run(changed, secondId);
    assert.deepEqual(
      f.execute({ operation: 'load-reference', scope: f.scope }).reference,
      reference
    );
    f.execute(stateRequest(f, reference, [], 1));
    assert.equal(
      f.execute({ ...sourceRequest(state, f.scope), expectedRevision: 2 }).page.text,
      original
    );
    const other = {
      ...state,
      root: { ...state.root, ledger: { ...state.root.ledger, sources: [second] } },
    };
    assert.throws(
      () => f.execute({ ...sourceRequest(other, f.scope), expectedRevision: 2 }),
      unavailable
    );
    assert.throws(() => f.load(), unavailable);
    assert.ok(
      Buffer.from(
        f.database.prepare('SELECT envelope FROM recovery_blob WHERE blob_id=?').get(secondId)
          .envelope
      ).equals(changed)
    );
    assert.throws(
      () => f.execute({ operation: 'revoke', scope: f.scope, expectedRevision: 2 }),
      unavailable
    );
    f.time(state.root.expiresAt);
    assert.throws(() => f.execute({ operation: 'sweep' }), unavailable);
    assert.equal(f.row().revision, 2);
  } finally {
    f.close();
  }
});

test('reference-state atomic writes roll back new blobs and metadata together before retry', () => {
  let fault = false;
  const f = fixture((sql) => {
    if (fault && sql.startsWith('INSERT INTO recovery_state')) throw Error('synthetic-state-fault');
  });
  try {
    const state = checkpoint(),
      reference = referenceStateFromCheckpoint(state);
    f.execute(stateRequest(f, reference, checkpointPayloads(state)));
    const row = f.row(),
      old = f.database.prepare('SELECT envelope FROM recovery_blob').get().envelope;
    const source = {
      ...reference.metadata.ledger.sources[0],
      sourceId: 'hce_' + 'd'.repeat(32),
      callId: 'staged',
      digest: sha('new'),
      bytes: 3,
    };
    const next = createReferenceState(
      { ...reference.metadata, ledger: { ...reference.metadata.ledger, capturedCount: 2 } },
      [source]
    );
    const request = stateRequest(f, next, [{ sourceId: source.sourceId, output: 'new' }], 1);
    fault = true;
    assert.throws(() => f.execute(request), unavailable);
    assert.deepEqual(f.row(), row);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 1);
    fault = false;
    assert.deepEqual(f.execute(request), { revision: 2 });
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 2);
    assert.ok(
      f.database
        .prepare('SELECT envelope FROM recovery_blob')
        .all()
        .some((value) => Buffer.from(value.envelope).equals(old))
    );
    assert.deepEqual(f.execute({ operation: 'load-reference', scope: f.scope }).reference, next);
  } finally {
    f.close();
  }
});

test('inline and blob checkpoint migrations keep original expiry, bytes and controlled legacy write-back', () => {
  for (const inline of [false, true]) {
    const f = fixture();
    try {
      const state = checkpoint(),
        reference = referenceStateFromCheckpoint(state);
      if (inline) {
        f.save({ synthetic: true });
        const row = f.row();
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(f.cipher.seal(f.context(row), state), f.scope);
        assert.equal(f.version(), 1);
      } else f.save(state);
      assert.deepEqual(
        f.execute({ operation: 'load-reference', scope: f.scope }).reference,
        reference
      );
      f.execute(stateRequest(f, reference, [], 1));
      assert.equal(f.version(), 2);
      assert.equal(f.cipher.open(f.context(f.row()), f.row().envelope).version, 3);
      const restored = f.load();
      assert.deepEqual(restored.state, state);
      assert.equal(restored.expiresAt, state.root.expiresAt);
      f.save(restored.state, 2);
      assert.equal(f.cipher.open(f.context(f.row()), f.row().envelope).version, 2);
      assert.deepEqual(f.load().state, state);
    } finally {
      f.close();
    }
  }
});

test('encrypted source-page selection reads only its selected blob and pins revision and metadata', () => {
  const f = fixture();
  try {
    const state = checkpoint();
    f.save(state);
    const request = sourceRequest(state, f.scope);
    const queries = [];
    const prepare = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    const value = f.execute(request);
    assert.equal(value.page.text, original);
    assert.deepEqual(
      queries.filter((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
      ['SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?']
    );
    assert.equal(f.row().revision, 1);
    assert.equal(f.row().expires_at, state.root.expiresAt);
    for (const change of [
      { expectedRevision: 2 },
      { scope: sha('unknown') },
      { source: { ...request.source, bytes: request.source.bytes + 1 } },
      { source: { ...request.source, toolName: 'other' } },
      { source: { ...request.source, expiresAt: request.source.expiresAt + 1 } },
      { source: { ...request.source, argumentsDigest: sha('other') } },
      {
        source: { ...request.source, sourceId: 'hce_' + 'f'.repeat(32) },
        arguments: { ...request.arguments, sourceId: 'hce_' + 'f'.repeat(32) },
      },
    ])
      assert.throws(() => f.execute({ ...request, ...change }), unavailable);
    assert.equal(
      f.execute({ ...request, maxResultBytes: 0 }).error,
      'context_artifact_budget_exceeded'
    );
    assert.equal(
      f.execute({ ...request, arguments: { ...request.arguments, offsetBytes: 1e6 } }).error,
      'context_artifact_invalid_range'
    );
    f.time(request.source.expiresAt);
    assert.throws(() => f.execute(request), unavailable);
  } finally {
    f.close();
  }
});

test('source-page reads reject missing and corrupt encrypted payloads without repairing or rewriting them', () => {
  const f = fixture();
  try {
    const state = checkpoint();
    f.save(state);
    const request = sourceRequest(state, f.scope);
    const row = f.database.prepare('SELECT * FROM recovery_blob').get();
    f.database.prepare('UPDATE recovery_blob SET envelope=?').run(Buffer.from('corrupt'));
    assert.throws(() => f.execute(request), unavailable);
    assert.equal(f.row().revision, 1);
    assert.equal(
      Buffer.from(
        f.database.prepare('SELECT envelope FROM recovery_blob').get().envelope
      ).toString(),
      'corrupt'
    );
    f.database.prepare('DELETE FROM recovery_blob').run();
    assert.throws(() => f.execute(request), unavailable);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
    f.database
      .prepare('INSERT INTO recovery_blob VALUES(?,?,?,?,?)')
      .run(row.scope, row.blob_id, row.created_at, row.expires_at, row.envelope);
    assert.equal(f.execute(request).page.text, original);
  } finally {
    f.close();
  }
});

test('source-page reads retain inline legacy and empty-source semantics', () => {
  for (const output of [original, '']) {
    const f = fixture();
    try {
      const state = checkpoint(output);
      f.save(state);
      const request = sourceRequest(state, f.scope);
      assert.equal(f.execute(request).page.text, output);
      const row = f.row();
      f.database
        .prepare('UPDATE recovery_state SET envelope=?')
        .run(f.cipher.seal(f.context(row), state));
      f.database.prepare('DELETE FROM recovery_blob').run();
      assert.equal(f.execute(request).page.text, output);
      assert.equal(f.row().revision, 1);
    } finally {
      f.close();
    }
  }
});

test('checkpoint above 2 MiB persists escaped originals through encrypted reopen without widening request admission', () => {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  const f = fixture();
  runtime.configure(true);
  try {
    const basis = {
      principal: 'owner',
      protocol: 'chat',
      target: 'target',
      history: [{ role: 'user', content: 'large' }],
    };
    const calls = Array.from({ length: 7 }, (_, index) => ({
      callId: 'large-' + index,
      toolName: 'lookup',
      arguments: {},
      output: '',
      completed: true,
    }));
    const first = runtime.begin(basis);
    assert.equal(
      first.complete(
        [
          {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.callId,
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            })),
          },
        ],
        calls,
        'large-response'
      ).ok,
      true
    );
    const originals = calls.map(
      (call, index) => 'private-large-' + index + '\\'.repeat(400 * 1024) + '🙂\r\n\u0000'
    );
    for (let index = 0; index < calls.length; index++) {
      const child = runtime.begin(
        {
          ...basis,
          history: [{ role: 'user', content: 'capture-' + index }],
          previousResponseId: 'large-response',
        },
        [{ callId: calls[index].callId, output: originals[index] }]
      );
      assert.equal(child.ok, true);
      assert.equal(
        child.complete([{ role: 'assistant', content: 'saved' }], [], 'large-saved-' + index).ok,
        true
      );
    }
    const root = exportContextRecoveryRoot(runtime, first.snapshotId);
    assert.equal(root.ledger.sources.length, originals.length);
    assert.equal(root.ledger.policy.maxBytes, 16 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(root)) > 2 * 1024 * 1024);
    assert.throws(() => fingerprintContextData({ root, stagedSources: [], publications: [] }));
    const state = createRootCheckpoint(root, []);
    assert.deepEqual(f.save(state), { revision: 1 });
    for (const row of f.database.prepare('SELECT envelope FROM recovery_blob').all()) {
      assert.equal(Buffer.from(row.envelope).includes(Buffer.from('private-large-')), false);
    }
    f.reopen();
    const loaded = f.load();
    assert.equal(loaded.state.digest, state.digest);
    assert.equal(loaded.expiresAt, root.expiresAt);
    assert.deepEqual(
      loaded.state.root.ledger.sources.map((source) => source.output),
      originals
    );
    const reference = referenceStateFromCheckpoint(loaded.state);
    assert.deepEqual(hydrateReferenceState(reference, checkpointPayloads(loaded.state)), state);
    assert.deepEqual(f.execute(stateRequest(f, reference, [], 1)), { revision: 2 });
    f.reopen();
    assert.deepEqual(f.load().state, state);
    const request = { ...sourceRequest(state, f.scope), expectedRevision: 2 };
    assert.equal(
      f.execute(request).page.text,
      originals[0].slice(0, f.execute(request).page.text.length)
    );
    f.time(root.expiresAt);
    assert.equal(f.load(), null);
  } finally {
    runtime.close();
    f.close();
  }
});

test('real checkpoint save atomically selects layout two and reuses immutable encrypted originals', () => {
  const writes = [];
  const f = fixture((sql) => writes.push(sql));
  try {
    const state = checkpoint();
    assert.equal(f.version(), 1);
    f.save(state);
    assert.equal(f.version(), 2);
    const stored = f.cipher.open(f.context(f.row()), f.row().envelope);
    assert.equal(stored.kind, 'recovery-referenced-checkpoint');
    assert.equal(stored.version, 2);
    assert.equal(stored.checkpoint.root.ledger.sources[0].output, undefined);
    assert.match(stored.checkpoint.root.ledger.sources[0].outputRef, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(stored).includes('synthetic-original'), false);
    const blob = Buffer.from(
      f.database.prepare('SELECT envelope FROM recovery_blob').get().envelope
    );
    const changedRoot = { ...state.root, budget: { ...state.root.budget, calls: 1 } };
    const changed = createRootCheckpoint(changedRoot, []);
    writes.length = 0;
    f.save(changed, 1);
    assert.equal(
      writes.some((sql) => sql.startsWith('INSERT INTO recovery_blob')),
      false
    );
    assert.deepEqual(
      Buffer.from(f.database.prepare('SELECT envelope FROM recovery_blob').get().envelope),
      blob
    );
    assert.deepEqual(f.load().state, changed);
    const bytes = f.row().envelope.length + blob.length;
    assert.equal(f.execute({ operation: 'inspect' }).bytes, bytes);
    f.reopen();
    assert.deepEqual(f.load().state, changed);
    assert.equal(f.load().expiresAt, state.root.expiresAt);
    f.execute({ operation: 'revoke', scope: f.scope, expectedRevision: 2 });
    assert.equal(f.load(), null);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
    assert.throws(() => f.save(state, 3), unavailable);
  } finally {
    f.close();
  }
});

test('legacy inline checkpoints migrate on save without replacing authority, IDs, expiry or budget', () => {
  const f = fixture();
  try {
    const state = checkpoint();
    f.save({ legacy: true });
    const row = f.row();
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(f.cipher.seal(f.context(row), state), f.scope);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.load().state, state);
    f.save(state, 1);
    assert.equal(f.version(), 2);
    assert.deepEqual(f.load(), {
      revision: 2,
      createdAt: 100,
      expiresAt: state.root.expiresAt,
      state,
    });
    const before = Buffer.from(f.row().envelope);
    f.database.exec('PRAGMA user_version=1');
    assert.throws(() => f.load(), unavailable);
    assert.deepEqual(Buffer.from(f.row().envelope), before);
    f.database.exec('PRAGMA user_version=2');
    f.reopen();
    assert.deepEqual(f.load().state, state);
  } finally {
    f.close();
  }
});

test('new blob write failure rolls back layout, authenticated watermark and prior checkpoint together', () => {
  let armed = false,
    observed = 0;
  const f = fixture((sql, args, result) => {
    if (armed && sql.startsWith('INSERT INTO recovery_blob')) {
      observed++;
      assert.equal(result.changes, 1);
      throw new Error('synthetic-private-error');
    }
  });
  try {
    f.save({ prior: true });
    const before = f.database.prepare('SELECT * FROM recovery_header').all();
    armed = true;
    f.time(101);
    assert.throws(() => f.save(checkpoint(), 1), unavailable);
    assert.equal(observed, 1);
    assert.equal(f.version(), 1);
    assert.equal(
      f.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='recovery_blob'").get(),
      undefined
    );
    assert.deepEqual(f.database.prepare('SELECT * FROM recovery_header').all(), before);
    assert.deepEqual(f.load().state, Object.assign(Object.create(null), { prior: true }));
  } finally {
    f.close();
  }
});

test('manifest publication and batch revoke faults roll back blob changes after actual SQL mutations', () => {
  let fault = '',
    observed = 0;
  const f = fixture((sql, args, result) => {
    if (fault && sql.startsWith(fault)) {
      observed++;
      assert.equal(result.changes, 1);
      throw new Error('private');
    }
  });
  try {
    const state = checkpoint();
    f.save(state);
    const before = f.database.prepare('SELECT * FROM recovery_blob').all();
    const next = checkpoint('new original');
    fault = 'INSERT INTO recovery_state';
    assert.throws(() => f.save(next, 1), unavailable);
    assert.equal(observed, 1);
    fault = '';
    assert.deepEqual(f.load().state, state);
    assert.deepEqual(f.database.prepare('SELECT * FROM recovery_blob').all(), before);
    fault = 'DELETE FROM recovery_blob';
    assert.throws(() => f.execute({ operation: 'revoke-all' }), unavailable);
    assert.equal(observed, 2);
    fault = '';
    assert.deepEqual(f.load().state, state);
    f.execute({ operation: 'revoke-all' });
    assert.equal(f.load(), null);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
  } finally {
    f.close();
  }
});

test('expiry removes both encrypted originals and references without extending lifetime', () => {
  const f = fixture();
  try {
    const state = checkpoint('');
    f.save(state);
    const bytes = f.execute({ operation: 'inspect' }).bytes;
    f.time(state.root.expiresAt);
    assert.deepEqual(f.execute({ operation: 'sweep' }), { removedRecords: 1, removedBytes: bytes });
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
    assert.equal(f.load(), null);
  } finally {
    f.close();
  }
});

test('ciphertext corruption, cross-scope substitution and missing sources never yield partial originals', () => {
  const f = fixture();
  try {
    const state = checkpoint();
    const other = sha('other-scope');
    f.save(state);
    f.save(state, 0, other);
    const row = f.database.prepare('SELECT * FROM recovery_blob WHERE scope=?').get(f.scope);
    const foreign = f.database
      .prepare('SELECT envelope FROM recovery_blob WHERE scope=?')
      .get(other).envelope;
    for (const envelope of [foreign, Buffer.from('broken')]) {
      f.database
        .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=?')
        .run(envelope, f.scope);
      assert.throws(() => f.load(), unavailable);
      assert.throws(() => f.execute({ operation: 'catalog' }), unavailable);
      assert.throws(() => f.execute({ operation: 'revoke-all' }), unavailable);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 2);
    }
    f.database
      .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=?')
      .run(row.envelope, f.scope);
    assert.deepEqual(f.load().state, state);
    f.database.prepare('DELETE FROM recovery_blob WHERE scope=?').run(f.scope);
    assert.throws(() => f.load(), unavailable);
  } finally {
    f.close();
  }
});

test('payload quota includes source ciphertext rather than only the smaller manifest', () => {
  const f = fixture();
  try {
    for (const [index, megabytes] of [11, 11, 9].entries())
      f.save({ payload: 'x'.repeat(megabytes * 1024 * 1024) }, 0, sha('generic-' + index));
    const modern = checkpoint('x'.repeat(1024 * 1024));
    const root = {
      ...modern.root,
      version: 8,
      ledger: {
        ...modern.root.ledger,
        policy: { ...modern.root.ledger.policy, maxBytes: 4 * 1024 * 1024 },
      },
    };
    assert.throws(() => f.save(createRootCheckpoint(root, [])), unavailable);
    assert.equal(f.version(), 1);
    assert.equal(f.load(), null);
    assert.equal(f.execute({ operation: 'inspect' }).records, 3);
    f.save(modern);
    assert.equal(f.execute({ operation: 'inspect' }).records, 4);
  } finally {
    f.close();
  }
});

test('staged originals and a zero-source checkpoint retain their exact write-ahead association', () => {
  const f = fixture();
  try {
    const initial = checkpoint();
    const source = initial.root.ledger.sources[0];
    initial.root.ledger.sources = [];
    const staged = createRootCheckpoint(initial.root, [source]);
    f.save(staged);
    assert.deepEqual(f.load().state, staged);
    initial.root.ledger.capturedCount = 0;
    for (const snapshot of initial.root.snapshots) {
      snapshot.visible = [];
      snapshot.captured = [];
    }
    const empty = createRootCheckpoint(initial.root, []);
    f.save(empty, 1);
    assert.deepEqual(f.load().state, empty);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
  } finally {
    f.close();
  }
});

test('malformed authenticated references fail closed without trusting a locator or returning partial state', () => {
  const f = fixture();
  try {
    const state = checkpoint();
    f.save(state);
    const originalRow = f.row();
    const originalManifest = f.cipher.open(f.context(originalRow), originalRow.envelope);
    for (const mutate of [
      (value) => {
        value.version = 3;
      },
      (value) => {
        value.extra = true;
      },
      (value) => {
        value.checkpoint.root.ledger.sources = null;
      },
      (value) => {
        value.checkpoint.stagedSources = {};
      },
      (value) => {
        value.checkpoint.root.ledger.sources[0].outputRef = '../private';
      },
      (value) => {
        value.checkpoint.root.ledger.sources[0].output = 'injected';
      },
      (value) => {
        value.checkpoint.root.ledger.sources[0].bytes++;
      },
      (value) => {
        value.checkpoint.root.ledger.sources.push(value.checkpoint.root.ledger.sources[0]);
      },
      (value) => {
        value.checkpoint.root.ledger.sources = [];
      },
    ]) {
      const value = globalThis.structuredClone(originalManifest);
      mutate(value);
      f.database
        .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
        .run(f.cipher.seal(f.context(originalRow), value), f.scope);
      assert.throws(() => f.load(), unavailable);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 1);
    }
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(originalRow.envelope, f.scope);
    assert.deepEqual(f.load().state, state);
    assert.throws(() => f.save(originalManifest, 1), unavailable);
  } finally {
    f.close();
  }
});

test('authenticated blob payloads still validate bytes, digest, source identity and UTF-8', () => {
  const f = fixture();
  try {
    f.save(checkpoint());
    const row = f.database.prepare('SELECT * FROM recovery_blob').get();
    const context = {
      ...f.context(f.row()),
      scope: sha('hpm/recovery/blob/aad/v1\0' + row.scope + '\0' + row.blob_id),
      revision: 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    const originalValue = f.cipher.open(context, row.envelope);
    for (const value of [
      { ...originalValue, version: 2 },
      { ...originalValue, extra: true },
      { ...originalValue, sourceId: 'untrusted' },
      { ...originalValue, output: {} },
      { ...originalValue, digest: 'a'.repeat(64) },
      { ...originalValue, bytes: -1 },
      { ...originalValue, bytes: 2097153 },
      { ...originalValue, bytes: 0 },
      { ...originalValue, output: '\ud800', bytes: 3 },
    ]) {
      f.database
        .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=?')
        .run(f.cipher.seal(context, value), f.scope);
      assert.throws(() => f.load(), unavailable);
    }
    f.database
      .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=?')
      .run(row.envelope, f.scope);
    f.time(86400100);
    f.database
      .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=?')
      .run(Buffer.from('corrupt'), f.scope);
    assert.throws(() => f.execute({ operation: 'sweep' }), unavailable);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 1);
    f.database
      .prepare('UPDATE recovery_blob SET envelope=? WHERE scope=?')
      .run(row.envelope, f.scope);
    assert.equal(f.execute({ operation: 'sweep' }).removedRecords, 1);
  } finally {
    f.close();
  }
});

test('ownership checks run once per locked operation and never survive a transaction boundary', () => {
  const f = fixture();
  try {
    f.save(checkpoint());
    const statement =
      "SELECT 1 FROM recovery_blob b LEFT JOIN recovery_state s ON b.scope=s.scope WHERE s.scope IS NULL OR s.kind<>'state' LIMIT 1";
    const prepare = f.database.prepare.bind(f.database);
    let checks = 0;
    f.database.prepare = (sql) => {
      if (sql === statement) checks++;
      return prepare(sql);
    };
    for (const operation of ['catalog', 'sweep', 'inspect']) {
      const previous = checks;
      f.execute({ operation });
      assert.equal(checks - previous, 1, `${operation}: one integrity check under the lock`);
    }
    const row = f.row();
    f.database.prepare('DELETE FROM recovery_state WHERE scope=?').run(f.scope);
    for (const operation of ['catalog', 'sweep', 'inspect', 'revoke-all']) {
      const previous = checks;
      assert.throws(() => f.execute({ operation }), unavailable);
      assert.equal(checks - previous, 1, `${operation}: corruption is rechecked`);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 1);
    }
    f.database
      .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
      .run(row.scope, row.revision, row.created_at, row.expires_at, row.kind, row.envelope);
    const previous = checks;
    assert.equal(f.load().state.root.ledger.sources[0].output, original);
    assert.equal(checks - previous, 1);
  } finally {
    f.close();
  }
});

test('reference integrity hashes its local normalized clone without a second full normalization', () => {
  const reference = referenceStateFromCheckpoint(checkpoint());
  const stateData = require('../lib/proxy/context-recovery-state-data');
  const files = [
    require.resolve('../lib/proxy/context-recovery-fingerprint'),
    require.resolve('../lib/proxy/context-recovery-reference-state'),
  ];
  const cached = files.map((file) => require.cache[file]);
  const normalize = stateData.normalizeRecoveryReferenceData;
  let calls = 0;
  stateData.normalizeRecoveryReferenceData = (...args) => {
    calls++;
    return Reflect.apply(normalize, stateData, args);
  };
  for (const file of files) delete require.cache[file];
  try {
    const codec = require('../lib/proxy/context-recovery-reference-state');
    const first = codec.parseReferenceState(reference);
    assert.equal(calls, 1, 'one normalization before hashing the local safe payload');
    assert.deepEqual(first, reference);
    assert.notEqual(first, reference);
    assert.notEqual(first.metadata, reference.metadata);
    codec.parseReferenceState(reference);
    assert.equal(calls, 2, 'later callers must still validate their own input');
    reference.metadata.target = 'changed-after-first-parse';
    assert.throws(() => codec.parseReferenceState(reference), {
      code: 'invalid_recovery_reference_state',
    });
    assert.equal(calls, 3);
    let touched = 0;
    const hostile = Object.defineProperty({}, 'metadata', {
      enumerable: true,
      get() {
        touched++;
        throw new Error('must not run');
      },
    });
    assert.throws(() => codec.parseReferenceState(hostile), {
      code: 'invalid_recovery_reference_state',
    });
    assert.equal(touched, 0);
  } finally {
    stateData.normalizeRecoveryReferenceData = normalize;
    files.forEach((file, index) => {
      require.cache[file] = cached[index];
    });
  }
});

test('reference-creator admits its final envelope and hashes its owned payload once', (t) => {
  const reference = referenceStateFromCheckpoint(checkpoint());
  const stateData = require('../lib/proxy/context-recovery-state-data');
  const fingerprints = require('../lib/proxy/context-recovery-fingerprint-value');
  const files = [
    require.resolve('../lib/proxy/context-recovery-reference-state'),
    require.resolve('../lib/proxy/context-recovery-fingerprint'),
  ];
  const cached = files.map((file) => require.cache[file]);
  const normalize = stateData.normalizeRecoveryReferenceData;
  const fingerprint = fingerprints.fingerprintNormalizedValue;
  let admissions = 0,
    hashes = 0;
  t.mock.method(stateData, 'normalizeRecoveryReferenceData', (...args) => {
    admissions++;
    return Reflect.apply(normalize, stateData, args);
  });
  t.mock.method(fingerprints, 'fingerprintNormalizedValue', (...args) => {
    hashes++;
    return Reflect.apply(fingerprint, fingerprints, args);
  });
  try {
    for (const file of files) delete require.cache[file];
    const codec = require('../lib/proxy/context-recovery-reference-state');
    const created = codec.createReferenceState(
      reference.metadata,
      reference.stagedSources,
      reference.publications
    );
    assert.equal(
      admissions,
      1,
      'the complete final envelope supplies the stricter byte/node admission'
    );
    assert.equal(hashes, 1, 'the locally generated digest is not recomputed');
    assert.deepEqual(created, reference);
    assert.notEqual(created.metadata, reference.metadata);
    assert.deepEqual(codec.parseReferenceState(created), reference);
    assert.equal(hashes, 2, 'every external parse still recomputes its digest');
    created.digest = 'f'.repeat(64);
    assert.throws(() => codec.parseReferenceState(created), {
      code: 'invalid_recovery_reference_state',
    });
    assert.equal(hashes, 3);
  } finally {
    files.forEach((file, index) => {
      require.cache[file] = cached[index];
    });
  }
});

test('reference-creator preserves external admission, semantic validation and mutable detached results', (t) => {
  const failure = { code: 'invalid_recovery_reference_state' };
  const { fingerprintRecoveryReference } = require('../lib/proxy/context-recovery-fingerprint');
  const codec = require('../lib/proxy/context-recovery-reference-state');
  assert.equal(Object.hasOwn(codec, 'validateParsedReferenceState'), false);
  const priorCreator = (metadata, stagedSources, publications = []) => {
    const payload = {
      version: 1,
      kind: 'recovery-reference-state',
      metadata,
      stagedSources,
      publications,
    };
    return parseReferenceState({ ...payload, digest: fingerprintRecoveryReference(payload) });
  };
  for (const base of [
    referenceStateFromCheckpoint(checkpoint()),
    referenceStateFromCheckpoint(checkpoint([])),
  ]) {
    const created = createReferenceState(base.metadata, base.stagedSources, base.publications);
    assert.deepEqual(created, priorCreator(base.metadata, base.stagedSources, base.publications));
    assert.deepEqual(created, parseReferenceState(created));
    assert.notEqual(created.metadata.ledger.sources, base.metadata.ledger.sources);
    const invalidInputs = [
      [undefined, []],
      [null, []],
      [{}, []],
      [[], []],
      [base.metadata, null],
      [base.metadata, {}],
      [base.metadata, [], null],
      [{ ...base.metadata, rootId: 'invalid' }, []],
      [{ ...base.metadata, observedAt: base.metadata.expiresAt }, []],
      [{ ...base.metadata, budget: { ...base.metadata.budget, calls: -1 } }, []],
      [
        base.metadata,
        [],
        Array.from({ length: 513 }, () => ({
          state: 'prepared',
          snapshotId: base.metadata.rootId,
        })),
      ],
      [{ ...base.metadata, excessive: 'x'.repeat(16 * 1024 * 1024) }, []],
    ];
    let touched = 0;
    const hostile = Object.defineProperty({ ...base.metadata }, 'rootId', {
      enumerable: true,
      get() {
        touched++;
        throw new Error('not invoked');
      },
    });
    const cyclic = { ...base.metadata };
    cyclic.self = cyclic;
    invalidInputs.push(
      [hostile, []],
      [cyclic, []],
      [Object.assign(Object.create({}), base.metadata), []]
    );
    for (const args of invalidInputs) {
      assert.throws(() => priorCreator(...args));
      assert.throws(() => createReferenceState(...args), failure);
    }
    assert.equal(touched, 0);
    created.metadata.rootId = 'mutated-after-creation';
    assert.throws(() => parseReferenceState(created), failure);
    assert.deepEqual(
      createReferenceState(base.metadata, base.stagedSources, base.publications),
      base
    );
  }
  const base = referenceStateFromCheckpoint(checkpoint());
  const root = require('../lib/proxy/context-recovery-root-state');
  let validations = 0;
  t.mock.method(root, 'validateRecoveryRootMetadata', () => {
    validations++;
    throw new Error('synthetic semantic failure');
  });
  assert.throws(() => createReferenceState(base.metadata, []), failure);
  assert.equal(validations, 1, 'a generated digest cannot bypass metadata validation');
});

test('metadata saves validate each external reference once without weakening prior-row checks', (t) => {
  const state = checkpoint();
  const reference = referenceStateFromCheckpoint(state);
  const f = fixture(undefined, sha('hpm/recovery-root/v1\0' + state.root.rootId));
  try {
    f.execute(stateRequest(f, reference, checkpointPayloads(state)));
    const prior = f.cipher.open(f.context(f.row()), f.row().envelope);
    const { createRecoveryBlobStorage } = require('../lib/proxy/context-recovery-storage-blobs');
    const codec = createRecoveryBlobStorage(
      f.database,
      f.cipher,
      () => f.context(f.row()).storeId,
      () => true
    );
    const root = require('../lib/proxy/context-recovery-root-state');
    const validate = root.validateRecoveryRootMetadata;
    let validations = 0;
    t.mock.method(root, 'validateRecoveryRootMetadata', (...args) => {
      validations++;
      return Reflect.apply(validate, root, args);
    });
    f.database.exec('BEGIN IMMEDIATE');
    try {
      const next = codec.saveReference(reference, [], prior, f.scope);
      assert.equal(validations, 2, 'one complete semantic validation of each supplied reference');
      assert.deepEqual(next.reference, reference);
      assert.notEqual(next.reference, reference);
      assert.notEqual(next.reference.metadata, reference.metadata);
      for (const bad of [
        null,
        {},
        { ...prior, version: 99 },
        { ...prior, extra: true },
        { ...prior, reference: { ...prior.reference, digest: 'a'.repeat(64) } },
      ])
        assert.throws(() => codec.saveReference(reference, [], bad, f.scope));
      const tampered = globalThis.structuredClone(prior);
      tampered.reference.metadata.expiresAt++;
      assert.throws(() => codec.saveReference(reference, [], tampered, f.scope));
      let touched = 0;
      const hostile = Object.defineProperty({}, 'metadata', {
        enumerable: true,
        get() {
          touched++;
          throw new Error('must not run');
        },
      });
      assert.throws(() => codec.saveReference(hostile, [], prior, f.scope));
      assert.equal(touched, 0);
      const blob = f.database.prepare('SELECT * FROM recovery_blob WHERE scope=?').get(f.scope);
      f.database.prepare('DELETE FROM recovery_blob WHERE scope=?').run(f.scope);
      assert.throws(() => codec.saveReference(reference, [], prior, f.scope));
      f.database
        .prepare('INSERT INTO recovery_blob VALUES(?,?,?,?,?)')
        .run(blob.scope, blob.blob_id, blob.created_at, blob.expires_at, blob.envelope);
      assert.deepEqual(codec.saveReference(reference, [], prior, f.scope).reference, reference);
    } finally {
      f.database.exec('ROLLBACK');
    }
    assert.deepEqual(f.load().state, state);
  } finally {
    f.close();
  }
});

test('transition parsing returns detached validated inventories and rechecks later external mutations', () => {
  const { parseReferenceTransition } = require('../lib/proxy/context-recovery-reference-state');
  const reference = referenceStateFromCheckpoint(checkpoint());
  const parsed = parseReferenceTransition(reference, reference);
  assert.deepEqual(parsed.next, reference);
  assert.deepEqual(parsed.prior, reference);
  assert.notEqual(parsed.next, parsed.prior);
  assert.notEqual(parsed.prior.metadata, reference.metadata);
  assert.notEqual(parsed.prior.metadata.ledger.sources, reference.metadata.ledger.sources);
  assert.equal(parseReferenceTransition(reference, null).prior, null);
  parsed.prior.metadata.expiresAt++;
  assert.deepEqual(parseReferenceTransition(reference, reference).prior, reference);
  const failure = { code: 'invalid_recovery_reference_state' };
  for (const bad of [undefined, {}, [], '', 1, { ...reference, digest: 'f'.repeat(64) }]) {
    assert.throws(() => parseReferenceTransition(reference, bad), failure);
    assert.throws(() => parseReferenceTransition(bad, reference), failure);
  }
  let touched = 0;
  const hostile = Object.defineProperty({}, 'metadata', {
    enumerable: true,
    get() {
      touched++;
      throw new Error('must not run');
    },
  });
  assert.throws(() => parseReferenceTransition(reference, hostile), failure);
  assert.throws(() => parseReferenceTransition(hostile, reference), failure);
  assert.equal(touched, 0);
  reference.metadata.expiresAt++;
  assert.throws(() => parseReferenceTransition(reference, null), failure);
});

test('current-reference association parses each external state once and keeps comparisons private', (t) => {
  const reference = referenceStateFromCheckpoint(checkpoint());
  const codec = require('../lib/proxy/context-recovery-reference-state');
  const root = require('../lib/proxy/context-recovery-root-state');
  const validate = root.validateRecoveryRootMetadata;
  let validations = 0;
  t.mock.method(root, 'validateRecoveryRootMetadata', (...args) => {
    validations++;
    return Reflect.apply(validate, root, args);
  });
  const stored = validateReferenceAgainstCurrent(reference, reference);
  assert.equal(validations, 2, 'one complete semantic parse for each external state');
  assert.notEqual(stored, reference);
  assert.notEqual(stored.metadata, reference.metadata);
  assert.deepEqual(stored, reference);
  assert.equal(Object.hasOwn(codec, 'compareReferenceTransition'), false);
  const failure = { code: 'invalid_recovery_reference_state' };
  for (const input of [null, {}, [], { ...reference, digest: '0'.repeat(64) }]) {
    assert.throws(() => validateReferenceAgainstCurrent(input, reference), failure);
    assert.throws(() => validateReferenceAgainstCurrent(reference, input), failure);
  }
  let getters = 0;
  const accessor = Object.defineProperty({ ...reference }, 'metadata', {
    enumerable: true,
    get() {
      getters++;
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => validateReferenceAgainstCurrent(accessor, reference), failure);
  assert.throws(() => validateReferenceAgainstCurrent(reference, accessor), failure);
  assert.equal(getters, 0);
  const foreign = referenceStateFromCheckpoint(checkpoint('foreign-current-root'));
  assert.throws(() => validateReferenceAgainstCurrent(reference, foreign), failure);
  reference.metadata.target = 'mutated-after-first-call';
  assert.throws(() => validateReferenceAgainstCurrent(reference, stored), failure);
  assert.throws(() => validateReferenceTransition(reference, stored), failure);
});

test('quota admission reuses authenticated unchanged roots only inside the current write transaction', (t) => {
  const otherScope = sha('quota-admission-other');
  let inject;
  const f = fixture((sql) => {
    if (inject && sql.startsWith('INSERT INTO recovery_state')) {
      const field = inject;
      inject = undefined;
      // Change ciphertext after pruning but before quota admission, retaining
      // the same routing metadata and revision. This must never hit reuse.
      const row = f.database.prepare('SELECT * FROM recovery_state WHERE scope=?').get(otherScope);
      if (field === 'envelope') {
        const bytes = Buffer.from(row.envelope);
        bytes[bytes.length - 1] ^= 1;
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(bytes, otherScope);
      } else {
        const statements = {
          revision: 'UPDATE recovery_state SET revision=revision+1 WHERE scope=?',
          createdAt: 'UPDATE recovery_state SET created_at=created_at+1 WHERE scope=?',
          expiresAt: 'UPDATE recovery_state SET expires_at=expires_at-1 WHERE scope=?',
        };
        f.database.prepare(statements[field]).run(otherScope);
      }
    }
  });
  try {
    const state = checkpoint(),
      other = checkpoint('other quota root');
    const reference = referenceStateFromCheckpoint(state);
    f.execute(stateRequest(f, reference, checkpointPayloads(state)));
    f.execute({
      ...stateRequest(f, referenceStateFromCheckpoint(other), checkpointPayloads(other)),
      scope: otherScope,
    });
    const decode = TextDecoder.prototype.decode;
    let otherOpens = 0;
    t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
      const text = Reflect.apply(decode, this, args);
      const value = JSON.parse(text);
      if (
        value.kind === 'recovery-referenced-checkpoint' &&
        value.reference?.metadata.rootId === other.root.rootId
      )
        otherOpens++;
      return text;
    });
    assert.equal(f.execute(stateRequest(f, reference, [], 1)).revision, 2);
    assert.equal(otherOpens, 1, 'unchanged root is authenticated once in this locked write');
    const prior = f.database.prepare('SELECT * FROM recovery_state WHERE scope=?').get(otherScope);
    for (const field of ['envelope', 'revision', 'createdAt', 'expiresAt']) {
      inject = field;
      assert.throws(() => f.execute(stateRequest(f, reference, [], 2)), unavailable);
      assert.equal(f.row().revision, 2, 'selected write rolls back with failed admission');
      const recovered = f.database
        .prepare('SELECT * FROM recovery_state WHERE scope=?')
        .get(otherScope);
      assert.equal(sha(recovered.envelope), sha(prior.envelope));
      for (const name of ['revision', 'created_at', 'expires_at'])
        assert.equal(recovered[name], prior[name]);
    }
    assert.equal(
      f.execute(stateRequest(f, reference, [], 2)).revision,
      3,
      'failed admission never survives rollback'
    );
    const corrupt = Buffer.from(prior.envelope);
    corrupt[corrupt.length - 1] ^= 1;
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(corrupt, otherScope);
    for (let index = 0; index < 2; index++) {
      assert.throws(() => f.execute(stateRequest(f, reference, [], 3)), unavailable);
      assert.equal(f.row().revision, 3);
      assert.equal(
        sha(
          f.database.prepare('SELECT envelope FROM recovery_state WHERE scope=?').get(otherScope)
            .envelope
        ),
        sha(corrupt)
      );
    }
  } finally {
    f.close();
  }
});

test('layout two rejects unexpected schema and orphan payloads before serving or deleting data', () => {
  const f = fixture();
  try {
    f.save(checkpoint());
    f.database.exec('CREATE INDEX unexpected_blob_index ON recovery_blob(expires_at)');
    assert.throws(() => f.load(), unavailable);
    f.database.exec('DROP INDEX unexpected_blob_index');
    const state = f.row();
    f.database.prepare('DELETE FROM recovery_state WHERE scope=?').run(f.scope);
    for (const operation of ['inspect', 'sweep', 'catalog', 'revoke-all'])
      assert.throws(() => f.execute({ operation }), unavailable);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 1);
    f.database
      .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
      .run(
        state.scope,
        state.revision,
        state.created_at,
        state.expires_at,
        state.kind,
        state.envelope
      );
    assert.equal(f.load().state.root.ledger.sources[0].output, original);
  } finally {
    f.close();
  }
});

for (const output of [[], ['owned synthetic source']]) {
  test(
    'selected reference admission does not decrypt the same prior row twice: sources=' +
      output.length,
    (t) => {
      const f = fixture();
      try {
        const state = checkpoint(output);
        const initial = referenceStateFromCheckpoint(state);
        f.execute(stateRequest(f, initial, checkpointPayloads(state)));
        const reserved = createReferenceState(
          {
            ...initial.metadata,
            budget: { ...initial.metadata.budget, calls: 1, returnedBytes: 16384 },
          },
          []
        );
        const decode = TextDecoder.prototype.decode;
        let priorOpens = 0;
        t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
          const text = Reflect.apply(decode, this, args);
          const value = JSON.parse(text);
          if (
            value.kind === 'recovery-referenced-checkpoint' &&
            value.reference?.metadata.rootId === initial.metadata.rootId &&
            value.reference.metadata.budget.calls === 0
          )
            priorOpens++;
          return text;
        });
        assert.equal(
          f.execute({ ...stateRequest(f, reserved, [], 1), admission: initial }).revision,
          2
        );
        assert.equal(
          priorOpens,
          2,
          'prune and the selected mutation each authenticate once; admission and save share only that selected read'
        );
        assert.equal(f.load().state.root.budget.calls, 1);
        assert.equal(f.load().expiresAt, initial.metadata.expiresAt);
        // An earlier authenticated prior cannot satisfy a later stale admission.
        assert.throws(
          () => f.execute({ ...stateRequest(f, reserved, [], 2), admission: initial }),
          unavailable
        );
        assert.equal(f.row().revision, 2);
        f.reopen();
        assert.equal(f.load().state.root.budget.calls, 1);
      } finally {
        f.close();
      }
    }
  );
}
