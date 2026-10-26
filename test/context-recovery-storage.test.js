'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createStorageCipher } = require('../lib/proxy/context-recovery-storage-cipher');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { recoverySqliteFaults } = require('./helpers/recovery-sqlite-fault.cjs');
const {
  normalizeStorageEnvelope,
  version9StorageEnvelope,
  storageManifestMaximum,
  RECOVERY_MANIFEST_BYTES,
} = require('../lib/proxy/context-recovery-storage-data');
const {
  validateRecoveryStorageUsage,
  RECOVERY_DATABASE_BYTES,
} = require('../lib/proxy/context-recovery-storage-quota');
const {
  MAX_STATE_BYTES,
  STORAGE_TTL_MS,
  storageContext,
  storageState,
  storageRequest,
  storageWorkerRequest,
  storageCatalog,
  storageScanPage,
  supportsRecoveryScan,
} = require('../lib/proxy/context-recovery-storage-contract');

const key = randomBytes(32).toString('base64');
const scope = 'a'.repeat(64);
const storeId = 'b'.repeat(32);
const context = {
  storeId,
  scope,
  revision: 1,
  createdAt: 100,
  expiresAt: 1000,
  kind: 'state',
  version: 1,
};
const content = {
  marker: 'synthetic-' + randomBytes(24).toString('hex'),
  text: '合成原文\r\nélève🙂\u0000',
  nested: { budget: [1, 2, null, true] },
};
function safeFailure(error) {
  assert.equal(error.code, 'context_recovery_storage_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
const json = (value) => JSON.parse(JSON.stringify(value));

test('worker envelope reuses only its detached request clone without another request admission', () => {
  const data = require('../lib/proxy/context-recovery-storage-data');
  const file = require.resolve('../lib/proxy/context-recovery-storage-contract');
  const cached = require.cache[file];
  const normalize = data.normalizeStorageEnvelope;
  const calls = [];
  try {
    data.normalizeStorageEnvelope = (input, kind) => {
      calls.push(kind);
      return normalize(input, kind);
    };
    delete require.cache[file];
    const codec = require('../lib/proxy/context-recovery-storage-contract');
    const input = {
      id: 1,
      request: {
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: 1000,
        state: { text: 'exact🙂', nested: { calls: 1 } },
      },
    };
    const message = codec.storageWorkerRequest(input);
    input.request.state.text = 'changed';
    const request = message.parseRequest();
    assert.equal(message.id, 1);
    assert.equal(request.state.text, 'exact🙂');
    assert.deepEqual(calls, ['worker-request', 'state']);
    assert.equal(codec.storageRequest(request), request);
    assert.equal(message.parseRequest(), request);
    assert.ok(Object.isFrozen(request));
    assert.ok(Object.isFrozen(request.state.nested));
    const transferred = globalThis.structuredClone(request);
    const parsed = codec.storageRequest(transferred);
    assert.notEqual(parsed, transferred);
    assert.deepEqual(calls, ['worker-request', 'state', 'request', 'state']);
    transferred.state.nested.calls = 999;
    assert.equal(parsed.state.nested.calls, 1);
  } finally {
    data.normalizeStorageEnvelope = normalize;
    require.cache[file] = cached;
  }
});

test('worker envelope rejects hostile shapes and preserves safe request failure identity', () => {
  let touched = 0;
  const hostile = Object.defineProperty({}, 'request', {
    enumerable: true,
    get() {
      touched++;
      throw new Error('private');
    },
  });
  const symbol = { id: 1, request: { operation: 'inspect' }, [Symbol('extra')]: true };
  const cyclic = { id: 1 };
  cyclic.request = cyclic;
  for (const input of [
    hostile,
    symbol,
    cyclic,
    Object.create({ id: 1, request: { operation: 'inspect' } }),
  ])
    assert.throws(() => storageWorkerRequest(input), safeFailure);
  for (const input of [
    null,
    [],
    {},
    ...[0, -1, 0.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1].map((id) => ({
      id,
      request: { operation: 'inspect' },
    })),
  ])
    assert.throws(() => storageWorkerRequest(input).parseRequest(), safeFailure);
  assert.equal(touched, 0);
  for (const request of [
    null,
    {},
    [],
    { operation: 'private-invalid' },
    { operation: 'close', extra: true },
    { operation: 'save', scope },
  ]) {
    const message = storageWorkerRequest({ id: 7, request });
    assert.equal(message.id, 7);
    assert.throws(() => message.parseRequest(), safeFailure);
  }
  const close = storageWorkerRequest({ id: 8, request: { operation: 'close' } });
  assert.equal(close.parseRequest().operation, 'close');
  assert.equal(close.parseRequest(), close.parseRequest());
  assert.ok(Object.isFrozen(close.parseRequest()));
  for (const input of [{ id: 11 }, { id: 11, request: { operation: 'inspect' }, extra: true }]) {
    const message = storageWorkerRequest(input);
    assert.equal(message.id, 11, 'a validated clone retains the original negative-reply id');
    assert.throws(() => message.parseRequest(), safeFailure);
  }
});

test('worker request fusion preserves public request semantics and legacy state byte limits', () => {
  const requests = [
    { operation: 'inspect' },
    { operation: 'catalog' },
    { operation: 'sweep' },
    { operation: 'revoke-all' },
    { operation: 'scan', after: null },
    { operation: 'scan-reference', after: scope },
    { operation: 'load', scope },
    { operation: 'load-reference', scope },
    { operation: 'revoke', scope, expectedRevision: 0 },
    { operation: 'revoke-scopes', entries: [{ scope, createdAt: 0, expiresAt: 1000 }] },
    save(),
    save({ text: 'x'.repeat(MAX_STATE_BYTES - Buffer.byteLength('{"text":""}')) }),
  ];
  for (const request of requests) {
    const expected = storageRequest(request);
    const message = storageWorkerRequest({ id: Number.MAX_SAFE_INTEGER, request });
    const actual = message.parseRequest();
    assert.deepEqual(json(actual), json(expected));
    assert.equal(storageRequest(actual), actual);
  }
  for (const request of [
    save({ text: 'x'.repeat(MAX_STATE_BYTES - Buffer.byteLength('{"text":""}') + 1) }),
    { operation: 'revoke', scope, expectedRevision: Number.MAX_SAFE_INTEGER },
    { operation: 'load', scope: 'private-invalid' },
    { operation: 'scan', after: -1 },
    { operation: 'save-reference-state', scope, expectedRevision: 0, expiresAt: 1000 },
    { operation: 'settle-reader', scope, expectedRevision: 0, settlement: {} },
  ]) {
    assert.throws(() => storageRequest(request), safeFailure);
    assert.throws(() => storageWorkerRequest({ id: 9, request }).parseRequest(), safeFailure);
  }
});

test('worker request rejection preserves negative replies and terminal malformed-id behavior', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/proxy/context-recovery-storage-worker.js'),
    'utf8'
  );
  const contract = require('../lib/proxy/context-recovery-storage-contract');
  function workerFixture() {
    const port = new EventEmitter();
    const replies = [];
    let closed = 0,
      executions = 0;
    port.postMessage = (value) => replies.push(value);
    port.close = () => closed++;
    const owner = {
      async execute(request) {
        executions++;
        assert.equal(request.operation, 'inspect');
        return { bytes: 0, records: 0 };
      },
      async close() {},
    };
    const modules = {
      'node:worker_threads': { parentPort: port, workerData: { directory: 'synthetic' } },
      './context-recovery-storage-contract': contract,
      './context-recovery-storage-failure': require('../lib/proxy/context-recovery-storage-failure'),
      './context-recovery-storage-owner': { createAsyncStorageOwner: () => owner },
      './context-recovery-storage-idle': { startRecoveryStorageAsyncIdle: () => ({ close() {} }) },
      './context-recovery-storage-serial': require('../lib/proxy/context-recovery-storage-serial'),
    };
    vm.runInNewContext(source, {
      require(name) {
        assert.ok(Object.hasOwn(modules, name));
        return modules[name];
      },
    });
    replies.length = 0;
    return { port, replies, closed: () => closed, executions: () => executions };
  }
  const fixture = workerFixture();
  for (const input of [
    { id: 1 },
    { id: 2, request: { operation: 'inspect' }, extra: true },
    { id: 3, request: { operation: 'private-invalid' } },
    { id: 4, request: { operation: 'close', extra: true } },
  ]) {
    fixture.port.emit('message', input);
    assert.deepEqual(json(fixture.replies.at(-1)), { id: input.id, ok: false });
    assert.equal(fixture.closed(), 0);
    assert.equal(fixture.executions(), 0);
  }
  fixture.port.emit('message', { id: 5, request: { operation: 'inspect' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(json(fixture.replies.at(-1)), {
    id: 5,
    ok: true,
    result: { bytes: 0, records: 0 },
  });
  assert.equal(fixture.executions(), 1);
  fixture.port.emit('message', { id: 6, request: { operation: 'close' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(json(fixture.replies.at(-1)), { id: 6, ok: true, result: null });
  assert.equal(fixture.closed(), 1);
  const invalid = workerFixture();
  invalid.port.emit('message', { id: 0, request: { operation: 'inspect' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalid.replies.length, 0);
  assert.equal(invalid.closed(), 1);
});

test('manifest capacity selection reads only own data and keeps legacy categories bounded', () => {
  const root = { kind: 'recovery-root', version: 10 };
  const checkpoint = { kind: 'recovery-write-ahead', root };
  const manifest = { kind: 'recovery-referenced-checkpoint', version: 2, checkpoint };
  assert.equal(storageManifestMaximum(manifest), RECOVERY_MANIFEST_BYTES);
  for (const value of [
    null,
    undefined,
    [],
    {},
    Object.create(manifest),
    { ...manifest, version: '2' },
    { ...manifest, version: 1 },
    { ...manifest, checkpoint: { ...checkpoint, kind: 'other' } },
    { ...manifest, checkpoint: { ...checkpoint, root: { ...root, version: 9 } } },
    { ...manifest, checkpoint: { ...checkpoint, root: { ...root, version: 11 } } },
    { ...manifest, checkpoint: { ...checkpoint, root: { ...root, kind: 'other' } } },
    { ...manifest, version: 3, reference: { kind: 'recovery-reference-state', version: 2 } },
  ])
    assert.equal(storageManifestMaximum(value), MAX_STATE_BYTES);
  let touched = 0;
  const accessor = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get() {
      touched++;
      return manifest.kind;
    },
  });
  assert.equal(storageManifestMaximum(accessor), MAX_STATE_BYTES);
  assert.throws(() => storageState(accessor), safeFailure);
  assert.equal(touched, 0);
});

test('cipher admits only versioned v10 manifests beyond the legacy physical ceiling', () => {
  const cipher = createStorageCipher(key);
  const reference = {
    version: 1,
    kind: 'recovery-reference-state',
    metadata: { kind: 'recovery-root-metadata', sourceVersion: 10 },
    text: 'x'.repeat(13 * 1024 * 1024),
  };
  const manifest = { version: 3, kind: 'recovery-referenced-checkpoint', reference };
  try {
    assert.equal(storageManifestMaximum(manifest), RECOVERY_MANIFEST_BYTES);
    const encrypted = cipher.seal(context, manifest);
    assert.ok(encrypted.length > MAX_STATE_BYTES + 28);
    assert.equal(cipher.open(context, encrypted).reference.text, reference.text);
    assert.throws(() => cipher.open({ ...context, scope: 'c'.repeat(64) }, encrypted), safeFailure);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => cipher.open(context, tampered), safeFailure);
    const full = {
      version: 2,
      kind: 'recovery-referenced-checkpoint',
      checkpoint: {
        kind: 'recovery-write-ahead',
        root: { kind: 'recovery-root', version: 10 },
        text: reference.text,
      },
    };
    assert.equal(cipher.open(context, cipher.seal(context, full)).checkpoint.text, reference.text);
    const legacy = {
      ...manifest,
      reference: { ...reference, metadata: { ...reference.metadata, sourceVersion: 9 } },
    };
    for (const value of [
      legacy,
      { ...manifest, version: 4 },
      { reference },
      { text: reference.text },
    ])
      assert.throws(() => cipher.seal(context, value), safeFailure);

    // Valid authentication cannot grant a legacy plaintext the new capacity.
    const nonce = randomBytes(12);
    const raw = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
    raw.setAAD(
      Buffer.from(
        JSON.stringify([
          'hpm.context.storage.v1',
          context.storeId,
          context.scope,
          context.revision,
          context.createdAt,
          context.expiresAt,
          context.kind,
          context.version,
        ])
      )
    );
    const body = Buffer.concat([raw.update(JSON.stringify(legacy)), raw.final()]);
    assert.throws(
      () => cipher.open(context, Buffer.concat([nonce, raw.getAuthTag(), body])),
      safeFailure
    );
    const overhead = Buffer.byteLength(
      JSON.stringify({ ...manifest, reference: { ...reference, text: '' } })
    );
    const exact = {
      ...manifest,
      reference: { ...reference, text: 'x'.repeat(RECOVERY_MANIFEST_BYTES - overhead) },
    };
    assert.equal(cipher.seal(context, exact).length, RECOVERY_MANIFEST_BYTES + 28);
    assert.throws(
      () =>
        cipher.seal(context, {
          ...exact,
          reference: { ...exact.reference, text: exact.reference.text + 'x' },
        }),
      safeFailure
    );
    assert.throws(
      () => cipher.open(context, Buffer.alloc(RECOVERY_MANIFEST_BYTES + 29)),
      safeFailure
    );
  } finally {
    cipher.close();
  }
});

test('physical quota keeps legacy aggregate bytes and bounds four version 9 root categories', () => {
  const mib = 1024 * 1024;
  const entry = (version, bytes, sources = 0) => ({ version, bytes, sources });
  assert.deepEqual(validateRecoveryStorageUsage([]), { records: 0, bytes: 0 });
  assert.equal(
    validateRecoveryStorageUsage([entry(8, 16 * mib, 512), entry(7, 16 * mib, 64)]).bytes,
    32 * mib
  );
  assert.equal(
    validateRecoveryStorageUsage(Array(4).fill(entry(9, 128 * mib, 512))).bytes,
    512 * mib
  );
  assert.equal(
    validateRecoveryStorageUsage(Array(4).fill(entry(10, 128 * mib, 512))).bytes,
    512 * mib
  );
  assert.equal(
    validateRecoveryStorageUsage([entry(null, 32 * mib), entry(9, 128 * mib, 512)]).records,
    2
  );
  let invoked = 0;
  const getter = Object.defineProperty({}, 'bytes', {
    enumerable: true,
    get() {
      invoked++;
      return 1;
    },
  });
  for (const input of [
    null,
    {},
    Array(1),
    [getter],
    Array(5).fill(entry(9, 0)),
    [entry(9, 128 * mib + 1)],
    [entry(8, 32 * mib), entry(9, 1), entry(null, 1)],
    [entry(7, 0, 65)],
    [entry(9, 0, 513)],
    [entry(null, 0, 1)],
    [entry(11, 0)],
    [entry(10, 128 * mib + 1)],
    [entry(10, 0, 513)],
    [entry('9', 0)],
    [entry(9, -1)],
    [entry(9, 1.5)],
    [entry(9, Infinity)],
    [entry(9, 0, -1)],
    [{ ...entry(9, 0), extra: true }],
  ])
    assert.throws(() => validateRecoveryStorageUsage(input));
  assert.equal(invoked, 0);
  assert.equal(RECOVERY_DATABASE_BYTES, 1024 * mib);
});

test('large storage envelopes require an explicit versioned checkpoint path without executing hooks', () => {
  const large = 'x'.repeat(13 * 1024 * 1024);
  const state = {
    kind: 'recovery-write-ahead',
    root: { kind: 'recovery-root', version: 9 },
    payload: large,
  };
  const request = { operation: 'save', state };
  const record = { state };
  const scan = { record };
  for (const [kind, input] of [
    ['state', state],
    ['request', request],
    ['record', record],
    ['scan', scan],
    ['worker-request', { id: 1, request }],
    ['worker-result', { id: 1, ok: true, result: record }],
    ['worker-result', { id: 1, ok: true, result: scan }],
  ]) {
    assert.equal(version9StorageEnvelope(input, kind), true);
    assert.notEqual(normalizeStorageEnvelope(input, kind), input);
    const old = json(input);
    const find = (value) => {
      if (value && typeof value === 'object') {
        if (value.kind === 'recovery-root') value.version = 8;
        else Object.values(value).forEach(find);
      }
    };
    find(old);
    assert.throws(() => normalizeStorageEnvelope(old, kind));
  }
  for (const operation of ['save-reference', 'save-reference-state']) {
    const input = {
      operation,
      reference: {
        version: 1,
        kind:
          operation === 'save-reference' ? 'recovery-reference-write' : 'recovery-reference-state',
        metadata: { kind: 'recovery-root-metadata', sourceVersion: 9 },
      },
      payloads: large,
    };
    assert.equal(version9StorageEnvelope(input, 'request'), true);
    assert.ok(normalizeStorageEnvelope(input, 'request'));
    input.operation = 'inspect';
    assert.throws(() => normalizeStorageEnvelope(input, 'request'));
  }
  let invoked = 0;
  const get = () => {
    invoked++;
    return state;
  };
  const cycle = {};
  cycle.self = cycle;
  for (const input of [
    Object.defineProperty({}, 'root', { enumerable: true, get }),
    { ...state, root: Object.defineProperty({}, 'version', { enumerable: true, get }) },
    { ...state, toJSON: get },
    { ...state, root: Object.create({ kind: 'recovery-root', version: 9 }) },
    { ...state, payload: cycle },
    { ...state, payload: Array(10).fill('x'.repeat(12 * 1024 * 1024)) },
    { ...state, payload: Array(1) },
  ])
    assert.throws(() => normalizeStorageEnvelope(input, 'state'));
  assert.equal(invoked, 0);
  assert.throws(() => normalizeStorageEnvelope(state, 'unknown'));
  assert.throws(() =>
    storageState({ root: { kind: 'recovery-root', version: 9 }, payload: large })
  );
  assert.throws(() => storageState({ kind: 'recovery-root', version: 9, payload: large }));
  assert.equal(normalizeStorageEnvelope(null, 'record'), null);
  const f = memory();
  try {
    assert.throws(() => f.store.execute(save(state)), safeFailure);
  } finally {
    f.close();
  }
});

test('expiration sweep authenticates each row once and corruption still prevents every deletion', () => {
  const source = `
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const { randomBytes } = require('node:crypto');
    const factory = require('./lib/proxy/context-recovery-storage-cipher');
    const original = factory.createStorageCipher;
    let opens = 0;
    factory.createStorageCipher = (...args) => {
      const cipher = original(...args);
      return { ...cipher, open(context, envelope) {
        if (context.kind !== 'header') opens++;
        return cipher.open(context, envelope);
      } };
    };
    const { createRecoverySqliteStore } = require('./lib/proxy/context-recovery-storage-sqlite');
    const database = new DatabaseSync(':memory:');
    let time = 100;
    const store = createRecoverySqliteStore({ database, dataKey: randomBytes(32).toString('base64'), now: () => time });
    try {
      for (const [id, expiresAt] of [['a',1000], ['b',300], ['c',200]]) {
        store.execute({ operation:'save', scope:id.repeat(64), expectedRevision:0, expiresAt, state:{text:'synthetic'} });
      }
      store.execute({ operation:'revoke', scope:'c'.repeat(64), expectedRevision:1 });
      time = 400;
      opens = 0;
      assert.equal(store.execute({ operation:'sweep' }).removedRecords, 2);
      assert.equal(opens, 3, 'one authentication for each live, expired or revoked row');
      store.execute({ operation:'save', scope:'b'.repeat(64), expectedRevision:0, expiresAt:500, state:{text:'synthetic'} });
      const envelope = Buffer.from(database.prepare('SELECT envelope FROM recovery_state WHERE scope=?').get('a'.repeat(64)).envelope);
      envelope[envelope.length-1] ^= 1;
      database.prepare('UPDATE recovery_state SET envelope=? WHERE scope=?').run(envelope, 'a'.repeat(64));
      time = 600;
      assert.throws(() => store.execute({operation:'sweep'}), { code:'context_recovery_storage_unavailable' });
      assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 2);
    } finally { store.close(); database.close(); }
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('SQLite reopening authenticates each startup row once without retaining admission across transactions', () => {
  const source = `
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const { randomBytes } = require('node:crypto');
    const factory = require('./lib/proxy/context-recovery-storage-cipher');
    const original = factory.createStorageCipher;
    let opens = 0;
    factory.createStorageCipher = (...args) => {
      const cipher = original(...args);
      return { ...cipher, open(context, envelope) {
        if (context.kind !== 'header') opens++;
        return cipher.open(context, envelope);
      } };
    };
    const { createRecoverySqliteStore } = require('./lib/proxy/context-recovery-storage-sqlite');
    const database = new DatabaseSync(':memory:');
    const dataKey = randomBytes(32).toString('base64');
    const options = { database, dataKey, now: () => 100 };
    let store = createRecoverySqliteStore(options);
    try {
      store.execute({operation:'save', scope:'e'.repeat(64), expectedRevision:0, expiresAt:300, state:{text:'synthetic'}});
      store.execute({operation:'revoke', scope:'e'.repeat(64), expectedRevision:1});
      for (const id of ['a','b','c','d']) {
        store.execute({operation:'save', scope:id.repeat(64), expectedRevision:0, expiresAt:id==='d'?200:1000, state:{text:'synthetic'}});
      }
      store.close();
      opens = 0;
      store = createRecoverySqliteStore({...options, now:() => 400});
      assert.equal(opens, 5, 'one startup authentication for each live, expired or revoked row');
      assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 3);
      assert.equal(store.execute({operation:'load',scope:'a'.repeat(64)}).state.text, 'synthetic');
      assert.equal(opens, 6, 'a later transaction authenticates its row again');
      store.close();
      const scope = 'a'.repeat(64);
      const envelope = Buffer.from(database.prepare('SELECT envelope FROM recovery_state WHERE scope=?').get(scope).envelope);
      envelope[envelope.length-1] ^= 1;
      database.prepare('UPDATE recovery_state SET envelope=? WHERE scope=?').run(envelope, scope);
      assert.throws(() => createRecoverySqliteStore({...options,now:() => 500}), {code:'context_recovery_storage_unavailable'});
      assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 3);
    } finally { store.close(); database.close(); }
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('startup quota rejection authenticates all rows but never deletes expired records', () => {
  const database = new DatabaseSync(':memory:');
  const cipher = createStorageCipher(key);
  let store,
    deletes = 0;
  const adapter = recoverySqliteFaults(database, (sql) => {
    if (/^DELETE FROM/.test(sql)) deletes++;
  });
  try {
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
    store.execute(save({ text: 'synthetic-live' }));
    store.execute(save({ text: 'synthetic-expired' }, { scope: 'e'.repeat(64), expiresAt: 200 }));
    store.close();
    const storeId = database.prepare('SELECT store_id FROM recovery_header').get().store_id;
    for (const id of ['b', 'c', 'd', 'f']) {
      const context = {
        storeId,
        scope: id.repeat(64),
        revision: 1,
        createdAt: 100,
        expiresAt: 1000,
        kind: 'state',
        version: 1,
      };
      database
        .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
        .run(
          context.scope,
          1,
          100,
          1000,
          'state',
          cipher.seal(context, { text: 'synthetic-live' })
        );
    }
    assert.throws(
      () => createRecoverySqliteStore({ database: adapter, dataKey: key, now: () => 400 }),
      safeFailure
    );
    assert.equal(deletes, 0, 'capacity admission still precedes every maintenance deletion');
    assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 6);
    database.prepare('DELETE FROM recovery_state WHERE scope=?').run('f'.repeat(64));
    store = createRecoverySqliteStore({ database: adapter, dataKey: key, now: () => 400 });
    assert.equal(deletes, 1);
    assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 4);
    assert.equal(store.execute({ operation: 'load', scope }).state.text, 'synthetic-live');
  } finally {
    store?.close();
    cipher.close();
    database.close();
  }
});

test('startup admission proofs reject changed ciphertext or AAD and roll back before deleting', () => {
  for (const mode of ['ciphertext', 'revision', 'admission-throws', 'corrupt-expired']) {
    const f = memory();
    let reopened,
      deletes = 0,
      faulted = false;
    try {
      f.store.execute(save());
      f.store.execute(
        save({ text: 'synthetic-expired' }, { scope: 'e'.repeat(64), expiresAt: 200 })
      );
      f.store.close();
      const scopeToCorrupt = mode === 'corrupt-expired' ? 'e'.repeat(64) : scope;
      const before = f.database
        .prepare('SELECT * FROM recovery_state WHERE scope=?')
        .get(scopeToCorrupt);
      if (mode === 'corrupt-expired') {
        const changed = Buffer.from(before.envelope);
        changed[changed.length - 1] ^= 1;
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(changed, scopeToCorrupt);
      }
      const adapter = {
        exec: (sql) => f.database.exec(sql),
        prepare(sql) {
          const statement = f.database.prepare(sql);
          return {
            get: (...args) => statement.get(...args),
            run(...args) {
              if (/^DELETE FROM/.test(sql)) deletes++;
              return statement.run(...args);
            },
            all(...args) {
              if (!faulted && sql.includes("WHERE kind='state' AND expires_at>?")) {
                faulted = true;
                if (mode === 'admission-throws') throw new Error('synthetic-private-admission');
                if (mode === 'ciphertext') {
                  const changed = Buffer.from(before.envelope);
                  changed[changed.length - 1] ^= 1;
                  f.database
                    .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
                    .run(changed, scope);
                } else if (mode === 'revision')
                  f.database
                    .prepare('UPDATE recovery_state SET revision=revision+1 WHERE scope=?')
                    .run(scope);
              }
              return statement.all(...args);
            },
          };
        },
      };
      assert.throws(
        () =>
          (reopened = createRecoverySqliteStore({
            database: adapter,
            dataKey: key,
            now: () => 400,
          })),
        safeFailure,
        mode
      );
      assert.equal(deletes, 0, mode);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 2);
      if (mode !== 'corrupt-expired') {
        const after = f.database.prepare('SELECT * FROM recovery_state WHERE scope=?').get(scope);
        assert.deepEqual(after, before, mode + ' must roll back the test mutation');
      }
    } finally {
      reopened?.close();
      f.close();
    }
  }
});

test('startup maintenance admission hook runs after authentication and before any deletion', () => {
  const { pruneExpiredRecoveryRows } = require('../lib/proxy/context-recovery-storage-maintenance');
  const rows = [
    { scope: 'live', kind: 'state', expires_at: 1000, envelope: Buffer.alloc(30) },
    { scope: 'expired', kind: 'revoked', expires_at: 100, envelope: Buffer.alloc(30) },
  ];
  const events = [];
  const database = {
    prepare(sql) {
      return {
        all: () => rows,
        run() {
          assert.equal(sql, 'DELETE FROM recovery_state WHERE expires_at<=?');
          events.push('delete-row');
          return { changes: 1 };
        },
      };
    },
  };
  const decode = (row) => events.push('decode-' + row.scope);
  const remove = () => {
    events.push('delete-payload');
    return 12;
  };
  assert.deepEqual(
    pruneExpiredRecoveryRows(database, decode, 200, remove, () => {
      events.push('admit');
    }),
    { removedRecords: 1, removedBytes: 42 }
  );
  assert.deepEqual(events, [
    'decode-live',
    'decode-expired',
    'admit',
    'delete-payload',
    'delete-row',
  ]);
  events.length = 0;
  const rejected = new Error('synthetic-admission-failure');
  assert.throws(
    () =>
      pruneExpiredRecoveryRows(database, decode, 200, remove, () => {
        throw rejected;
      }),
    (error) => error === rejected
  );
  assert.deepEqual(events, ['decode-live', 'decode-expired']);
  for (const input of [null, false, 1, {}, []]) {
    events.length = 0;
    assert.throws(
      () => pruneExpiredRecoveryRows(database, decode, 200, remove, input),
      safeFailure
    );
    assert.deepEqual(events, []);
  }
  rows.length = 0;
  events.length = 0;
  assert.deepEqual(
    pruneExpiredRecoveryRows(database, decode, 200, remove, () => {
      events.push('admit-empty');
    }),
    { removedRecords: 0, removedBytes: 0 }
  );
  assert.deepEqual(events, ['admit-empty']);
});

function memory(afterWrite = () => {}) {
  const database = new DatabaseSync(':memory:', { allowExtension: false });
  let time = 100;
  const store = createRecoverySqliteStore({
    database: recoverySqliteFaults(database, afterWrite),
    dataKey: key,
    now: () => time,
  });
  return {
    database,
    store,
    time: (value) => {
      time = value;
    },
    close() {
      store.close();
      database.close();
    },
  };
}
const save = (state = content, extra = {}) => ({
  operation: 'save',
  scope,
  expectedRevision: 0,
  expiresAt: 1000,
  state,
  ...extra,
});

test('SQLite unchanged authenticated time never rewrites the header but still validates and collects', () => {
  const writes = [];
  const f = memory((sql) => writes.push(sql));
  const header = () =>
    Buffer.from(f.database.prepare('SELECT envelope FROM recovery_header').get().envelope);
  try {
    f.store.execute(save());
    const storedBytes = f.database
      .prepare('SELECT length(envelope) AS n FROM recovery_state WHERE scope=?')
      .get(scope).n;
    writes.length = 0;
    const before = header();
    for (const request of [
      { operation: 'inspect' },
      { operation: 'load', scope },
      { operation: 'catalog' },
      { operation: 'scan', after: null },
      { operation: 'sweep' },
    ])
      f.store.execute(request);
    assert.deepEqual(
      writes,
      [],
      'read-only work at the authenticated watermark must not dirty SQLite pages'
    );
    assert.deepEqual(header(), before);
    f.time(101);
    f.store.execute({ operation: 'inspect' });
    assert.deepEqual(writes, ['UPDATE recovery_header SET envelope=? WHERE singleton=1']);
    assert.notDeepEqual(header(), before);
    writes.length = 0;
    f.time(1000);
    assert.deepEqual(f.store.execute({ operation: 'sweep' }), {
      removedRecords: 1,
      removedBytes: storedBytes,
    });
    assert.equal(
      writes.length,
      2,
      'advancing the clock and deleting an expired row remain real writes'
    );
    writes.length = 0;
    assert.deepEqual(f.store.execute({ operation: 'sweep' }), {
      removedRecords: 0,
      removedBytes: 0,
    });
    assert.deepEqual(writes, []);
    f.time(999);
    assert.throws(() => f.store.execute({ operation: 'inspect' }), safeFailure);
    assert.deepEqual(writes, []);
    f.time(1000);
    const changed = header();
    changed[0] ^= 1;
    f.database.prepare('UPDATE recovery_header SET envelope=?').run(changed);
    assert.throws(() => f.store.execute({ operation: 'sweep' }), safeFailure);
    assert.deepEqual(
      writes,
      [],
      'same-time admission still authenticates the clock before touching state'
    );
  } finally {
    f.close();
  }
});

test('mixed retention generations keep authenticated deadlines, reject renewal and clean at exact expiry', () => {
  const f = memory();
  const newScope = 'c'.repeat(64);
  try {
    assert.equal(STORAGE_TTL_MS, 86400000);
    f.store.execute(save(content, { expiresAt: 1800100 }));
    f.store.execute(save(content, { scope: newScope, expiresAt: 86400100 }));
    assert.throws(
      () => f.store.execute(save(content, { expectedRevision: 1, expiresAt: 86400100 })),
      safeFailure
    );
    assert.equal(f.store.execute({ operation: 'load', scope }).expiresAt, 1800100);
    f.time(1800100);
    assert.equal(f.store.execute({ operation: 'load', scope }), null);
    assert.deepEqual(json(f.store.execute({ operation: 'load', scope: newScope }).state), content);
    f.time(86400099);
    assert.equal(f.store.execute({ operation: 'load', scope: newScope }).expiresAt, 86400100);
    f.time(86400100);
    assert.equal(f.store.execute({ operation: 'load', scope: newScope }), null);
    assert.deepEqual(f.store.execute({ operation: 'catalog' }), []);
    assert.throws(
      () => f.store.execute(save(content, { scope: 'd'.repeat(64), expiresAt: 172800101 })),
      safeFailure
    );
    assert.throws(
      () =>
        f.store.execute(
          save(content, { scope: newScope, expectedRevision: 1, expiresAt: 172800100 })
        ),
      safeFailure
    );
  } finally {
    f.close();
  }
});

test('bounded scan contracts reject malformed, executable and oversized pages without effects', () => {
  const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
  const record = { revision: 1, createdAt: 100, expiresAt: 1000, state: content };
  const page = { catalog: [entry], scope, record };
  assert.deepEqual(json(storageRequest({ operation: 'scan', after: null })), {
    operation: 'scan',
    after: null,
  });
  assert.deepEqual(json(storageScanPage(page, null)), page);
  assert.deepEqual(json(storageScanPage({ catalog: [], scope: null, record: null }, null)), {
    catalog: [],
    scope: null,
    record: null,
  });
  let executed = 0;
  const hostile = {
    get scope() {
      executed++;
      return scope;
    },
  };
  for (const input of [
    null,
    {},
    { operation: 'scan' },
    { operation: 'scan', after: '' },
    { operation: 'scan', after: '../escape' },
    { operation: 'scan', after: 0 },
    { operation: 'scan', after: null, scope },
    { operation: 'scan', after: hostile },
  ])
    assert.throws(() => storageRequest(input), safeFailure);
  for (const input of [
    null,
    {},
    { ...page, extra: true },
    { ...page, scope: 'b'.repeat(64) },
    { ...page, catalog: [] },
    { ...page, record: null },
    { ...page, record: { ...record, revision: 2 } },
    { ...page, record: { ...record, state: [] } },
    { ...page, record: { ...record, state: hostile } },
    { ...page, record: { ...record, state: { text: 'x'.repeat(MAX_STATE_BYTES) } } },
    { ...page, scope: null, record: null },
    { catalog: [], scope, record },
  ])
    assert.throws(() => storageScanPage(input, null), safeFailure);
  assert.throws(() => storageScanPage(page, scope), safeFailure);
  assert.throws(() => storageScanPage(page, '0'.repeat(64)), safeFailure);
  const later = { ...entry, scope: 'b'.repeat(64) };
  assert.throws(
    () => storageScanPage({ ...page, catalog: [entry, later], scope: later.scope }, null),
    safeFailure
  );
  function accessor() {}
  Object.defineProperty(accessor, 'recoveryScanVersion', {
    get() {
      executed++;
      return 1;
    },
  });
  assert.equal(supportsRecoveryScan(accessor), false);
  assert.equal(supportsRecoveryScan(null), false);
  assert.equal(executed, 0);
});

test('SQLite scan atomically authenticates the generation and returns one bounded record per cursor', () => {
  const f = memory();
  try {
    assert.equal(supportsRecoveryScan(f.store.execute), true);
    assert.deepEqual(json(f.store.execute({ operation: 'scan', after: null })), {
      catalog: [],
      scope: null,
      record: null,
    });
    for (const letter of ['a', 'b', 'c', 'd'])
      f.store.execute(save(content, { scope: letter.repeat(64) }));
    const catalog = f.store.execute({ operation: 'catalog' });
    let after = null;
    for (const entry of catalog) {
      const result = f.store.execute({ operation: 'scan', after });
      assert.deepEqual(json(storageScanPage(result, after)), {
        catalog: json(catalog),
        scope: entry.scope,
        record: { revision: 1, createdAt: 100, expiresAt: 1000, state: content },
      });
      after = entry.scope;
    }
    assert.throws(() => f.store.execute({ operation: 'scan', after }), safeFailure);
    assert.throws(() => f.store.execute({ operation: 'scan', after: 'e'.repeat(64) }), safeFailure);
    f.store.execute({ operation: 'revoke', scope: 'd'.repeat(64), expectedRevision: 1 });
    const row = f.database
      .prepare('SELECT envelope FROM recovery_state WHERE scope=?')
      .get('d'.repeat(64));
    const corrupt = Buffer.from(row.envelope);
    corrupt[corrupt.length - 1] ^= 1;
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(corrupt, 'd'.repeat(64));
    assert.throws(() => f.store.execute({ operation: 'scan', after: null }), safeFailure);
    f.time(1000);
    assert.throws(() => f.store.execute({ operation: 'scan', after: null }), safeFailure);
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM recovery_state').get().count, 4);
  } finally {
    f.close();
  }
});

test('four-page recovery authenticates the entire generation at both ends without repeatedly loading all ciphertext', (t) => {
  const f = memory();
  try {
    for (const letter of ['a', 'b', 'c', 'd'])
      f.store.execute(save(content, { scope: letter.repeat(64) }));
    const prepare = f.database.prepare;
    let fullCiphertextReads = 0;
    t.mock.method(f.database, 'prepare', function (sql) {
      if (sql === 'SELECT * FROM recovery_state ORDER BY scope LIMIT 257') fullCiphertextReads++;
      return prepare.call(this, sql);
    });
    let after = null;
    for (const letter of ['a', 'b', 'c', 'd']) {
      const page = f.store.execute({ operation: 'scan', after });
      assert.equal(page.scope, letter.repeat(64));
      assert.deepEqual(json(page.record.state), content);
      after = page.scope;
    }
    assert.equal(fullCiphertextReads, 2);
  } finally {
    f.close();
  }
});

test('SQLite scan prunes authenticated expiration and refuses backwards time without publishing a page', () => {
  const f = memory();
  try {
    f.store.execute(save());
    f.time(1000);
    assert.deepEqual(json(f.store.execute({ operation: 'scan', after: null })), {
      catalog: [],
      scope: null,
      record: null,
    });
    f.time(999);
    assert.throws(() => f.store.execute({ operation: 'scan', after: null }), safeFailure);
  } finally {
    f.close();
  }
});

test('scan authenticates intermediate records and rejects corrupted expired tombstones at the final generation boundary', () => {
  for (const mode of ['selected', 'tombstone']) {
    const f = memory();
    try {
      const terminalScope = 'e'.repeat(64);
      f.store.execute(save({}, { scope: terminalScope, expiresAt: 150 }));
      f.store.execute({ operation: 'revoke', scope: terminalScope, expectedRevision: 1 });
      for (const letter of ['a', 'b', 'c', 'd'])
        f.store.execute(save(content, { scope: letter.repeat(64) }));
      assert.equal(f.store.execute({ operation: 'scan', after: null }).scope, scope);
      const changedScope = mode === 'selected' ? 'b'.repeat(64) : terminalScope;
      const envelope = f.database
        .prepare('SELECT envelope FROM recovery_state WHERE scope=?')
        .get(changedScope).envelope;
      const changed = Buffer.from(envelope);
      changed[changed.length - 1] ^= 1;
      f.database
        .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
        .run(changed, changedScope);
      f.time(200);
      if (mode === 'selected') {
        assert.throws(() => f.store.execute({ operation: 'scan', after: scope }), safeFailure);
      } else {
        assert.equal(f.store.execute({ operation: 'scan', after: scope }).scope, 'b'.repeat(64));
        assert.equal(
          f.store.execute({ operation: 'scan', after: 'b'.repeat(64) }).scope,
          'c'.repeat(64)
        );
        const before = f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all();
        assert.throws(
          () => f.store.execute({ operation: 'scan', after: 'c'.repeat(64) }),
          safeFailure
        );
        assert.deepEqual(
          f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all(),
          before
        );
      }
    } finally {
      f.close();
    }
  }
});

test('startup catalog is exact, bounded, ordered and rejects executable metadata without effects', () => {
  const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
  assert.deepEqual(json(storageCatalog([entry])), [entry]);
  assert.deepEqual(json(storageCatalog([])), []);
  assert.deepEqual(json(storageRequest({ operation: 'catalog' })), { operation: 'catalog' });
  let executed = 0;
  for (const input of [
    null,
    {},
    [null],
    [entry, entry],
    Array(5).fill(entry),
    [{ ...entry, scope: '../escape' }],
    [{ ...entry, revision: 0 }],
    [{ ...entry, revision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...entry, createdAt: -1 }],
    [{ ...entry, expiresAt: 100 }],
    [{ ...entry, expiresAt: 100 + STORAGE_TTL_MS + 1 }],
    [{ ...entry, extra: true }],
    [
      {
        ...entry,
        get revision() {
          executed++;
          return 1;
        },
      },
    ],
    [{ ...entry, scope: 'b'.repeat(64) }, entry],
  ])
    assert.throws(() => storageCatalog(input), safeFailure);
  assert.throws(() => storageRequest({ operation: 'catalog', scope }), safeFailure);
  assert.equal(executed, 0);
});

test('startup catalog authenticates all rows, filters terminal/expired states and exposes metadata only', () => {
  const f = memory();
  try {
    assert.deepEqual(json(f.store.execute({ operation: 'catalog' })), []);
    f.store.execute(save());
    f.store.execute(save(content, { scope: 'b'.repeat(64), expiresAt: 200 }));
    f.store.execute(save(content, { scope: 'c'.repeat(64) }));
    f.store.execute({ operation: 'revoke', scope: 'c'.repeat(64), expectedRevision: 1 });
    f.time(200);
    assert.deepEqual(json(f.store.execute({ operation: 'catalog' })), [
      { scope, revision: 1, createdAt: 100, expiresAt: 1000 },
    ]);
    const row = f.database
      .prepare('SELECT envelope FROM recovery_state WHERE scope=?')
      .get('c'.repeat(64));
    const corrupt = Buffer.from(row.envelope);
    corrupt[corrupt.length - 1] ^= 1;
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(corrupt, 'c'.repeat(64));
    assert.throws(() => f.store.execute({ operation: 'catalog' }), safeFailure);
    assert.equal(f.store.execute({ operation: 'load', scope }).state.marker, content.marker);
  } finally {
    f.close();
  }
});

test('batch revocation contracts reject empty, duplicate, extreme and executable selectors safely', () => {
  const entry = { scope, createdAt: 100, expiresAt: 1000 };
  assert.deepEqual(json(storageRequest({ operation: 'revoke-scopes', entries: [entry] })), {
    operation: 'revoke-scopes',
    entries: [entry],
  });
  assert.deepEqual(json(storageRequest({ operation: 'revoke-all' })), { operation: 'revoke-all' });
  let executed = 0;
  const hostile = {
    get scope() {
      executed++;
      return scope;
    },
  };
  for (const value of [
    { operation: 'revoke-all', scope },
    { operation: 'revoke-scopes', entries: [] },
    { operation: 'revoke-scopes', entries: null },
    { operation: 'revoke-scopes', entries: [entry, entry] },
    { operation: 'revoke-scopes', entries: Array(5).fill(entry) },
    ...[
      hostile,
      null,
      {},
      { ...entry, extra: true },
      { ...entry, scope: '../escape' },
      { ...entry, createdAt: -1 },
      { ...entry, expiresAt: 100 },
      { ...entry, expiresAt: Number.MAX_SAFE_INTEGER },
    ].map((item) => ({ operation: 'revoke-scopes', entries: [item] })),
  ])
    assert.throws(() => storageRequest(value), safeFailure);
  assert.equal(executed, 0);
});

test('batch revocation atomically removes current payloads, accepts uncertain revisions and denies revival', () => {
  const f = memory();
  const scopes = [1, 2, 3, 4].map((i) => i.toString(16).padStart(64, '0'));
  const entries = scopes
    .slice(0, 2)
    .map((value) => ({ scope: value, createdAt: 100, expiresAt: 1000 }));
  try {
    for (const value of scopes) f.store.execute(save(content, { scope: value }));
    f.store.execute(save({ ...content, updated: true }, { scope: scopes[0], expectedRevision: 1 }));
    assert.throws(
      () =>
        f.store.execute({
          operation: 'revoke-scopes',
          entries: [entries[0], { ...entries[1], expiresAt: 999 }],
        }),
      safeFailure
    );
    assert.equal(f.store.execute({ operation: 'load', scope: scopes[0] }).revision, 2);
    assert.deepEqual(f.store.execute({ operation: 'revoke-scopes', entries }), { revoked: 2 });
    assert.deepEqual(f.store.execute({ operation: 'revoke-scopes', entries }), { revoked: 2 });
    for (const value of scopes.slice(0, 2)) {
      assert.equal(f.store.execute({ operation: 'load', scope: value }), null);
      assert.throws(
        () =>
          f.store.execute(
            save(content, { scope: value, expectedRevision: value === scopes[0] ? 3 : 2 })
          ),
        safeFailure
      );
    }
    for (const value of scopes.slice(2))
      assert.equal(f.store.execute({ operation: 'load', scope: value }).revision, 1);
    assert.deepEqual(f.store.execute({ operation: 'revoke-all' }), { revoked: 4 });
    assert.deepEqual(f.store.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
  } finally {
    f.close();
  }
});

test('all-scope revocation rolls back on corruption or write failure and preserves original expired lifetimes', () => {
  let armed = false;
  let writes = 0;
  const f = memory((sql, args, result) => {
    if (!armed || !sql.startsWith('INSERT INTO recovery_state')) return;
    assert.equal(args[4], 'revoked');
    assert.equal(result.changes, 1);
    if (++writes === 2) throw new Error('synthetic-secret-write-failure');
  });
  const other = 'f'.repeat(64);
  try {
    f.store.execute(save());
    f.store.execute(save(content, { scope: other }));
    const header = f.database.prepare('SELECT * FROM recovery_header').all();
    const rows = f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all();
    f.time(200);
    armed = true;
    assert.throws(() => f.store.execute({ operation: 'revoke-all' }), safeFailure);
    armed = false;
    assert.equal(writes, 2);
    assert.deepEqual(f.database.prepare('SELECT * FROM recovery_header').all(), header);
    assert.deepEqual(f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all(), rows);
    assert.equal(f.store.execute({ operation: 'load', scope }).revision, 1);
    const row = f.database.prepare('SELECT envelope FROM recovery_state WHERE scope=?').get(other);
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(Buffer.from('bad'), other);
    assert.throws(() => f.store.execute({ operation: 'revoke-all' }), safeFailure);
    assert.equal(f.store.execute({ operation: 'load', scope }).revision, 1);
    f.database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(row.envelope, other);
    f.time(2000);
    assert.deepEqual(f.store.execute({ operation: 'revoke-all' }), { revoked: 2 });
    for (const item of f.database.prepare('SELECT kind, expires_at FROM recovery_state').all()) {
      assert.equal(item.kind, 'revoked');
      assert.equal(item.expires_at, 1000);
    }
    const absent = 'e'.repeat(64);
    assert.deepEqual(
      f.store.execute({
        operation: 'revoke-scopes',
        entries: [{ scope: absent, createdAt: 100, expiresAt: 1000 }],
      }),
      { revoked: 1 }
    );
    assert.throws(
      () => f.store.execute(save(content, { scope: absent, expectedRevision: 1, expiresAt: 3000 })),
      safeFailure
    );
  } finally {
    f.close();
  }
});

test('batch tombstones are bounded at 256 with no eviction and empty all-scope revocation is acknowledged', () => {
  const f = memory();
  try {
    assert.deepEqual(f.store.execute({ operation: 'revoke-all' }), { revoked: 0 });
    for (let i = 0; i < 256; i += 4)
      f.store.execute({
        operation: 'revoke-scopes',
        entries: Array.from({ length: 4 }, (_, j) => ({
          scope: (i + j + 1).toString(16).padStart(64, '0'),
          createdAt: 100,
          expiresAt: 1000,
        })),
      });
    assert.deepEqual(f.store.execute({ operation: 'revoke-all' }), { revoked: 256 });
    assert.throws(
      () =>
        f.store.execute({
          operation: 'revoke-scopes',
          entries: [{ scope: 'f'.repeat(64), createdAt: 100, expiresAt: 1000 }],
        }),
      safeFailure
    );
    assert.equal(
      f.database.prepare('SELECT count(*) AS count FROM recovery_state').get().count,
      256
    );
  } finally {
    f.close();
  }
});

test('storage requests reuse only parser-owned deeply immutable copies within one process', () => {
  const source = save({ nested: { items: [1, null, { text: 'original' }] } });
  const parsed = storageRequest(source);
  assert.notEqual(parsed, source);
  assert.equal(storageRequest(parsed), parsed);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.state), true);
  assert.equal(Object.isFrozen(parsed.state.nested.items), true);
  assert.equal(Object.isFrozen(parsed.state.nested.items[2]), true);
  assert.throws(() => {
    parsed.expectedRevision = 999;
  }, TypeError);
  assert.throws(() => {
    parsed.state.nested.items[2].text = 'changed';
  }, TypeError);
  assert.throws(() => {
    parsed.state.nested.items.push(2);
  }, TypeError);
  source.state.nested.items[2].text = 'caller mutation';
  assert.equal(parsed.state.nested.items[2].text, 'original');
  for (const copied of [
    json(parsed),
    globalThis.structuredClone(parsed),
    Object.freeze({ ...parsed }),
  ]) {
    const validated = storageRequest(copied);
    assert.notEqual(validated, copied);
    assert.deepEqual(json(validated), json(parsed));
    assert.equal(storageRequest(validated), validated);
  }
});

test('frozen or copied storage requests cannot forge the private validation marker', () => {
  const parsed = storageRequest(save());
  let invoked = 0;
  const hostile = Object.freeze({
    ...parsed,
    get state() {
      invoked++;
      return {};
    },
  });
  for (const input of [
    hostile,
    Object.freeze({ ...parsed, extra: true }),
    Object.freeze({ ...parsed, expectedRevision: -1 }),
    Object.freeze({
      ...parsed,
      state: {
        toJSON() {
          invoked++;
          return {};
        },
      },
    }),
    Object.freeze({ ...parsed, state: { text: 'x'.repeat(MAX_STATE_BYTES) } }),
  ])
    assert.throws(() => storageRequest(input), safeFailure);
  assert.equal(invoked, 0);
  assert.equal(storageRequest(parsed), parsed);
});

test('reused validated storage requests still enforce revisions, current expiry and closed ownership', () => {
  const fixture = memory();
  const write = storageRequest(save());
  const read = storageRequest({ operation: 'load', scope });
  try {
    assert.equal(fixture.store.execute(write).revision, 1);
    assert.throws(() => fixture.store.execute(write), safeFailure);
    assert.deepEqual(json(fixture.store.execute(read).state), content);
    fixture.time(1000);
    assert.equal(fixture.store.execute(read), null);
    fixture.store.close();
    assert.throws(() => fixture.store.execute(read), safeFailure);
  } finally {
    fixture.close();
  }
});

test('storage contracts validate bounded records, exact fields and executable objects safely', () => {
  assert.deepEqual(json(storageContext(context)), context);
  assert.deepEqual(json(storageState(content)), content);
  assert.deepEqual(json(storageRequest(save())), save());
  let invoked = 0;
  const getter = {
    get operation() {
      invoked++;
      return 'inspect';
    },
  };
  const cycle = {};
  cycle.self = cycle;
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('secret-value');
      },
    }
  );
  for (const input of [
    null,
    undefined,
    [],
    '',
    {},
    getter,
    hostile,
    cycle,
    { operation: 'inspect', extra: true },
    { operation: 'load', scope: {} },
    { operation: 'delete', scope },
    save([], {}),
    save({}, { expectedRevision: -1 }),
    save({}, { expectedRevision: Number.MAX_SAFE_INTEGER }),
    save({}, { expiresAt: Infinity }),
    save({ text: 'x'.repeat(MAX_STATE_BYTES) }),
    { operation: 'revoke', scope },
  ])
    assert.throws(() => storageRequest(input), safeFailure);
  for (const input of [null, [], '', getter, hostile, cycle])
    assert.throws(() => storageState(input), safeFailure);
  for (const change of [
    { storeId: {} },
    { scope: 42 },
    { revision: 0 },
    { version: 2 },
    { expiresAt: 100 },
    { expiresAt: 100 + STORAGE_TTL_MS + 1 },
    { kind: 'unknown' },
    { extra: true },
  ])
    assert.throws(() => storageContext({ ...context, ...change }), safeFailure);
  assert.equal(invoked, 0);
});

test('AEAD preserves normalized exact Unicode and authenticates every routing field', () => {
  const cipher = createStorageCipher(key);
  const first = cipher.seal(context, content),
    second = cipher.seal(context, content);
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(Buffer.from(content.text)), false);
  assert.equal(first.includes(Buffer.from(content.marker)), false);
  assert.deepEqual(json(cipher.open(context, first)), content);
  for (const change of [
    { storeId: 'c'.repeat(32) },
    { scope: 'd'.repeat(64) },
    { revision: 2 },
    { createdAt: 101 },
    { expiresAt: 999 },
    { kind: 'revoked' },
    { version: 2 },
  ])
    assert.throws(() => cipher.open({ ...context, ...change }, first), safeFailure);
  for (const index of [0, 12, 28, first.length - 1]) {
    const changed = Buffer.from(first);
    changed[index] ^= 1;
    assert.throws(() => cipher.open(context, changed), safeFailure);
  }
  for (const value of [
    null,
    'secret-value',
    Buffer.alloc(0),
    Buffer.alloc(29),
    Buffer.alloc(MAX_STATE_BYTES + 29),
  ])
    assert.throws(() => cipher.open(context, value), safeFailure);
  const wrong = createStorageCipher(randomBytes(32).toString('base64'));
  assert.throws(() => wrong.open(context, first), safeFailure);
  wrong.close();
  assert.throws(() => cipher.seal(context, []), safeFailure);
  assert.throws(() => createStorageCipher('secret-value'), safeFailure);
  cipher.close();
  cipher.close();
  assert.throws(() => cipher.open(context, first), safeFailure);
  assert.throws(() => cipher.seal(context, content), safeFailure);
});

test('SQLite checkpoint revisions, isolated scopes, TTL shortening and persistent revocation', () => {
  const fixture = memory();
  const { store, database } = fixture;
  try {
    assert.equal(store.execute({ operation: 'load', scope }), null);
    assert.deepEqual(store.execute(save()), { revision: 1 });
    const loaded = store.execute({ operation: 'load', scope });
    assert.equal(loaded.createdAt, 100);
    assert.equal(loaded.expiresAt, 1000);
    assert.deepEqual(json(loaded.state), content);
    assert.equal(store.execute({ operation: 'load', scope: 'c'.repeat(64) }), null);
    loaded.state.text = 'caller mutation';
    assert.equal(store.execute({ operation: 'load', scope }).state.text, content.text);
    assert.throws(() => store.execute(save()), safeFailure);
    assert.throws(
      () => store.execute(save({}, { expectedRevision: 1, expiresAt: 1001 })),
      safeFailure
    );
    assert.deepEqual(
      store.execute(
        save(
          { budget: { calls: 64, returnedBytes: 512000 }, revoked: [] },
          { expectedRevision: 1, expiresAt: 900 }
        )
      ),
      { revision: 2 }
    );
    store.close();
    const reopened = createRecoverySqliteStore({ database, dataKey: key, now: () => 200 });
    assert.equal(reopened.execute({ operation: 'load', scope }).state.budget.calls, 64);
    assert.throws(
      () => reopened.execute({ operation: 'revoke', scope, expectedRevision: 1 }),
      safeFailure
    );
    assert.deepEqual(reopened.execute({ operation: 'revoke', scope, expectedRevision: 2 }), {
      revision: 3,
    });
    assert.equal(reopened.execute({ operation: 'load', scope }), null);
    assert.throws(() => reopened.execute(save({}, { expectedRevision: 3 })), safeFailure);
    reopened.close();
    const revoked = createRecoverySqliteStore({ database, dataKey: key, now: () => 300 });
    assert.equal(revoked.execute({ operation: 'load', scope }), null);
    assert.throws(() => revoked.execute(save({}, { expectedRevision: 3 })), safeFailure);
    assert.deepEqual(revoked.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
    revoked.close();
  } finally {
    fixture.close();
  }
});

test('SQLite absolute expiration and authenticated clock watermark survive reopening', () => {
  const fixture = memory();
  try {
    fixture.store.execute(save());
    fixture.time(1000);
    assert.equal(fixture.store.execute({ operation: 'load', scope }), null);
    assert.throws(
      () => fixture.store.execute(save({}, { expectedRevision: 1, expiresAt: 1100 })),
      safeFailure
    );
    fixture.store.close();
    assert.throws(
      () => createRecoverySqliteStore({ database: fixture.database, dataKey: key, now: () => 999 }),
      safeFailure
    );
    const restored = createRecoverySqliteStore({
      database: fixture.database,
      dataKey: key,
      now: () => 1001,
    });
    assert.equal(restored.execute({ operation: 'load', scope }), null);
    restored.close();
  } finally {
    fixture.close();
  }
  for (const value of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER, '100', null]) {
    const candidate = memory();
    try {
      candidate.time(value);
      assert.throws(() => candidate.store.execute({ operation: 'inspect' }), safeFailure);
    } finally {
      candidate.close();
    }
  }
});

test('SQLite rejects wrong keys, foreign schemas, corrupt headers and altered routing rows', () => {
  const fixture = memory();
  try {
    fixture.store.execute(save());
    fixture.store.close();
    assert.throws(
      () =>
        createRecoverySqliteStore({
          database: fixture.database,
          dataKey: randomBytes(32).toString('base64'),
          now: () => 200,
        }),
      safeFailure
    );
    const restored = createRecoverySqliteStore({
      database: fixture.database,
      dataKey: key,
      now: () => 200,
    });
    for (const [column, value] of [
      ['scope', 'd'.repeat(64)],
      ['revision', 2],
      ['created_at', 101],
      ['expires_at', 999],
      ['kind', 'revoked'],
    ]) {
      const original = fixture.database.prepare('SELECT * FROM recovery_state').get();
      fixture.database.prepare(`UPDATE recovery_state SET ${column}=?`).run(value);
      assert.throws(
        () => restored.execute({ operation: 'load', scope: column === 'scope' ? value : scope }),
        safeFailure
      );
      fixture.database.prepare(`UPDATE recovery_state SET ${column}=?`).run(original[column]);
    }
    const header = fixture.database.prepare('SELECT envelope FROM recovery_header').get().envelope;
    const changed = Buffer.from(header);
    changed[12] ^= 1;
    fixture.database.prepare('UPDATE recovery_header SET envelope=?').run(changed);
    assert.throws(() => restored.execute({ operation: 'inspect' }), safeFailure);
    restored.close();
    assert.throws(
      () => createRecoverySqliteStore({ database: fixture.database, dataKey: key }),
      safeFailure
    );
  } finally {
    fixture.close();
  }
  for (const sql of [
    'CREATE TABLE foreign_data (text TEXT)',
    'PRAGMA user_version=2',
    'PRAGMA application_id=99',
  ]) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(sql);
      assert.throws(() => createRecoverySqliteStore({ database, dataKey: key }), safeFailure);
    } finally {
      database.close();
    }
  }
});

test('SQLite failures roll back payload and revision atomically without swallowing failures', () => {
  let armed = false;
  let writes = 0;
  const fixture = memory((sql, args, result) => {
    if (!armed || !sql.startsWith('INSERT INTO recovery_state')) return;
    assert.equal(args[1], 2);
    assert.equal(result.changes, 1);
    writes++;
    throw new Error('synthetic-secret-write-failure');
  });
  try {
    fixture.store.execute(save());
    const header = fixture.database.prepare('SELECT * FROM recovery_header').all();
    const rows = fixture.database.prepare('SELECT * FROM recovery_state').all();
    fixture.time(200);
    armed = true;
    assert.throws(
      () => fixture.store.execute(save({ text: 'replacement' }, { expectedRevision: 1 })),
      safeFailure
    );
    assert.throws(
      () => fixture.store.execute({ operation: 'revoke', scope, expectedRevision: 1 }),
      safeFailure
    );
    armed = false;
    assert.equal(writes, 2);
    assert.deepEqual(fixture.database.prepare('SELECT * FROM recovery_header').all(), header);
    assert.deepEqual(fixture.database.prepare('SELECT * FROM recovery_state').all(), rows);
    const result = fixture.store.execute({ operation: 'load', scope });
    assert.equal(result.revision, 1);
    assert.equal(result.state.text, content.text);
    assert.deepEqual(
      fixture.store.execute(save({ text: 'replacement' }, { expectedRevision: 1 })),
      { revision: 2 }
    );
    fixture.database.exec('BEGIN IMMEDIATE');
    assert.throws(() => fixture.store.execute({ operation: 'inspect' }), safeFailure);
    fixture.database.exec('ROLLBACK');
    assert.equal(fixture.store.execute({ operation: 'load', scope }).revision, 2);
    fixture.store.close();
    assert.throws(() => fixture.store.execute({ operation: 'inspect' }), safeFailure);
  } finally {
    fixture.close();
  }
});

test('reopening rejects altered and executable version-one layouts before changing encrypted state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-schema-layout-'));
  const changes = [
    'CREATE TABLE unexpected (value TEXT)',
    'CREATE INDEX unexpected_index ON recovery_state(expires_at)',
    'CREATE VIEW unexpected_view AS SELECT * FROM recovery_state',
    'CREATE TRIGGER unexpected_trigger AFTER UPDATE ON recovery_header BEGIN DELETE FROM recovery_state; END',
    'ALTER TABLE recovery_state ADD COLUMN unexpected TEXT',
    'ALTER TABLE recovery_header ADD COLUMN unexpected TEXT',
    'PRAGMA user_version=2',
    'PRAGMA application_id=99',
    "CREATE VIEW unexpected_view AS SELECT '" + 'x'.repeat(1100) + "' AS value",
    'CREATE TABLE "' + 'x'.repeat(129) + '" (value TEXT)',
    'DROP TABLE recovery_state; CREATE TABLE recovery_state (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, kind TEXT NOT NULL, envelope BLOB NOT NULL) STRICT',
    "DROP TABLE recovery_state; CREATE TABLE recovery_state (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('state','revoked')), envelope BLOB NOT NULL)",
    'DROP TABLE recovery_header; CREATE TABLE recovery_header (singleton INTEGER PRIMARY KEY, store_id TEXT NOT NULL, envelope BLOB NOT NULL) STRICT',
  ];
  try {
    for (let index = 0; index < changes.length; index++) {
      const file = path.join(root, index + '.sqlite');
      let database = new DatabaseSync(file);
      const store = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
      store.execute(save());
      store.close();
      database.exec(changes[index]);
      database.close();
      const before = fs.readFileSync(file);
      database = new DatabaseSync(file);
      try {
        assert.throws(
          () => createRecoverySqliteStore({ database, dataKey: key, now: () => 200 }),
          safeFailure
        );
      } finally {
        database.close();
      }
      assert.deepEqual(fs.readFileSync(file), before);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hpm-schema-layout-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live schema and version changes reject every operation before clock writes or collection', () => {
  for (const change of [
    ['PRAGMA user_version=2', 'PRAGMA user_version=1'],
    ['PRAGMA application_id=99', 'PRAGMA application_id=1213222211'],
    [
      'CREATE TEMP TRIGGER unexpected AFTER UPDATE ON main.recovery_header BEGIN DELETE FROM recovery_state; END',
      'DROP TRIGGER temp.unexpected',
    ],
    [
      'CREATE TRIGGER unexpected AFTER UPDATE ON recovery_header BEGIN DELETE FROM recovery_state; END',
      'DROP TRIGGER unexpected',
    ],
    ['CREATE TEMP TABLE unexpected (value TEXT)', 'DROP TABLE temp.unexpected'],
    ['CREATE TEMP VIEW unexpected AS SELECT * FROM recovery_state', 'DROP VIEW temp.unexpected'],
    ['CREATE TABLE unexpected (value TEXT)', 'DROP TABLE unexpected'],
  ]) {
    const f = memory();
    try {
      f.store.execute(save());
      const before = f.database.prepare('SELECT envelope FROM recovery_header').get().envelope;
      const rows = f.database.prepare('SELECT * FROM recovery_state').all();
      f.database.exec(change[0]);
      f.time(200);
      for (const request of [
        { operation: 'load', scope },
        { operation: 'inspect' },
        { operation: 'catalog' },
        { operation: 'scan', after: null },
        { operation: 'sweep' },
        { operation: 'revoke-all' },
        { operation: 'revoke', scope, expectedRevision: 1 },
        save(content, { expectedRevision: 1 }),
      ]) {
        assert.throws(() => f.store.execute(request), safeFailure);
        assert.deepEqual(
          f.database.prepare('SELECT envelope FROM recovery_header').get().envelope,
          before
        );
        assert.deepEqual(f.database.prepare('SELECT * FROM recovery_state').all(), rows);
      }
      f.database.exec(change[1]);
      assert.equal(f.store.execute({ operation: 'load', scope }).revision, 1);
    } finally {
      f.close();
    }
  }
});

test('fresh SQLite startup commits schema and admission once while retaining both clock checks', () => {
  const database = new DatabaseSync(':memory:');
  const transactions = [];
  let observations = 0;
  let store;
  const adapter = {
    exec(sql) {
      if (['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(sql)) transactions.push(sql);
      return database.exec(sql);
    },
    prepare: (sql) => database.prepare(sql),
  };
  try {
    store = createRecoverySqliteStore({
      database: adapter,
      dataKey: key,
      now: () => 100 + observations++,
    });
    assert.equal(observations, 2);
    assert.deepEqual(transactions, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(database.prepare('PRAGMA secure_delete').get().secure_delete, 1);
    assert.ok(database.prepare('PRAGMA max_page_count').get().max_page_count > 0);
    store.close();
    // The second observation is authenticated and survives reopening.
    assert.throws(
      () => createRecoverySqliteStore({ database, dataKey: key, now: () => 100 }),
      safeFailure
    );
    transactions.length = 0;
    observations = 0;
    store = createRecoverySqliteStore({
      database: adapter,
      dataKey: key,
      now: () => {
        observations++;
        return 102;
      },
    });
    assert.equal(observations, 1);
    assert.deepEqual(transactions, ['BEGIN IMMEDIATE', 'COMMIT']);
    store.execute(save());
    assert.deepEqual(json(store.execute({ operation: 'load', scope }).state), content);
  } finally {
    store?.close();
    database.close();
  }
});

test('fresh SQLite startup rolls back schema on admission or durable commit failure', () => {
  for (const failure of [
    'rollback-time',
    'invalid-time',
    'extreme-time',
    'clock-throws',
    'quota',
    'commit',
    'schema',
  ]) {
    const database = new DatabaseSync(':memory:');
    let observations = 0;
    let fail = true;
    let store;
    const adapter = {
      exec(sql) {
        if (fail && failure === 'commit' && sql === 'COMMIT') throw new Error('secret-value');
        return database.exec(sql);
      },
      prepare(sql) {
        if (fail && failure === 'quota' && sql === 'PRAGMA page_size')
          throw new Error('secret-value');
        return database.prepare(sql);
      },
    };
    try {
      assert.throws(
        () =>
          createRecoverySqliteStore({
            database: adapter,
            dataKey: key,
            now() {
              observations++;
              if (observations === 1) {
                if (failure === 'schema')
                  database.exec('CREATE VIEW unexpected AS SELECT * FROM recovery_header');
                return 100;
              }
              if (failure === 'rollback-time') return 99;
              if (failure === 'invalid-time') return NaN;
              if (failure === 'extreme-time') return Number.MAX_SAFE_INTEGER;
              if (failure === 'clock-throws') throw new Error('secret-value');
              return 101;
            },
          }),
        safeFailure
      );
      assert.deepEqual(database.prepare('SELECT name FROM sqlite_schema').all(), []);
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
      assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0);
      fail = false;
      store = createRecoverySqliteStore({ database: adapter, dataKey: key, now: () => 200 });
      assert.deepEqual(store.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
      assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      store?.close();
      database.close();
    }
  }
});

test('startup rechecks schema under its writer lock before reading application data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-schema-race-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  const database = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  let store;
  try {
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
    store.execute(save());
    store.close();
    const rows = database.prepare('SELECT * FROM recovery_state').all();
    const header = database.prepare('SELECT * FROM recovery_header').all();
    let injected = false;
    let reads = 0;
    assert.throws(
      () =>
        createRecoverySqliteStore({
          database: {
            exec(sql) {
              if (!injected && sql === 'BEGIN IMMEDIATE') {
                other.exec('CREATE VIEW unexpected AS SELECT * FROM recovery_header');
                injected = true;
              }
              return database.exec(sql);
            },
            prepare(sql) {
              if (sql.includes('FROM recovery_header')) reads++;
              return database.prepare(sql);
            },
          },
          dataKey: key,
          now: () => 200,
        }),
      safeFailure
    );
    assert.equal(injected, true);
    assert.equal(reads, 0);
    assert.deepEqual(database.prepare('SELECT * FROM recovery_state').all(), rows);
    assert.deepEqual(database.prepare('SELECT * FROM recovery_header').all(), header);
    other.exec('DROP VIEW unexpected');
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 200 });
    assert.deepEqual(json(store.execute({ operation: 'load', scope }).state), content);
  } finally {
    store?.close();
    other.close();
    database.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-schema-race-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite enforces entry, serialized payload and lifetime limits without eviction', () => {
  const fixture = memory();
  try {
    for (let index = 0; index < 4; index++)
      fixture.store.execute(save({}, { scope: index.toString(16).repeat(64) }));
    assert.throws(() => fixture.store.execute(save({}, { scope })), safeFailure);
    assert.equal(fixture.store.execute({ operation: 'inspect' }).records, 4);
    assert.throws(
      () =>
        fixture.store.execute(
          save(
            {},
            { scope: '0'.repeat(64), expectedRevision: 1, expiresAt: 100 + STORAGE_TTL_MS + 1 }
          )
        ),
      safeFailure
    );
    assert.throws(
      () => fixture.store.execute({ operation: 'revoke', scope, expectedRevision: 0 }),
      safeFailure
    );
  } finally {
    fixture.close();
  }
  const payload = memory();
  try {
    const large = { text: 'x'.repeat(11 * 1024 * 1024) };
    payload.store.execute(save(large));
    payload.store.execute(save(large, { scope: 'b'.repeat(64) }));
    assert.throws(() => payload.store.execute(save(large, { scope: 'c'.repeat(64) })), safeFailure);
    assert.equal(
      payload.store.execute({ operation: 'load', scope }).state.text.length,
      large.text.length
    );
  } finally {
    payload.close();
  }
});

test('file SQLite reopens exact encrypted checkpoints and contains no plaintext content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-context-store-test-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  let database, store;
  try {
    database = new DatabaseSync(file, { allowExtension: false });
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
    store.execute(save());
    store.close();
    database.close();
    database = null;
    const disk = fs.readFileSync(file);
    assert.equal(disk.includes(Buffer.from(content.text)), false);
    assert.equal(disk.includes(Buffer.from(content.marker)), false);
    assert.equal(disk.includes(Buffer.from('合成原文')), false);
    assert.equal(disk.includes(Buffer.from(key)), false);
    assert.equal(disk.includes(Buffer.from(key, 'base64')), false);
    database = new DatabaseSync(file, { allowExtension: false });
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 200 });
    assert.deepEqual(json(store.execute({ operation: 'load', scope }).state), content);
    store.execute({ operation: 'revoke', scope, expectedRevision: 1 });
    store.close();
    database.close();
    database = null;
    database = new DatabaseSync(file, { allowExtension: false });
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 300 });
    assert.equal(store.execute({ operation: 'load', scope }), null);
  } finally {
    store?.close();
    database?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hpm-context-store-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('SQLite bounded tombstones do not silently evict revocations and initialization failures remain safe', () => {
  const fixture = memory();
  try {
    for (let index = 0; index < 256; index++) {
      const itemScope = index.toString(16).padStart(64, '0');
      fixture.store.execute(save({}, { scope: itemScope }));
      fixture.store.execute({ operation: 'revoke', scope: itemScope, expectedRevision: 1 });
    }
    assert.throws(() => fixture.store.execute(save()), safeFailure);
    assert.equal(
      fixture.database.prepare('SELECT count(*) AS count FROM recovery_state').get().count,
      256
    );
    assert.equal(fixture.store.execute({ operation: 'load', scope: '0'.repeat(64) }), null);
    fixture.store.close();
    assert.throws(
      () => createRecoverySqliteStore({ database: fixture.database, dataKey: key, now: null }),
      safeFailure
    );
    assert.throws(
      () =>
        createRecoverySqliteStore({
          database: fixture.database,
          dataKey: key,
          now: () => {
            throw new Error('secret-value');
          },
        }),
      safeFailure
    );
  } finally {
    fixture.close();
  }
});

test('SQLite transaction rollback failure permanently closes the cipher boundary', () => {
  const database = new DatabaseSync(':memory:');
  let failRollback = false;
  const adapter = {
    exec(sql) {
      if (failRollback && sql === 'ROLLBACK') throw new Error('secret-value');
      return database.exec(sql);
    },
    prepare: (sql) => database.prepare(sql),
  };
  const store = createRecoverySqliteStore({ database: adapter, dataKey: key, now: () => 100 });
  try {
    store.execute(save());
    failRollback = true;
    assert.throws(() => store.execute(save()), safeFailure);
    database.exec('ROLLBACK');
    assert.throws(() => store.execute({ operation: 'load', scope }), safeFailure);
  } finally {
    store.close();
    database.close();
  }
});

test('process exit during an uncommitted SQLite write preserves only the prior committed checkpoint', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-context-store-test-'));
  const file = path.join(directory, 'crash.sqlite');
  let database, store;
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'helpers', 'context-recovery-sqlite-crash.cjs')],
      {
        input: JSON.stringify({ file, key, scope, state: content }),
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
        windowsHide: true,
      }
    );
    assert.equal(result.status, 37);
    assert.equal(result.stdout, 'committed-then-uncommitted-write');
    database = new DatabaseSync(file, { allowExtension: false });
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 200 });
    const restored = store.execute({ operation: 'load', scope });
    assert.equal(restored.revision, 1);
    assert.deepEqual(json(restored.state), content);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    store?.close();
    database?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hpm-context-store-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('process exit before initial schema commit leaves an empty database that initializes atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-schema-create-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  let database, store;
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'helpers', 'context-recovery-sqlite-crash.cjs')],
      {
        input: JSON.stringify({ file, key, initializeBeforeCommit: true }),
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
        windowsHide: true,
      }
    );
    assert.equal(result.status, 37);
    assert.equal(result.stdout, 'uncommitted-schema');
    database = new DatabaseSync(file);
    assert.deepEqual(database.prepare('SELECT name FROM sqlite_schema').all(), []);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0);
    store = createRecoverySqliteStore({ database, dataKey: key, now: () => 200 });
    assert.deepEqual(store.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
    store.execute(save());
    assert.deepEqual(json(store.execute({ operation: 'load', scope }).state), content);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    store?.close();
    database?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-schema-create-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
