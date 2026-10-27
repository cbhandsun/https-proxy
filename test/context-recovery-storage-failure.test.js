'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const {
  storageExecutionFailure,
  storageFailureDiagnostic,
  transferStorageFailure,
  parseStorageFailureDiagnostic,
} = require('../lib/proxy/context-recovery-storage-failure');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { createRecoveryStorageSerial } = require('../lib/proxy/context-recovery-storage-serial');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');

const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503 &&
  error.cause === undefined;

function workerFixture(reply) {
  let worker;
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      worker = this;
      this.terminated = 0;
      queueMicrotask(() => this.emit('message', { id: 0, ok: true }));
    }
    postMessage({ id, request }) {
      queueMicrotask(() => {
        if (request.operation === 'close') {
          this.emit('message', { id, ok: true, result: null });
          this.emit('exit', 0);
        } else this.emit('message', { id, ...reply });
      });
    }
    terminate() {
      this.terminated++;
      return Promise.resolve(1);
    }
  }
  return { WorkerType: FakeWorker, inspect: () => worker };
}
const directory = path.join(os.tmpdir(), 'hpm-failure-receipt-unused');

test('fixed branded failure metadata is immutable, private and preserved through the serial owner', async () => {
  for (const phase of [
    'engine-execute',
    'engine-snapshot',
    'anchor-persist',
    'anchor-snapshot',
    'anchor-successor',
    'anchor-admission-receipt',
    'anchor-identity-before',
    'anchor-prepare',
    'anchor-channel-open',
    'anchor-request',
    'anchor-reply',
    'anchor-identity-after',
    'anchor-receipt',
    'owner-verify',
    'owner-close',
  ]) {
    const original = storageExecutionFailure(phase, true);
    assert.ok(safe(original));
    assert.deepEqual(Object.keys(original), ['code', 'statusCode']);
    assert.equal(Object.isFrozen(storageFailureDiagnostic(original)), true);
    const queue = createRecoveryStorageSerial({
      execute: () => Promise.reject(original),
      close: () => Promise.resolve(),
    });
    await assert.rejects(queue.execute({ operation: 'inspect' }), (error) => {
      assert.ok(safe(error));
      assert.notEqual(error, original);
      assert.deepEqual(storageFailureDiagnostic(error), { phase, cleanupFailed: true });
      return true;
    });
    await queue.close();
  }
  let accessed = false;
  const foreign = new Proxy(
    {},
    {
      get() {
        accessed = true;
        throw Error('PRIVATE');
      },
    }
  );
  assert.equal(storageFailureDiagnostic(foreign), null);
  assert.equal(storageFailureDiagnostic(null), null);
  assert.equal(storageFailureDiagnostic(undefined), null);
  assert.ok(safe(transferStorageFailure(foreign)));
  assert.equal(accessed, false);
});

test('diagnostic parser rejects empty, illegal, extreme and executable fields without reading them', () => {
  let accessed = false;
  for (const input of [
    null,
    {},
    [],
    'anchor-persist',
    { phase: 'PRIVATE', cleanupFailed: false },
    { phase: 'x'.repeat(65536), cleanupFailed: false },
    { phase: 'anchor-persist', cleanupFailed: 1 },
    { phase: 'anchor-persist', cleanupFailed: false, raw: 'PRIVATE' },
    {
      get phase() {
        accessed = true;
        return 'anchor-persist';
      },
      cleanupFailed: false,
    },
    new Proxy(
      {},
      {
        getPrototypeOf() {
          accessed = true;
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    assert.throws(() => parseStorageFailureDiagnostic(input), safe);
  assert.equal(accessed, false);
});

test('parent reports only fixed operation metadata while the original failure remains a 503', async () => {
  const f = workerFixture({
    ok: false,
    diagnostic: { phase: 'anchor-persist', cleanupFailed: true },
  });
  const observed = [];
  let thenRead = false;
  const storage = await openContextRecoveryStorage({
    directory,
    WorkerType: f.WorkerType,
    onFailure(value) {
      observed.push(value);
      return {
        get then() {
          thenRead = true;
          throw Error('PRIVATE');
        },
      };
    },
  });
  await assert.rejects(storage.execute({ operation: 'inspect' }), (error) => {
    assert.deepEqual(storageFailureDiagnostic(error), {
      phase: 'anchor-persist',
      cleanupFailed: true,
    });
    return safe(error);
  });
  assert.deepEqual(observed, [
    { operation: 'inspect', phase: 'anchor-persist', cleanupFailed: true },
  ]);
  assert.ok(Object.isFrozen(observed[0]));
  assert.equal(thenRead, false);
  await storage.close();
  assert.equal(f.inspect().terminated, 0);
});

test('throwing and rejecting observers cannot authorize success, retry, or poison a valid close', async () => {
  for (const onFailure of [
    () => {
      throw Error('PRIVATE');
    },
    () => Promise.reject(Error('PRIVATE')),
  ]) {
    const f = workerFixture({ ok: false });
    const storage = await openContextRecoveryStorage({
      directory,
      WorkerType: f.WorkerType,
      onFailure,
    });
    await assert.rejects(storage.execute({ operation: 'inspect' }), (error) => {
      assert.deepEqual(storageFailureDiagnostic(error), {
        phase: 'worker-rejected',
        cleanupFailed: false,
      });
      return safe(error);
    });
    await storage.close();
  }
});

test('malformed worker metadata fails the service; success cannot smuggle a diagnostic receipt', async () => {
  for (const reply of [
    { ok: false, diagnostic: { phase: 'PRIVATE', cleanupFailed: false } },
    { ok: false, diagnostic: { phase: 'anchor-persist', cleanupFailed: false, extra: 1 } },
    {
      ok: true,
      result: { records: 0, bytes: 0 },
      diagnostic: { phase: 'anchor-persist', cleanupFailed: false },
    },
  ]) {
    const f = workerFixture(reply),
      observed = [];
    const storage = await openContextRecoveryStorage({
      directory,
      WorkerType: f.WorkerType,
      onFailure: (value) => observed.push(value),
    });
    await assert.rejects(storage.execute({ operation: 'inspect' }), safe);
    await assert.rejects(storage.close(), safe);
    assert.equal(f.inspect().terminated, 1);
    assert.deepEqual(observed, [
      { operation: 'inspect', phase: 'worker-unavailable', cleanupFailed: false },
    ]);
  }
});

test('observer option accessors and proxies are rejected before worker construction', async () => {
  let invoked = false;
  class ForbiddenWorker {
    constructor() {
      invoked = true;
    }
  }
  for (const options of [
    { directory, WorkerType: ForbiddenWorker, onFailure: 'PRIVATE' },
    {
      directory,
      WorkerType: ForbiddenWorker,
      get onFailure() {
        invoked = true;
        return () => {};
      },
    },
    {
      directory,
      WorkerType: ForbiddenWorker,
      onFailure: new Proxy(() => {}, {
        apply() {
          invoked = true;
        },
      }),
    },
    new Proxy(
      {},
      {
        getPrototypeOf() {
          invoked = true;
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    await assert.rejects(openContextRecoveryStorage(options), safe);
  assert.equal(invoked, false);
});

for (const failedPost of [false, true])
  test(
    'idle failure crosses worker cleanup and closes its port even when diagnostic delivery fails: ' +
      failedPost,
    async () => {
      const filename = path.resolve(__dirname, '../lib/proxy/context-recovery-storage-worker.js');
      const load = createRequire(filename),
        port = new EventEmitter(),
        messages = [];
      let idle,
        closed = false,
        cleaned = false;
      const postError = new Error('PRIVATE_POST_FAILURE');
      port.postMessage = (message) => {
        messages.push(message);
        if (failedPost && message.diagnostic) throw postError;
      };
      port.close = () => {
        closed = true;
      };
      const owner = {
        execute: () => Promise.reject(storageExecutionFailure('anchor-persist')),
        close: async () => {
          cleaned = true;
        },
      };
      vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require'], { filename })((name) => {
        if (name === 'node:worker_threads') return { parentPort: port, workerData: { directory } };
        if (name === './context-recovery-storage-owner')
          return { createAsyncStorageOwner: () => owner };
        if (name === './context-recovery-storage-idle')
          return {
            startRecoveryStorageAsyncIdle: (options) => {
              idle = options;
              return { close() {} };
            },
          };
        return load(name);
      });
      await new Promise(setImmediate);
      await assert.rejects(idle.execute(), safe);
      const closing = idle.onFailure();
      if (failedPost) await assert.rejects(closing, (error) => error === postError);
      else await closing;
      assert.equal(cleaned, true);
      assert.equal(closed, true);
      assert.deepEqual(messages.at(-1), {
        id: 0,
        ok: false,
        diagnostic: { phase: 'anchor-persist', cleanupFailed: false },
      });
      assert.equal(
        messages.some((value) => Object.hasOwn(value, 'result')),
        false
      );
    }
  );

test('parent observes a post-ready idle failure and refuses all further work', async () => {
  const f = workerFixture({ ok: true, result: { records: 0, bytes: 0 } }),
    observed = [];
  const storage = await openContextRecoveryStorage({
    directory,
    WorkerType: f.WorkerType,
    onFailure: (value) => observed.push(value),
  });
  f.inspect().emit('message', {
    id: 0,
    ok: false,
    diagnostic: { phase: 'engine-snapshot', cleanupFailed: false },
  });
  await assert.rejects(storage.execute({ operation: 'inspect' }), safe);
  await assert.rejects(storage.close(), safe);
  assert.deepEqual(observed, [
    { operation: 'sweep', phase: 'engine-snapshot', cleanupFailed: false },
  ]);
  assert.equal(f.inspect().terminated, 1);
});

test('successful work emits no failure receipt and the original request timeout is not extended', async () => {
  const f = workerFixture({ ok: true, result: { records: 0, bytes: 0 } }),
    observed = [];
  const storage = await openContextRecoveryStorage({
    directory,
    WorkerType: f.WorkerType,
    timeoutMs: 100,
    onFailure: (value) => observed.push(value),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.execute({ operation: 'inspect' }))), {
    records: 0,
    bytes: 0,
  });
  assert.deepEqual(observed, []);
  // Keep the actual service timer; only the synthetic worker stops replying.
  f.inspect().postMessage = () => {};
  await assert.rejects(storage.execute({ operation: 'inspect' }), safe);
  await assert.rejects(storage.close(), safe);
  assert.deepEqual(observed, [
    { operation: 'inspect', phase: 'worker-unavailable', cleanupFailed: false },
  ]);
  assert.equal(f.inspect().terminated, 1);
});

test('actual async owner retains the failed phase even when its mandatory cleanup also rejects', async () => {
  const filename = path.resolve(__dirname, '../lib/proxy/context-recovery-storage-owner.js');
  const load = createRequire(filename);
  for (const phase of [
    'engine-execute',
    'engine-snapshot',
    'anchor-persist',
    'owner-verify',
    'owner-close',
  ]) {
    for (const cleanupFailed of [false, true]) {
      let armed = false,
        verifies = 0,
        closes = 0;
      const reject = () => {
        throw Error('PRIVATE_PHASE_SENTINEL');
      };
      const paths = {
        prepare: (value) => value,
        exists: () => false,
        writeKey: (value) => value,
        verify() {
          if (armed && phase === 'owner-verify' && ++verifies === 2) reject();
        },
      };
      const engine = {
        execute() {
          if (phase === 'engine-execute') reject();
          return { records: 0, bytes: 0 };
        },
        snapshot() {
          if (armed && phase === 'engine-snapshot') reject();
          return {};
        },
        close() {},
      };
      const anchor = {
        initialStoreId: undefined,
        initialTime: 0,
        validateStartup() {},
        persist() {},
        close() {},
        async persistAsync() {
          if (phase === 'anchor-persist') reject();
        },
        async closeAsync() {
          closes++;
          if (cleanupFailed || phase === 'owner-close') reject();
        },
      };
      const target = { exports: {} };
      vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module'], { filename })(
        (name) => {
          if (name === 'node:sqlite')
            return {
              DatabaseSync: class {
                exec() {}
                close() {}
              },
            };
          if (name === './context-recovery-storage-paths')
            return { createStoragePaths: () => paths };
          if (name === './context-recovery-storage-sqlite')
            return {
              createRecoverySqliteStore(options) {
                options.beforeStartup({});
                return engine;
              },
            };
          if (name === './context-recovery-anchor-admission')
            return { createRecoveryAsyncAnchorAdmission: () => anchor };
          return load(name);
        },
        target
      );
      const owner = target.exports.createAsyncStorageOwner(
        { directory, protectKey: ({ value }) => KEY_PREFIX + value },
        {
          createAnchorSession: () => ({ repository: {}, commit() {}, close() {} }),
        }
      );
      armed = true;
      const action =
        phase === 'owner-close' ? owner.close() : owner.execute({ operation: 'inspect' });
      await assert.rejects(action, (error) => {
        assert.deepEqual(storageFailureDiagnostic(error), {
          phase,
          cleanupFailed:
            phase === 'owner-close' || phase === 'engine-execute' ? false : cleanupFailed,
        });
        return safe(error);
      });
      // A rejected SQL transaction remains usable; all other failures close or
      // poison the owner. No second cleanup attempt may manufacture success.
      if (phase !== 'engine-execute') {
        const attempts = closes;
        await owner.close().catch((error) => assert.ok(safe(error)));
        assert.equal(closes, attempts);
      } else await owner.close().catch((error) => assert.ok(safe(error)));
    }
  }
});
