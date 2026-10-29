'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createContextRecoveryRuntime } = require('../lib/proxy/context-recovery-runtime');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { clearInactiveRecoveryStorage } = require('../lib/proxy/context-recovery-clear-storage');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');

const unavailable = 'context_recovery_storage_unavailable';
const settings = (enabled, persistent) => ({
  appSettings: { contextRecoveryEnabled: enabled, contextRecoveryPersistenceEnabled: persistent },
});
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function safe(error) {
  assert.equal(error.code, unavailable);
  assert.equal(error.message, unavailable);
  assert.equal(error.cause, undefined);
  return true;
}
function fixture({ execute, inactive = async () => {}, decorate } = {}) {
  const database = new DatabaseSync(':memory:');
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
  });
  const owners = [];
  const runtime = createContextRecoveryRuntime({
    dataDirectory: path.join(os.tmpdir(), 'hpm-clear-fixture'),
    prepareDirectory() {},
    clearInactiveStorage: inactive,
    createLifecycle(options) {
      const owner = createContextRecoveryLifecycle(
        options.directory
          ? {
              storage: {
                execute: (request) =>
                  execute
                    ? execute(request, () => engine.execute(request))
                    : engine.execute(request),
                close() {},
              },
            }
          : {}
      );
      decorate?.(owner);
      owners.push(owner);
      return owner;
    },
  });
  return {
    runtime,
    engine,
    database,
    owners,
    async close() {
      await runtime.shutdownAsync();
      engine.close();
      database.close();
    },
  };
}
async function seed(engine) {
  const request = {
    operation: 'save',
    scope: 'a'.repeat(64),
    expectedRevision: 0,
    expiresAt: Date.now() + 60000,
    state: { synthetic: 'owned-clear-fixture', budget: { calls: 12 } },
  };
  await engine.execute(request);
  return request;
}

test('clear atomically revokes active disk payload, retains denial metadata and permits fresh work', async () => {
  const f = fixture();
  try {
    f.runtime.configureSettings(settings(true, true));
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    const request = await seed(f.engine);
    assert.deepEqual(await f.runtime.clearAsync(), { ok: true });
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.deepEqual(f.engine.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
    assert.equal(f.engine.execute({ operation: 'load', scope: request.scope }), null);
    assert.equal(f.database.prepare('SELECT kind FROM recovery_state').get().kind, 'revoked');
    assert.throws(() => f.engine.execute(request), safe);
    const fresh = f.runtime.sessions.begin({
      principal: 'owner',
      protocol: 'chat',
      target: 'target',
      history: [{ role: 'user', content: 'fresh-synthetic-task' }],
    });
    assert.equal(
      (await fresh.completeObservedAsync([{ role: 'assistant', content: 'done' }])).ok,
      true
    );
    assert.equal(f.engine.execute({ operation: 'inspect' }).records, 1);
    assert.deepEqual(await f.runtime.clearAsync(), { ok: true });
    assert.equal(f.engine.execute({ operation: 'inspect' }).records, 0);
  } finally {
    await f.close();
  }
});

test('clear suspends memory capabilities immediately and deduplicates while the inactive store is draining', async () => {
  const gate = deferred();
  let inactiveCalls = 0;
  const f = fixture({
    inactive() {
      inactiveCalls++;
      return gate.promise;
    },
  });
  try {
    f.runtime.configureSettings(settings(true, false));
    await f.runtime.ready();
    const old = f.runtime.sessions.begin({
      principal: 'owner',
      protocol: 'chat',
      target: 'target',
      history: [{ role: 'user', content: 'synthetic-task' }],
    });
    assert.equal(old.ok, true);
    const clearing = f.runtime.clearAsync();
    assert.equal(f.runtime.clearAsync(), clearing);
    assert.equal(f.runtime.sessions.inspect().roots, 0);
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    assert.equal(f.runtime.inspect().state, 'clearing');
    const diagnostics = createContextRecoveryDiagnostics();
    diagnostics.attachLifecycle(f.runtime);
    assert.equal(diagnostics.inspect(settings(true, false)).state, 'pending_application');
    f.runtime.configure(true);
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    let ready = false;
    const waiting = f.runtime.ready().then((result) => {
      ready = true;
      return result;
    });
    await flush();
    assert.equal(ready, false);
    assert.equal(inactiveCalls, 1);
    gate.resolve();
    assert.deepEqual(await clearing, { ok: true });
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.equal(
      (await old.completeObservedAsync([{ role: 'assistant', content: 'stale' }])).ok,
      false
    );
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('clear preserves newer disables, mode changes and shutdowns instead of reviving the previous policy', async () => {
  for (const mode of ['disable', 'persistent', 'shutdown']) {
    const gate = deferred();
    const entered = deferred();
    const f = fixture({
      inactive() {
        entered.resolve();
        return gate.promise;
      },
    });
    try {
      f.runtime.configureSettings(settings(true, false));
      await f.runtime.ready();
      const clearing = f.runtime.clearAsync();
      await entered.promise;
      let shutdown;
      if (mode === 'shutdown') shutdown = f.runtime.shutdownAsync();
      else f.runtime.configureSettings(settings(mode !== 'disable', mode === 'persistent'));
      gate.resolve();
      assert.equal((await clearing).ok, mode !== 'shutdown');
      if (shutdown) {
        assert.deepEqual(await shutdown, { ok: true });
        assert.equal((await f.runtime.clearAsync()).code, 'context_recovery_disabled');
      } else {
        assert.deepEqual(await f.runtime.ready(), { ok: true });
        assert.equal(f.runtime.sessions.inspect().enabled, mode === 'persistent');
        assert.equal(f.runtime.inspect().appliedPersistence, mode === 'persistent');
      }
    } finally {
      gate.resolve();
      await f.close();
    }
  }
});

test('clear during a mode transition waits for its owner and revocation ACK before reopening admission', async () => {
  const gate = deferred();
  let hold = true;
  const f = fixture({
    execute(request, next) {
      return hold && request.operation === 'catalog' ? gate.promise.then(next) : next();
    },
  });
  try {
    f.runtime.configureSettings(settings(true, true));
    const clearing = f.runtime.clearAsync();
    await flush();
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    hold = false;
    gate.resolve();
    assert.deepEqual(await clearing, { ok: true });
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.inspect().storage, 'persistent');
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('inactive clear failures and non-executing malformed replies are terminal with fixed errors', async () => {
  for (const mode of ['throw', 'reject', 'shape', 'getter']) {
    let executed = 0;
    const f = fixture({
      inactive() {
        if (mode === 'throw') throw new Error('PRIVATE_DATA');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE_DATA'));
        if (mode === 'shape') return { ok: true };
        return {
          get then() {
            executed++;
            throw new Error('PRIVATE_DATA');
          },
        };
      },
    });
    try {
      f.runtime.configureSettings(settings(true, false));
      await f.runtime.ready();
      assert.deepEqual(await f.runtime.clearAsync(), { ok: false, code: unavailable });
      f.runtime.configure(true);
      assert.equal((await f.runtime.ready()).code, unavailable);
      assert.equal((await f.runtime.clearAsync()).code, unavailable);
      assert.equal(f.runtime.sessions.inspect().enabled, false);
      assert.equal(executed, 0);
      assert.doesNotMatch(JSON.stringify(f.runtime.inspect()), /PRIVATE_DATA/);
    } finally {
      await f.close();
    }
  }
});

test('failed active revocation never reports clear success or switches to alternate storage', async () => {
  let rejecting = false;
  const f = fixture({
    execute(request, next) {
      if (rejecting && request.operation === 'revoke-all') throw new Error('PRIVATE_DATA');
      return next();
    },
  });
  try {
    f.runtime.configureSettings(settings(true, true));
    await f.runtime.ready();
    await seed(f.engine);
    rejecting = true;
    assert.equal((await f.runtime.clearAsync()).code, unavailable);
    assert.equal(f.engine.execute({ operation: 'inspect' }).records, 1);
    assert.equal(f.runtime.inspect().state, 'failed');
    assert.equal(f.owners.length, 2);
  } finally {
    await f.close();
  }
});

test('clear drains an in-flight checkpoint before durable revocation and cannot publish its stale completion', async () => {
  const entered = deferred(),
    release = deferred();
  const f = fixture({
    execute(request, next) {
      if (request.operation !== 'save') return next();
      entered.resolve();
      return release.promise.then(next);
    },
  });
  try {
    f.runtime.configureSettings(settings(true, true));
    await f.runtime.ready();
    const old = f.runtime.sessions.begin({
      principal: 'owner',
      protocol: 'chat',
      target: 'target',
      history: [{ role: 'user', content: 'pending-synthetic-task' }],
    });
    const completing = old.completeObservedAsync([{ role: 'assistant', content: 'stale-answer' }]);
    await entered.promise;
    let cleared = false;
    const clearing = f.runtime.clearAsync().then((result) => {
      cleared = true;
      return result;
    });
    f.runtime.configure(true);
    await flush();
    assert.equal(cleared, false);
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    release.resolve();
    assert.equal((await completing).ok, false);
    assert.deepEqual(await clearing, { ok: true });
    assert.deepEqual(f.engine.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
  } finally {
    release.resolve();
    await f.close();
  }
});

test('inactive clear validates options, skips missing directories and rejects files without opening an owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-clear-options-'));
  let executed = 0;
  const factory = () => {
    executed++;
    throw new Error('PRIVATE_DATA');
  };
  try {
    for (const options of [
      null,
      [],
      {},
      { directory: root, extra: true },
      { directory: root, openStorage: 1 },
      {
        get directory() {
          executed++;
          return root;
        },
      },
    ])
      await assert.rejects(clearInactiveRecoveryStorage(options), safe);
    await clearInactiveRecoveryStorage({
      directory: path.join(root, 'missing'),
      openStorage: factory,
    });
    await clearInactiveRecoveryStorage({ directory: root, openStorage: factory });
    assert.equal(fs.existsSync(path.join(root, 'missing')), false);
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'synthetic');
    await assert.rejects(
      clearInactiveRecoveryStorage({ directory: file, openStorage: factory }),
      safe
    );
    await assert.rejects(
      clearInactiveRecoveryStorage({ directory: root, openStorage: factory }),
      safe
    );
    assert.equal(executed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inactive owner ACKs and teardown reject malformed, rejected and accessor replies without leaking data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-clear-acks-'));
  fs.writeFileSync(path.join(root, 'checkpoint.sqlite'), 'owned-synthetic-placeholder');
  try {
    for (const mode of [
      'missing',
      'throw',
      'reject',
      'shape',
      'getter',
      'close',
      'close-shape',
      'remaining',
    ]) {
      let closed = 0,
        executed = 0;
      const factory = () => ({
        execute:
          mode === 'missing'
            ? undefined
            : (request) => {
                if (request.operation === 'inspect')
                  return { records: mode === 'remaining' ? 1 : 0, bytes: 0 };
                if (mode === 'throw') throw new Error('PRIVATE_DATA');
                if (mode === 'reject') return Promise.reject(new Error('PRIVATE_DATA'));
                if (mode === 'shape') return { revoked: 0, extra: 'PRIVATE_DATA' };
                if (mode === 'getter')
                  return {
                    get then() {
                      executed++;
                      return () => {};
                    },
                  };
                return { revoked: 0 };
              },
        close() {
          closed++;
          if (mode === 'close') throw new Error('PRIVATE_DATA');
          return mode === 'close-shape' ? {} : undefined;
        },
      });
      await assert.rejects(
        clearInactiveRecoveryStorage({ directory: root, openStorage: factory }),
        safe
      );
      assert.equal(closed, 1);
      assert.equal(executed, 0);
    }
    await clearInactiveRecoveryStorage({
      directory: root,
      openStorage: async () => ({
        execute: async (request) =>
          request.operation === 'revoke-all' ? { revoked: 0 } : { records: 0, bytes: 0 },
        close: async () => {},
      }),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'memory-mode clear removes actual inactive Windows ciphertext payload and denies stale writes after reopen',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const started = Date.now();
    const phase = (name) =>
      t.diagnostic(JSON.stringify({ phase: name, elapsedMs: Date.now() - started }));
    const open = (prefix, options) =>
      openContextRecoveryStorage({
        ...options,
        onStartup: ({ phase: name }) => phase(prefix + '_' + name),
      });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-clear-physical-'));
    const directory = path.join(root, 'context-recovery-v1');
    let storage, runtime;
    try {
      phase('start');
      storage = await open('seed', { directory });
      const request = await seed(storage);
      // The worker's asynchronous save must finish before releasing its lock.
      await storage.execute({ operation: 'load', scope: request.scope });
      await storage.close();
      storage = undefined;
      phase('seed_closed');
      runtime = createContextRecoveryRuntime({
        dataDirectory: root,
        clearInactiveStorage: (options) =>
          clearInactiveRecoveryStorage({
            ...options,
            openStorage: (input) => open('clear', input),
          }),
      });
      runtime.configureSettings(settings(true, false));
      await runtime.ready();
      assert.deepEqual(await runtime.clearAsync(), { ok: true });
      phase('cleared');
      assert.equal(runtime.inspect().storage, 'memory');
      assert.equal(runtime.inspect().appliedEnabled, true);
      storage = await open('reopen', { directory });
      assert.deepEqual(
        { ...(await storage.execute({ operation: 'inspect' })) },
        { records: 0, bytes: 0 }
      );
      assert.equal(await storage.execute({ operation: 'load', scope: request.scope }), null);
      await assert.rejects(storage.execute(request), safe);
      phase('stale_write_denied');
    } finally {
      phase('cleanup_started');
      await storage?.close();
      await runtime?.shutdownAsync();
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('hpm-clear-physical-'));
      fs.rmSync(resolved, { recursive: true, force: true });
      phase('cleanup_finished');
    }
  }
);
