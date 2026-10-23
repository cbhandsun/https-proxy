'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const { createHash } = require('node:crypto');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const {
  createContextRecoveryRuntime,
  recoveryStorageSettings,
} = require('../lib/proxy/context-recovery-runtime');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const unavailable = 'context_recovery_storage_unavailable';
const dataDirectory = path.join(os.tmpdir(), 'hpm-unused-runtime-policy');
const settings = (enabled, persistent) => ({
  appSettings: { contextRecoveryEnabled: enabled, contextRecoveryPersistenceEnabled: persistent },
});
const flush = () => new Promise(setImmediate);

test('disabled default runtime and actual core composition keep session ownership cold until enabled', async () => {
  const files = ['context-recovery-runtime', 'core-request-handler'];
  const cached = new Map(
    files.map((name) => {
      const file = require.resolve('../lib/proxy/' + name);
      return [file, require.cache[file]];
    })
  );
  const load = Module._load;
  let allowed = false;
  let runtime;
  try {
    for (const file of cached.keys()) delete require.cache[file];
    Module._load = function (request) {
      const name = request.split(/[\\/]/).at(-1).replace(/\.js$/, '');
      if (name === 'context-recovery-lifecycle' || name === 'context-recovery-sessions')
        assert.equal(allowed, true, 'disabled composition loaded session ownership');
      return Reflect.apply(load, this, arguments);
    };
    const fresh = require('../lib/proxy/context-recovery-runtime');
    runtime = fresh.createContextRecoveryRuntime({ dataDirectory });
    for (const persistence of [false, true, false, true]) {
      runtime.configureSettings(settings(false, persistence));
      assert.deepEqual(await runtime.ready(), { ok: true });
      assert.equal(runtime.inspect().state, 'disabled');
      assert.equal(runtime.inspect().requestedPersistence, persistence);
      assert.equal(runtime.inspect().appliedPersistence, false);
    }
    runtime.configureSettings(settings(false, false));
    const { createCoreRequestHandler } = require('../lib/proxy/core-request-handler');
    const reachedMetadata = new Error('fixture_metadata_boundary');
    const handler = createCoreRequestHandler({
      contextRecoveryLifecycle: runtime,
      getRuntimeState: () => ({ CONFIG: settings(false, false) }),
      getClientIp() {
        throw reachedMetadata;
      },
    });
    assert.throws(
      () => handler({ headers: {} }, new EventEmitter()),
      (error) => error === reachedMetadata
    );
    assert.equal(runtime.inspect().state, 'disabled');
    allowed = true;
    runtime.configure(true);
    assert.deepEqual(await runtime.ready(), { ok: true });
    const actual = runtime.sessions;
    assert.equal(actual.inspect().enabled, true);
    runtime.configure(false);
    assert.equal(runtime.sessions, actual);
    assert.equal(actual.inspect().enabled, false);
    assert.deepEqual(await runtime.shutdownAsync(), { ok: true });
    assert.equal(actual.inspect().closed, true);
  } finally {
    Module._load = load;
    if (runtime) await runtime.shutdownAsync();
    for (const [file, previous] of cached) {
      if (previous === undefined) delete require.cache[file];
      else require.cache[file] = previous;
    }
  }
});

test('unallocated default owners honor clear, superseding policy and terminal shutdown without constructing authority', async () => {
  for (const mode of ['enable', 'disable', 'shutdown', 'failure']) {
    const clearing = deferred();
    let clears = 0;
    const runtime = createContextRecoveryRuntime({
      dataDirectory,
      clearInactiveStorage() {
        clears++;
        return clearing.promise;
      },
    });
    const operation = runtime.clearAsync();
    assert.equal(runtime.clearAsync(), operation);
    await flush();
    assert.equal(clears, 1);
    assert.equal(runtime.inspect().state, 'clearing');
    let session, shutdown;
    if (mode === 'enable' || mode === 'disable') {
      runtime.configure(true);
      session = runtime.sessions;
      assert.equal(session.inspect().enabled, false, 'clear holds admission');
      if (mode === 'disable') runtime.configure(false);
    }
    if (mode === 'shutdown') {
      shutdown = runtime.shutdownAsync();
      runtime.configure(true);
      assert.throws(() => runtime.sessions, safe);
    }
    clearing.resolve(mode === 'failure' ? { invalid: true } : undefined);
    const result = await operation;
    if (mode === 'failure') {
      assert.deepEqual(result, { ok: false, code: unavailable });
      runtime.configure(true);
      assert.throws(() => runtime.sessions, safe);
      assert.deepEqual(await runtime.ready(), { ok: false, code: unavailable });
    } else if (mode === 'shutdown') {
      assert.equal(result.code, 'context_recovery_disabled');
      assert.deepEqual(await shutdown, { ok: true });
    } else {
      assert.deepEqual(result, { ok: true });
      assert.equal(runtime.sessions, session);
      assert.equal(session.inspect().enabled, mode === 'enable');
    }
    await runtime.shutdownAsync();
    assert.equal(runtime.inspect().state, mode === 'failure' ? 'failed' : 'closed');
  }
});

test('unused default runtime closes without loading a lifecycle and rejects all later creation', async () => {
  const load = Module._load;
  const runtime = createContextRecoveryRuntime({ dataDirectory });
  try {
    Module._load = function (request) {
      assert.notEqual(
        request,
        './context-recovery-lifecycle',
        'closed service cannot create an owner'
      );
      return Reflect.apply(load, this, arguments);
    };
    runtime.configure(false);
    assert.deepEqual(await runtime.configureAsync(false), { ok: true });
    const shutdown = runtime.shutdownAsync();
    assert.equal(runtime.shutdownAsync(), shutdown);
    runtime.configureSettings(settings(true, true));
    assert.deepEqual(await shutdown, { ok: true });
    assert.equal(runtime.inspect().state, 'closed');
    assert.throws(() => runtime.sessions, safe);
    assert.equal((await runtime.ready()).code, 'context_recovery_disabled');
    assert.equal((await runtime.clearAsync()).code, 'context_recovery_disabled');
  } finally {
    Module._load = load;
    await runtime.shutdownAsync();
  }
});

test('disabled persistent preference permits explicit inactive clear without creating recovery ownership', async () => {
  const load = Module._load;
  let clears = 0,
    preparations = 0;
  const runtime = createContextRecoveryRuntime({
    dataDirectory,
    prepareDirectory() {
      preparations++;
      throw new Error('PRIVATE_UNEXPECTED_PREPARATION');
    },
    clearInactiveStorage(options) {
      clears++;
      assert.equal(options.directory, path.join(dataDirectory, 'context-recovery-v1'));
    },
  });
  try {
    Module._load = function (request) {
      assert.notEqual(request, './context-recovery-lifecycle');
      return Reflect.apply(load, this, arguments);
    };
    runtime.configureSettings(settings(false, true));
    assert.deepEqual(await runtime.configureAsync(false), { ok: true });
    assert.deepEqual(await runtime.clearAsync(), { ok: true });
    assert.equal(clears, 1);
    assert.equal(preparations, 0);
    assert.equal(runtime.inspect().state, 'disabled');
    assert.equal(runtime.inspect().requestedPersistence, true);
    assert.equal(runtime.inspect().appliedPersistence, false);
    assert.deepEqual(await runtime.shutdownAsync(), { ok: true });
  } finally {
    Module._load = load;
    await runtime.shutdownAsync();
  }
});

test('default lifecycle first-load failure is terminal, sanitized and never retried on requests', async () => {
  const load = Module._load;
  const runtime = createContextRecoveryRuntime({ dataDirectory });
  let attempts = 0;
  try {
    Module._load = function (request) {
      if (request === './context-recovery-lifecycle') {
        attempts++;
        throw new Error('PRIVATE_LIFECYCLE_LOAD_TOKEN');
      }
      return Reflect.apply(load, this, arguments);
    };
    runtime.configureSettings(settings(true, false));
    assert.equal(attempts, 1, 'configured enable loads ownership before requests');
    assert.deepEqual(await runtime.ready(), { ok: false, code: unavailable });
    assert.equal(runtime.inspect().state, 'failed');
    assert.throws(() => runtime.sessions, safe);
    runtime.configureSettings(settings(true, true));
    runtime.configure(false);
    runtime.configure(true);
    assert.equal(attempts, 1);
    assert.doesNotMatch(JSON.stringify(runtime.inspect()), /PRIVATE_LIFECYCLE_LOAD_TOKEN/);
    assert.deepEqual(await runtime.shutdownAsync(), { ok: false, code: unavailable });
  } finally {
    Module._load = load;
    await runtime.shutdownAsync();
  }
});

test('memory runtime composition and shutdown keep persistence execution cold', async () => {
  const files = [
    'context-recovery-runtime',
    'context-recovery-lifecycle',
    'context-recovery-clear-storage',
  ];
  const cached = new Map(
    files.map((name) => {
      const file = require.resolve('../lib/proxy/' + name);
      return [file, require.cache[file]];
    })
  );
  const forbidden = new Set([
    'context-recovery-storage-opening',
    'context-recovery-storage',
    'node:worker_threads',
  ]);
  const load = Module._load;
  let runtime;
  try {
    for (const file of cached.keys()) delete require.cache[file];
    Module._load = function (request) {
      const name = request.split(/[\\/]/).at(-1).replace(/\.js$/, '');
      assert.equal(forbidden.has(name), false, 'memory owner loaded persistence execution');
      return Reflect.apply(load, this, arguments);
    };
    const fresh = require('../lib/proxy/context-recovery-runtime');
    runtime = fresh.createContextRecoveryRuntime({ dataDirectory });
    const sessions = runtime.sessions;
    assert.equal(runtime.inspect().state, 'disabled');
    runtime.configureSettings(settings(true, false));
    assert.deepEqual(await runtime.ready(), { ok: true });
    assert.equal(runtime.sessions, sessions, 'retain the actual session identity');
    runtime.configure(false);
    assert.equal(runtime.inspect().appliedEnabled, false);
    assert.deepEqual(await runtime.shutdownAsync(), { ok: true });
  } finally {
    Module._load = load;
    if (runtime) await runtime.shutdownAsync();
    for (const [file, previous] of cached) {
      if (previous === undefined) delete require.cache[file];
      else require.cache[file] = previous;
    }
  }
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('persistence first-load failures stay owned and do not restore admission', async () => {
  const load = Module._load;
  const runtime = createContextRecoveryRuntime({ dataDirectory, prepareDirectory() {} });
  let attempts = 0;
  try {
    Module._load = function (request) {
      if (request === './context-recovery-storage-opening') {
        attempts++;
        throw new Error('PRIVATE_STORAGE_MODULE_TOKEN');
      }
      return Reflect.apply(load, this, arguments);
    };
    runtime.configureSettings(settings(true, false));
    assert.deepEqual(await runtime.ready(), { ok: true });
    const previous = runtime.sessions;
    runtime.configureSettings(settings(true, true));
    assert.deepEqual(await runtime.ready(), { ok: false, code: unavailable });
    assert.equal(attempts, 1);
    assert.equal(previous.inspect().closed, true);
    assert.equal(runtime.inspect().appliedEnabled, false);
    assert.equal(runtime.inspect().state, 'failed');
    runtime.configureSettings(settings(true, false));
    assert.deepEqual(await runtime.ready(), { ok: false, code: unavailable });
    assert.equal(runtime.sessions, previous, 'no replacement memory owner on failure');
    assert.doesNotMatch(JSON.stringify(runtime.inspect()), /PRIVATE_STORAGE_MODULE_TOKEN/);
  } finally {
    Module._load = load;
    await runtime.shutdownAsync();
  }
});

test('inactive clear loads persistence only for a validated store and sanitizes first-load failure', async () => {
  const { clearInactiveRecoveryStorage } = require('../lib/proxy/context-recovery-clear-storage');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-cold-clear-'));
  const load = Module._load;
  let attempts = 0;
  try {
    Module._load = function (request) {
      if (request === './context-recovery-storage') {
        attempts++;
        throw new Error('PRIVATE_CLEAR_MODULE_TOKEN');
      }
      return Reflect.apply(load, this, arguments);
    };
    await clearInactiveRecoveryStorage({ directory: path.join(directory, 'missing') });
    await clearInactiveRecoveryStorage({ directory });
    for (const invalid of [undefined, {}, { directory, openStorage: null }])
      await assert.rejects(clearInactiveRecoveryStorage(invalid), safe);
    assert.equal(attempts, 0);
    const checkpoint = path.join(directory, 'checkpoint.sqlite');
    fs.writeFileSync(checkpoint, 'synthetic unopened store');
    await assert.rejects(clearInactiveRecoveryStorage({ directory }), safe);
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(checkpoint, 'utf8'), 'synthetic unopened store');
  } finally {
    Module._load = load;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-cold-clear-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const fresh = createContextRecoveryRuntime({ dataDirectory });
  fresh.configure(true);
  assert.deepEqual(await fresh.ready(), { ok: true });
  assert.deepEqual(await fresh.shutdownAsync(), { ok: true });
});
function safe(error) {
  assert.equal(error.code, unavailable);
  assert.equal(error.message, unavailable);
  assert.equal(error.cause, undefined);
  return true;
}
function fixture({ beforeExecute, beforeClose, decorate, prepareDirectory = () => {} } = {}) {
  const owners = [],
    operations = [],
    directories = [],
    databases = [],
    stores = [],
    keys = [];
  const runtime = createContextRecoveryRuntime({
    dataDirectory,
    prepareDirectory,
    createLifecycle(options) {
      directories.push(options.directory);
      let storage;
      if (options.directory) {
        const database = new DatabaseSync(':memory:');
        databases.push(database);
        const dataKey = randomBytes(32).toString('base64');
        keys.push(dataKey);
        const engine = createRecoverySqliteStore({
          database,
          dataKey,
        });
        stores.push(engine);
        storage = {
          execute(request) {
            operations.push(request.operation);
            return beforeExecute
              ? beforeExecute(request, () => engine.execute(request))
              : engine.execute(request);
          },
          async close() {
            if (beforeClose) await beforeClose();
            engine.close();
          },
        };
      }
      const owner = createContextRecoveryLifecycle(storage ? { storage } : {});
      owners.push(owner);
      decorate?.(owner, options);
      return owner;
    },
  });
  return {
    runtime,
    owners,
    operations,
    directories,
    databases,
    stores,
    keys,
    async close() {
      await runtime.shutdownAsync();
      for (const database of databases) database.close();
    },
  };
}

test('disabled persistence preference opens no storage and direct enable honors the retained preference', async () => {
  let preparations = 0;
  const changes = [];
  const f = fixture({
    prepareDirectory() {
      preparations++;
    },
    decorate(owner, options) {
      const configure = owner.configure;
      owner.configure = (enabled) => {
        changes.push({ persistent: !!options.directory, enabled });
        return configure(enabled);
      };
    },
  });
  try {
    for (let index = 0; index < 100; index++) {
      f.runtime.configureSettings(settings(false, index % 2 === 1));
      assert.deepEqual(await f.runtime.ready(), { ok: true });
    }
    assert.equal(preparations, 0);
    assert.deepEqual(f.directories, [undefined]);
    assert.deepEqual(f.operations, []);
    assert.equal(f.runtime.inspect().requestedPersistence, true);
    assert.equal(f.runtime.inspect().appliedPersistence, false);
    const start = changes.length;
    assert.deepEqual(await f.runtime.configureAsync(true), { ok: true });
    assert.equal(preparations, 1);
    assert.equal(f.runtime.inspect().appliedPersistence, true);
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.ok(changes.slice(start).every((change) => change.persistent || !change.enabled));
    assert.equal(f.owners.length, 2);
  } finally {
    await f.close();
  }
});

test('disabling an existing persistent owner denies recovery without replacing or deleting its retained store', async () => {
  const f = fixture();
  try {
    f.runtime.configureSettings(settings(true, true));
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    const owner = f.runtime.sessions;
    const scope = 'e'.repeat(64);
    const expiresAt = Date.now() + 60000;
    const state = { synthetic: 'retained while recovery is disabled' };
    f.stores[0].execute({ operation: 'save', scope, expectedRevision: 0, expiresAt, state });
    const count = f.operations.length;
    f.runtime.configureSettings(settings(false, true));
    assert.equal(owner.inspect().enabled, false, 'disable stops admission synchronously');
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.sessions, owner);
    assert.equal(f.runtime.inspect().appliedEnabled, false);
    assert.equal(f.runtime.inspect().requestedPersistence, true);
    assert.equal(f.runtime.inspect().storage, 'persistent');
    assert.equal(f.runtime.inspect().state, 'disabled');
    assert.equal(f.owners.length, 2);
    assert.equal(f.operations.slice(count).includes('revoke-all'), false);
    const retained = f.stores[0].execute({ operation: 'load', scope });
    assert.deepEqual({ ...retained.state }, state);
    assert.equal(retained.expiresAt, expiresAt);
  } finally {
    await f.close();
  }
});

test('storage settings are independent strict booleans and never execute getters or inherited policy', () => {
  assert.deepEqual(recoveryStorageSettings({}), { enabled: false, persistent: false });
  assert.deepEqual(recoveryStorageSettings(settings(false, true)), {
    enabled: false,
    persistent: true,
  });
  assert.throws(
    () => recoveryStorageSettings(Object.create({ appSettings: settings(true, true).appSettings })),
    safe
  );
  let executed = 0;
  for (const value of [
    null,
    [],
    { appSettings: null },
    { appSettings: [] },
    settings(true, 'true'),
    settings(1, false),
    {
      get appSettings() {
        executed++;
        return {};
      },
    },
    {
      appSettings: {
        get contextRecoveryPersistenceEnabled() {
          executed++;
          return true;
        },
      },
    },
  ])
    assert.throws(() => recoveryStorageSettings(value), safe);
  assert.equal(executed, 0);
});

test('runtime composition validates options and sanitizes throwing or malformed factories before opening storage', () => {
  let executed = 0;
  for (const value of [
    null,
    [],
    {},
    { dataDirectory: 'relative' },
    { dataDirectory, createLifecycle: null },
    { dataDirectory, prepareDirectory: null },
    {
      dataDirectory,
      get prepareDirectory() {
        executed++;
        return () => {};
      },
    },
    { dataDirectory, extra: true },
    {
      get dataDirectory() {
        executed++;
        return dataDirectory;
      },
    },
    {
      dataDirectory,
      createLifecycle() {
        throw new Error('PRIVATE_DATA');
      },
    },
    { dataDirectory, createLifecycle: () => ({}) },
  ])
    assert.throws(() => createContextRecoveryRuntime(value), safe);
  assert.equal(executed, 0);
});

test('memory mode uses actual sessions, opens no directory and ordinary shutdown never configures a revocation', async () => {
  const changes = [];
  const f = fixture({
    decorate(owner) {
      const configure = owner.configure;
      owner.configure = (value) => {
        changes.push(value);
        configure(value);
      };
    },
  });
  try {
    f.runtime.configureSettings(settings(true, false));
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.deepEqual(f.directories, [undefined]);
    const count = changes.length;
    const shutdown = f.runtime.shutdownAsync();
    assert.equal(f.runtime.shutdownAsync(), shutdown);
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    assert.deepEqual(await shutdown, { ok: true });
    assert.equal(changes.length, count);
    assert.equal(f.runtime.inspect().state, 'closed');
    assert.equal((await f.runtime.ready()).code, 'context_recovery_disabled');
    f.runtime.configureSettings(settings(true, true));
    assert.equal(f.owners.length, 1);
  } finally {
    await f.close();
  }
});

test('mode changes invalidate and drain actual owners without deleting retained data', async () => {
  const closing = deferred();
  const f = fixture({ beforeClose: () => closing.promise });
  try {
    f.runtime.configureSettings(settings(true, false));
    const old = f.runtime.sessions;
    f.runtime.configureSettings(settings(true, true));
    assert.equal(old.inspect().enabled, false);
    assert.equal(f.runtime.inspect().state, 'switching');
    await f.runtime.ready();
    assert.notEqual(f.runtime.sessions, old);
    assert.equal(old.inspect().closed, true);
    assert.equal(f.runtime.inspect().storage, 'persistent');
    assert.equal(f.runtime.inspect().restartRetention, false);
    assert.deepEqual(f.directories, [undefined, path.join(dataDirectory, 'context-recovery-v1')]);
    const persistent = f.runtime.sessions;
    const retainedScope = 'd'.repeat(64);
    const retainedState = { synthetic: 'retained across storage-mode change' };
    f.stores[0].execute({
      operation: 'save',
      scope: retainedScope,
      expectedRevision: 0,
      expiresAt: Date.now() + 60000,
      state: retainedState,
    });
    f.runtime.configureSettings(settings(true, false));
    assert.equal(persistent.inspect().enabled, false);
    await flush();
    assert.equal(f.owners.length, 2);
    assert.equal(f.runtime.inspect().state, 'switching');
    closing.resolve();
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.inspect().storage, 'memory');
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.equal(persistent.inspect().closed, true);
    assert.equal(f.operations.includes('revoke-all'), false);
    const reopened = createRecoverySqliteStore({ database: f.databases[0], dataKey: f.keys[0] });
    try {
      assert.deepEqual(
        { ...reopened.execute({ operation: 'load', scope: retainedScope }).state },
        retainedState
      );
    } finally {
      reopened.close();
    }
  } finally {
    closing.resolve();
    await f.close();
  }
});

test('late enable cannot overtake disable while actual session storage discovery is pending', async () => {
  const opening = deferred();
  const f = fixture({
    beforeExecute(request, next) {
      return request.operation === 'catalog' ? opening.promise.then(next) : next();
    },
  });
  try {
    f.runtime.configureSettings(settings(true, true));
    const enabling = f.runtime.configureAsync(true);
    await flush();
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    f.runtime.configureSettings(settings(false, true));
    opening.resolve();
    assert.equal((await enabling).code, 'context_recovery_disabled');
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    assert.equal(f.owners.length, 2);
  } finally {
    opening.resolve();
    await f.close();
  }
});

test('management projection reports pending application until actual persistent catalog startup completes', async () => {
  const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');
  const opening = deferred();
  const f = fixture({
    beforeExecute: (request, next) =>
      request.operation === 'catalog' ? opening.promise.then(next) : next(),
  });
  try {
    const diagnostics = createContextRecoveryDiagnostics();
    assert.equal(diagnostics.attachLifecycle(f.runtime), true);
    const config = settings(true, true);
    f.runtime.configureSettings(config);
    await flush();
    const pending = diagnostics.inspect(config);
    assert.equal(pending.configValid, true);
    assert.equal(pending.requestedEnabled, true);
    assert.equal(pending.appliedEnabled, false);
    assert.equal(pending.state, 'pending_application');
    opening.resolve();
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(diagnostics.inspect(config).appliedEnabled, true);
    assert.equal(diagnostics.inspect(config).storage, 'persistent');
  } finally {
    opening.resolve();
    await f.close();
  }
});

test('newer retention settings win during opening and repeated requests do not create extra owners', async () => {
  const opening = deferred();
  const f = fixture({
    beforeExecute(request, next) {
      return request.operation === 'catalog' ? opening.promise.then(next) : next();
    },
  });
  try {
    f.runtime.configureSettings(settings(true, true));
    await flush();
    f.runtime.configureSettings(settings(true, false));
    for (let i = 0; i < 8; i++) f.runtime.configure(true);
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    opening.resolve();
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.inspect().storage, 'memory');
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.equal(f.owners.length, 3);
  } finally {
    opening.resolve();
    await f.close();
  }
});

test('normal persistent shutdown preserves committed bytes rather than revoking all roots', async () => {
  const f = fixture();
  try {
    f.runtime.configureSettings(settings(true, true));
    await f.runtime.ready();
    const scope = 'c'.repeat(64);
    const state = { synthetic: 'committed bytes' };
    f.stores[0].execute({
      operation: 'save',
      scope,
      expectedRevision: 0,
      expiresAt: Date.now() + 60000,
      state,
    });
    const count = f.operations.filter((operation) => operation.startsWith('revoke')).length;
    assert.deepEqual(await f.runtime.shutdownAsync(), { ok: true });
    assert.equal(f.operations.filter((operation) => operation.startsWith('revoke')).length, count);
    const reopened = createRecoverySqliteStore({ database: f.databases[0], dataKey: f.keys[0] });
    try {
      assert.equal(reopened.execute({ operation: 'load', scope }).state.synthetic, state.synthetic);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('settings disable retains exact originals and fresh reauthorization never revives old capabilities', async () => {
  const f = fixture();
  try {
    f.runtime.configureSettings(settings(true, true));
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
    const history = [{ role: 'user', content: 'question' }];
    const tool = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    };
    const root = f.runtime.sessions.begin({ ...binding, history });
    assert.equal(
      (
        await root.completeObservedAsync(
          [tool],
          [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }]
        )
      ).ok,
      true
    );
    const original = 'retained\r\n原文🙂';
    const captured = [
      ...history,
      tool,
      { role: 'tool', tool_call_id: 'external', content: original },
    ];
    const child = f.runtime.sessions.begin({ ...binding, history: captured }, [
      { callId: 'external', output: original },
    ]);
    const receipt = JSON.parse((await child.replyAsync(LIST, {})).text).sources[0];
    const answer = [{ role: 'assistant', content: 'done' }];
    assert.equal((await child.completeObservedAsync(answer)).ok, true);
    const request = {
      ...binding,
      history: [...captured, ...answer, { role: 'user', content: 'continue' }],
    };
    const scope = createHash('sha256')
      .update('hpm/recovery-root/v1\0' + root.snapshotId)
      .digest('hex');
    const before = f.stores[0].execute({ operation: 'load', scope });
    const count = f.operations.length;
    f.runtime.configureSettings(settings(false, true));
    assert.equal((await child.replyAsync(READ, receipt)).ok, false);
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.deepEqual(f.stores[0].execute({ operation: 'load', scope }), before);
    assert.equal(
      f.operations.slice(count).some((operation) => operation.startsWith('revoke')),
      false
    );
    f.runtime.configureSettings(settings(true, true));
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal((await child.replyAsync(READ, receipt)).ok, false);
    const fresh = await f.runtime.sessions.beginAsync(request, [], () => true);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.reason, 'observed_continuation');
    const read = await fresh.replyAsync(READ, {
      sourceId: receipt.sourceId,
      digest: receipt.digest,
    });
    assert.equal(read.ok, true);
    assert.equal(JSON.parse(read.text).page.text, original);
    const after = f.stores[0].execute({ operation: 'load', scope });
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.state.root.budget.calls, before.state.root.budget.calls + 1);
    f.runtime.configureSettings(settings(false, true));
    await f.runtime.ready();
    assert.deepEqual(await f.runtime.clearAsync(), { ok: true });
    assert.equal(f.stores[0].execute({ operation: 'load', scope }), null);
  } finally {
    await f.close();
  }
});

test('shutdown during opening drains actual session and never opens a newer requested mode', async () => {
  const opening = deferred();
  const f = fixture({
    beforeExecute(request, next) {
      return request.operation === 'catalog' ? opening.promise.then(next) : next();
    },
  });
  try {
    f.runtime.configureSettings(settings(true, true));
    await flush();
    const shutdown = f.runtime.shutdownAsync();
    assert.equal(f.runtime.sessions.inspect().enabled, false);
    f.runtime.configureSettings(settings(true, false));
    opening.resolve();
    assert.deepEqual(await shutdown, { ok: true });
    assert.equal(f.owners.length, 2);
    assert.equal(f.runtime.sessions.inspect().closed, true);
  } finally {
    opening.resolve();
    await f.close();
  }
});

test('storage failures, bad settings and malformed replies remain terminal without fallback or secret diagnostics', async () => {
  for (const mode of ['open', 'close', 'config', 'inspect']) {
    const f = fixture({
      beforeExecute(request, next) {
        if (mode === 'open') throw new Error('PRIVATE_DATA');
        return next();
      },
      beforeClose() {
        if (mode === 'close') throw new Error('PRIVATE_DATA');
      },
      decorate(owner) {
        if (mode === 'inspect') owner.inspect = () => ({ secret: 'PRIVATE_DATA' });
      },
    });
    try {
      if (mode === 'config')
        assert.throws(() => f.runtime.configureSettings(settings(true, 'PRIVATE_DATA')), safe);
      else if (mode === 'inspect') assert.equal(f.runtime.inspect().state, 'failed');
      else {
        f.runtime.configureSettings(settings(true, true));
        await f.runtime.ready();
        if (mode === 'close') {
          f.runtime.configureSettings(settings(true, false));
          await f.runtime.ready();
        }
      }
      assert.equal(f.runtime.inspect().state, 'failed');
      assert.doesNotMatch(JSON.stringify(f.runtime.inspect()), /PRIVATE_DATA/);
      const count = f.owners.length;
      f.runtime.configureSettings(settings(true, false));
      assert.equal(f.owners.length, count);
      assert.equal((await f.runtime.shutdownAsync()).code, unavailable);
    } finally {
      await f.close();
    }
  }
});

test('malformed acquired owners and policy ACKs are drained without running getters or opening fallback storage', async () => {
  for (const mode of ['missing', 'shape', 'thenable', 'throw', 'reject']) {
    let executed = 0;
    const f = fixture({
      decorate(owner, options) {
        if (!options.directory) return;
        if (mode === 'missing') {
          owner.ready = null;
          return;
        }
        owner.configureAsync = () => {
          if (mode === 'throw') throw new Error('PRIVATE_DATA');
          if (mode === 'reject') return Promise.reject(new Error('PRIVATE_DATA'));
          if (mode === 'shape') return { ok: true, secret: 'PRIVATE_DATA' };
          return {
            get then() {
              executed++;
              throw new Error('PRIVATE_DATA');
            },
          };
        };
      },
    });
    try {
      f.runtime.configureSettings(settings(true, true));
      assert.equal((await f.runtime.ready()).code, unavailable);
      assert.equal(f.runtime.inspect().state, 'failed');
      assert.equal(f.owners.length, 2);
      assert.equal(f.owners[1].sessions.inspect().closed, true);
      assert.equal(executed, 0);
      assert.doesNotMatch(JSON.stringify(f.runtime.inspect()), /PRIVATE_DATA/);
    } finally {
      await f.close();
    }
  }
});

test('rapid settings supersede uncommitted mode changes without opening every intermediate directory', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) f.runtime.configureSettings(settings(true, i % 2 === 0));
    assert.deepEqual(await f.runtime.ready(), { ok: true });
    assert.equal(f.runtime.sessions.inspect().enabled, true);
    assert.equal(f.runtime.inspect().appliedPersistence, false);
    assert.equal(f.owners.length, 2);
    assert.deepEqual(f.directories, [undefined, undefined]);
  } finally {
    await f.close();
  }
});

test('directory preparation is lazy, awaited and superseded settings cannot open an obsolete persistent owner', async () => {
  for (const mode of ['disable', 'memory', 'shutdown']) {
    const pending = deferred();
    const calls = [];
    const f = fixture({
      prepareDirectory(directory) {
        calls.push(directory);
        return pending.promise;
      },
    });
    try {
      f.runtime.configureSettings(settings(true, false));
      assert.deepEqual(await f.runtime.ready(), { ok: true });
      assert.deepEqual(calls, []);
      const old = f.runtime.sessions;
      f.runtime.configureSettings(settings(true, true));
      await flush();
      assert.deepEqual(calls, [dataDirectory]);
      assert.equal(f.owners.length, 1);
      assert.equal(old.inspect().closed, true);
      assert.equal(f.runtime.inspect().state, 'switching');
      let shutdown;
      if (mode === 'shutdown') shutdown = f.runtime.shutdownAsync();
      else f.runtime.configureSettings(settings(mode !== 'disable', mode === 'disable'));
      pending.resolve();
      if (shutdown) {
        assert.deepEqual(await shutdown, { ok: true });
        assert.equal(f.owners.length, 1);
      } else {
        assert.deepEqual(await f.runtime.ready(), { ok: true });
        assert.equal(f.runtime.sessions.inspect().enabled, mode !== 'disable');
        assert.equal(f.runtime.inspect().appliedPersistence, false);
        assert.deepEqual(f.directories, [undefined, undefined]);
      }
    } finally {
      pending.resolve();
      await f.close();
    }
  }
});

test('failed or malformed directory preparation is terminal and cannot invoke thenable getters or open storage', async () => {
  for (const mode of ['throw', 'reject', 'shape', 'thenable']) {
    let executed = 0;
    const f = fixture({
      prepareDirectory() {
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
      f.runtime.configureSettings(settings(true, true));
      assert.equal((await f.runtime.ready()).code, unavailable);
      assert.equal(f.owners.length, 1);
      assert.equal(executed, 0);
      assert.equal(f.runtime.sessions.inspect().closed, true);
      assert.equal(f.runtime.inspect().state, 'failed');
      assert.doesNotMatch(JSON.stringify(f.runtime.inspect()), /PRIVATE_DATA/);
      assert.equal((await f.runtime.shutdownAsync()).code, unavailable);
    } finally {
      await f.close();
    }
  }
});

test(
  'runtime setting opens and drains a real encrypted Windows directory without restoring root authority',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-runtime-policy-'));
    let runtime;
    try {
      const dataDirectory = path.join(directory, 'custom', 'runtime');
      runtime = createContextRecoveryRuntime({ dataDirectory });
      assert.equal(fs.existsSync(dataDirectory), false);
      runtime.configureSettings(settings(true, true));
      assert.equal(runtime.sessions.inspect().enabled, false);
      assert.deepEqual(await runtime.ready(), { ok: true });
      assert.equal(runtime.inspect().storage, 'persistent');
      assert.equal(runtime.sessions.inspect().roots, 0);
      assert.ok(
        fs.statSync(path.join(dataDirectory, 'context-recovery-v1', 'checkpoint.sqlite')).isFile()
      );
      assert.deepEqual(await runtime.shutdownAsync(), { ok: true });
    } finally {
      await runtime?.shutdownAsync();
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('hpm-runtime-policy-'));
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
);
