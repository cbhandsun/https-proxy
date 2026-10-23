'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const {
  createContextRecoveryStorageOpening,
} = require('../lib/proxy/context-recovery-storage-opening');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  declareRecoveryScan,
  supportsRecoveryScan,
  declareRecoverySourcePages,
  supportsRecoverySourcePages,
  declareRecoveryReaderSettlement,
  supportsRecoveryReaderSettlement,
  declareRecoveryReferenceWrites,
  supportsRecoveryReferenceWrites,
  declareRecoveryReferenceStates,
  supportsRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
  supportsRecoveryReferenceAdmission,
  declareRecoveryReferenceScan,
  supportsRecoveryReferenceScan,
} = require('../lib/proxy/context-recovery-storage-contract');
const { createProxyShutdown } = require('../lib/proxy/server-shutdown');
const unused = path.join(os.tmpdir(), 'hpm-unused-opening-path');
const scope = 'c'.repeat(64);
const unavailable = 'context_recovery_storage_unavailable';
const flush = () => new Promise(setImmediate);
function safe(error) {
  assert.equal(error.code, unavailable);
  assert.equal(error.message, unavailable);
  assert.equal(error.cause, undefined);
  return true;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function backend() {
  const calls = [];
  let closed = 0;
  const storage = {
    execute(request) {
      calls.push(request);
      return request.operation === 'inspect'
        ? { records: 0, bytes: 0 }
        : { revision: request.expectedRevision + 1 };
    },
    close() {
      closed++;
    },
  };
  return { storage, calls, closes: () => closed };
}

test('opening forwards source-page support only from the actual adapter and validates page replies', async () => {
  const source = {
    sourceId: 'hce_' + 'a'.repeat(32),
    digest: 'b'.repeat(64),
    bytes: 1,
    callId: 'call',
    toolName: 'lookup',
    argumentsDigest: 'c'.repeat(64),
    expiresAt: 1000,
    trust: 'tool_data_not_instructions',
  };
  for (const marked of [false, true]) {
    const f = backend();
    f.storage.execute = (request) => {
      f.calls.push(request);
      return { ok: false, error: 'context_evidence_unavailable' };
    };
    if (marked) {
      declareRecoverySourcePages(f.storage.execute);
      declareRecoveryReaderSettlement(f.storage.execute);
      declareRecoveryReferenceWrites(f.storage.execute);
      declareRecoveryReferenceStates(f.storage.execute);
      declareRecoveryReferenceAdmission(f.storage.execute);
      declareRecoveryReferenceScan(f.storage.execute);
    }
    const opening = createContextRecoveryStorageOpening({
      directory: unused,
      openStorage: () => f.storage,
    });
    try {
      await flush();
      assert.equal(supportsRecoverySourcePages(opening.execute), marked);
      assert.equal(supportsRecoveryReaderSettlement(opening.execute), marked);
      assert.equal(supportsRecoveryReferenceWrites(opening.execute), marked);
      assert.equal(supportsRecoveryReferenceStates(opening.execute), marked);
      assert.equal(supportsRecoveryReferenceAdmission(opening.execute), marked);
      assert.equal(supportsRecoveryReferenceScan(opening.execute), marked);
      if (marked) {
        const result = await opening.execute({
          operation: 'read-source',
          scope,
          expectedRevision: 1,
          source,
          arguments: { sourceId: source.sourceId, digest: source.digest },
          maxResultBytes: 16384,
        });
        assert.equal(result.error, 'context_evidence_unavailable');
        assert.equal(f.calls.length, 1);
      }
    } finally {
      await opening.close();
    }
  }
});

test('opening propagates only an explicitly supported scan protocol and validates its request cursor', async () => {
  const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
  const record = { revision: 1, createdAt: 100, expiresAt: 1000, state: {} };
  for (const malformed of [false, true]) {
    const f = backend();
    f.storage.execute = declareRecoveryScan(function (request) {
      f.calls.push(request);
      return malformed
        ? { catalog: [entry], scope: null, record: null }
        : { catalog: [entry], scope, record };
    });
    const opening = createContextRecoveryStorageOpening({
      directory: unused,
      openStorage: () => f.storage,
    });
    await flush();
    assert.equal(supportsRecoveryScan(opening.execute), true);
    const pending = opening.execute({ operation: 'scan', after: null });
    if (malformed) {
      await assert.rejects(pending, safe);
      assert.equal(opening.inspect().state, 'failed');
      await assert.rejects(opening.close(), safe);
    } else {
      assert.equal((await pending).scope, scope);
      await opening.close();
    }
    assert.equal(f.calls.length, 1);
    assert.equal(f.closes(), 1);
  }
  const legacy = backend();
  const opening = createContextRecoveryStorageOpening({
    directory: unused,
    openStorage: () => legacy.storage,
  });
  await flush();
  assert.equal(supportsRecoveryScan(opening.execute), false);
  await opening.close();
});

test('opening options reject malformed, unknown and executable data before invoking an opener', () => {
  let executed = 0;
  const openStorage = () => {
    executed++;
    return backend().storage;
  };
  for (const options of [
    null,
    [],
    1,
    {},
    { directory: 'relative', openStorage },
    { directory: unused, openStorage: null },
    { directory: unused, onStartup: true, openStorage },
    { directory: unused, extra: true, openStorage },
    {
      get directory() {
        executed++;
        return unused;
      },
      openStorage,
    },
    {
      directory: unused,
      get openStorage() {
        executed++;
        return openStorage;
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('PRIVATE_DATA');
        },
      }
    ),
  ])
    assert.throws(() => createContextRecoveryStorageOpening(options), safe);
  assert.equal(executed, 0);
});

test('opening queues cloned requests within the worker count limit and calls the opener once', async () => {
  const opening = deferred();
  const f = backend();
  let opens = 0;
  const store = createContextRecoveryStorageOpening({
    directory: unused,
    openStorage() {
      opens++;
      return opening.promise;
    },
  });
  const request = { operation: 'inspect' };
  const pending = Array.from({ length: 8 }, () => store.execute(request));
  request.operation = 'catalog';
  assert.equal(store.inspect().state, 'opening');
  assert.equal(store.inspect().pending, 8);
  await assert.rejects(store.execute({ operation: 'inspect' }), safe);
  assert.equal(f.calls.length, 0);
  opening.resolve(f.storage);
  assert.deepEqual(
    await Promise.all(pending),
    Array.from({ length: 8 }, () => Object.assign(Object.create(null), { records: 0, bytes: 0 }))
  );
  assert.equal(opens, 1);
  assert.ok(f.calls.every((value) => value.operation === 'inspect'));
  await store.close();
  assert.equal(f.closes(), 1);
  assert.deepEqual(store.inspect(), { state: 'closed', pending: 0, pendingBytes: 0 });
  await assert.rejects(store.execute({ operation: 'inspect' }), safe);
});

test('opening applies the existing total byte budget before admission and releases it after dispatch', async () => {
  const opening = deferred();
  const f = backend();
  const store = createContextRecoveryStorageOpening({
    directory: unused,
    openStorage: () => opening.promise,
  });
  const request = {
    operation: 'save',
    scope,
    expectedRevision: 0,
    expiresAt: 1000,
    state: { text: 'x'.repeat(9 * 1024 * 1024) },
  };
  const pending = store.execute(request);
  assert.ok(store.inspect().pendingBytes > 9 * 1024 * 1024);
  await assert.rejects(store.execute(request), safe);
  assert.equal(store.inspect().pending, 1);
  opening.resolve(f.storage);
  assert.deepEqual(await pending, Object.assign(Object.create(null), { revision: 1 }));
  assert.equal(store.inspect().pendingBytes, 0);
  await store.close();
});

test('opening close stops new admission immediately and drains accepted operations and native close exactly once', async () => {
  const opening = deferred(),
    execution = deferred(),
    closing = deferred();
  const calls = [];
  const store = createContextRecoveryStorageOpening({
    directory: unused,
    openStorage: () => opening.promise,
  });
  const pending = store.execute({ operation: 'inspect' });
  const close = store.close();
  assert.equal(store.close(), close);
  await assert.rejects(store.execute({ operation: 'inspect' }), safe);
  opening.resolve({
    execute() {
      calls.push('execute');
      return execution.promise;
    },
    close() {
      calls.push('close');
      return closing.promise;
    },
  });
  await flush();
  assert.deepEqual(calls, ['execute']);
  execution.resolve({ records: 0, bytes: 0 });
  await pending;
  await flush();
  assert.deepEqual(calls, ['execute', 'close']);
  assert.equal(store.inspect().state, 'closing');
  closing.resolve();
  await close;
  assert.equal(store.close(), close);
});

test('opening rejects failed, malformed or executable service capabilities and cleans acquired close capabilities', async () => {
  for (const mode of ['throw', 'reject', 'null', 'thenable', 'getter', 'extra']) {
    let executed = 0,
      opens = 0,
      closes = 0;
    const store = createContextRecoveryStorageOpening({
      directory: unused,
      openStorage() {
        opens++;
        if (mode === 'throw') throw new Error('PRIVATE_DATA');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE_DATA'));
        if (mode === 'null') return null;
        if (mode === 'thenable')
          return {
            get then() {
              executed++;
              throw new Error('PRIVATE_DATA');
            },
          };
        if (mode === 'getter')
          return {
            get execute() {
              executed++;
              return () => {};
            },
            close() {
              closes++;
            },
          };
        return {
          execute() {},
          close() {
            closes++;
          },
          extra: 'PRIVATE_DATA',
        };
      },
    });
    await assert.rejects(store.execute({ operation: 'inspect' }), safe);
    const close = store.close();
    await assert.rejects(close, safe);
    assert.equal(store.close(), close);
    assert.equal(opens, 1);
    assert.equal(executed, 0);
    assert.equal(closes, ['getter', 'extra'].includes(mode) ? 1 : 0);
    assert.equal(store.inspect().state, 'failed');
    assert.equal(JSON.stringify(store.inspect()).includes('PRIVATE_DATA'), false);
  }
});

test('opening validates operation envelopes and terminally rejects malformed backend replies without replay', async () => {
  for (const mode of [
    'shape',
    'getter',
    'thenable',
    'promise-constructor',
    'promise-prototype',
    'revision',
    'revoked',
  ]) {
    const f = backend();
    let calls = 0,
      executed = 0;
    f.storage.execute = () => {
      calls++;
      if (mode === 'getter')
        return {
          get records() {
            executed++;
            return 0;
          },
          bytes: 0,
        };
      if (mode === 'thenable')
        return {
          get then() {
            executed++;
            throw new Error('PRIVATE_DATA');
          },
        };
      if (mode === 'revision') return { revision: 2 };
      if (mode === 'revoked') return { revoked: 0 };
      if (mode === 'promise-constructor' || mode === 'promise-prototype') {
        const promise = Promise.resolve({ records: 0, bytes: 0 });
        if (mode === 'promise-prototype') Object.setPrototypeOf(promise, null);
        else
          Object.defineProperty(promise, 'constructor', {
            get() {
              executed++;
              throw new Error('PRIVATE_DATA');
            },
          });
        return promise;
      }
      return { records: 0, bytes: 0, secret: 'PRIVATE_DATA' };
    };
    const store = createContextRecoveryStorageOpening({
      directory: unused,
      openStorage: () => f.storage,
    });
    await assert.rejects(store.execute({ operation: 'inspect', unknown: true }), safe);
    const request =
      mode === 'revision'
        ? { operation: 'revoke', scope, expectedRevision: 0 }
        : mode === 'revoked'
          ? { operation: 'revoke-scopes', entries: [{ scope, createdAt: 100, expiresAt: 1000 }] }
          : { operation: 'inspect' };
    await assert.rejects(store.execute(request), safe);
    await assert.rejects(store.execute({ operation: 'inspect' }), safe);
    assert.equal(calls, 1);
    assert.equal(executed, 0);
    await assert.rejects(store.close(), safe);
    assert.equal(f.closes(), 1);
  }
});

test('opening preserves operation failures as safe errors without automatic retries or fabricating success', async () => {
  const f = backend();
  const original = f.storage.execute;
  let fail = true;
  f.storage.execute = (request) => {
    if (fail) {
      fail = false;
      throw new Error('PRIVATE_DATA');
    }
    return original(request);
  };
  const store = createContextRecoveryStorageOpening({
    directory: unused,
    openStorage: () => f.storage,
  });
  await assert.rejects(store.execute({ operation: 'inspect' }), safe);
  assert.deepEqual(
    await store.execute({ operation: 'inspect' }),
    Object.assign(Object.create(null), { records: 0, bytes: 0 })
  );
  assert.equal(f.calls.length, 1);
  await store.close();
});

test('opening close rejects synchronous, asynchronous, malformed and executable close failures', async () => {
  for (const mode of ['throw', 'reject', 'reply', 'thenable']) {
    const f = backend();
    let calls = 0,
      executed = 0;
    f.storage.close = () => {
      calls++;
      if (mode === 'throw') throw new Error('PRIVATE_DATA');
      if (mode === 'reject') return Promise.reject(new Error('PRIVATE_DATA'));
      if (mode === 'reply') return { ok: true };
      return {
        get then() {
          executed++;
          throw new Error('PRIVATE_DATA');
        },
      };
    };
    const store = createContextRecoveryStorageOpening({
      directory: unused,
      openStorage: () => f.storage,
    });
    const close = store.close();
    await assert.rejects(close, safe);
    assert.equal(store.close(), close);
    assert.deepEqual([calls, executed], [1, 0]);
  }
});

test('actual session startup barriers cover asynchronous storage opening, stale enable and shutdown', async () => {
  for (const mode of ['disable', 'shutdown']) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
      now: () => 100,
    });
    const opening = deferred();
    let closes = 0;
    const storage = createContextRecoveryStorageOpening({
      directory: unused,
      openStorage: () => opening.promise,
    });
    const owner = createContextRecoveryLifecycle({ storage });
    const enabling = owner.configureAsync(true);
    assert.equal(owner.sessions.inspect().enabled, false);
    const stopping = mode === 'shutdown' ? owner.shutdownAsync() : owner.configureAsync(false);
    opening.resolve({
      execute: (request) => engine.execute(request),
      close() {
        closes++;
        engine.close();
        database.close();
      },
    });
    try {
      assert.deepEqual(await stopping, { ok: true });
      assert.equal((await enabling).code, 'context_recovery_disabled');
      assert.equal(owner.sessions.inspect().roots, 0);
      assert.equal(owner.sessions.inspect().enabled, false);
      if (mode === 'disable') assert.deepEqual(await owner.configureAsync(true), { ok: true });
    } finally {
      await owner.shutdownAsync();
    }
    assert.equal(closes, 1);
  }
});

test(
  'directory lifecycle opens a real encrypted worker, gates admission and closes before service cleanup',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-opening-lifecycle-'));
    let owner;
    try {
      const directory = path.join(root, 'store');
      owner = createContextRecoveryLifecycle({ directory });
      const enabling = owner.configureAsync(true);
      assert.equal(owner.sessions.inspect().enabled, false);
      assert.deepEqual(await enabling, { ok: true });
      assert.equal(owner.inspect().storage, 'persistent');
      assert.equal(owner.sessions.inspect().roots, 0);
      assert.ok(fs.statSync(path.join(directory, 'checkpoint.sqlite')).isFile());
      const shutdown = createProxyShutdown({
        servers: [],
        shutdownRecovery: () => owner.shutdownAsync(),
        stopPid() {
          assert.equal(owner.inspect().state, 'closed');
          return true;
        },
        reportFailure() {},
      });
      assert.equal(await shutdown(), true);
    } finally {
      await owner?.shutdownAsync();
      const target = path.resolve(root);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('hpm-opening-lifecycle-'));
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
);
