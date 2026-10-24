'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const testTempRoot = resolvePhysicalTestTempDirectory();
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { discoverTestFiles } = require('../lib/test-discovery');
const {
  exerciseRuntimeReopenRevocation,
} = require('../scripts/lib/nsis-runtime-reopen-assertions');

const failure = { message: 'runtime_reopen_assertion_failed' };
const original = 'synthetic-runtime-reopen\r\nélève🙂';
const expected = {
  schemaVersion: 1,
  checks: {
    persistentRuntimeRead: true,
    principalRevokeAcknowledged: true,
    principalReopenDenied: true,
    clearAcknowledged: true,
    clearReopenDenied: true,
    allOwnersClosed: true,
  },
  installationQualified: false,
  restartRetention: false,
};

function caseFixture(t) {
  const root = fs.mkdtempSync(path.join(testTempRoot, 'hpm-runtime-reopen-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(testTempRoot));
    assert.ok(path.basename(root).startsWith('hpm-runtime-reopen-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// These capabilities test assertion/failure wiring only. They are deliberately
// supplied only by this test harness and provide no DPAPI/storage qualification.
function loadAssertions(dependencies) {
  const filename = path.resolve(__dirname, '../scripts/lib/nsis-runtime-reopen-assertions.js');
  const actualRequire = createRequire(filename);
  const module = { exports: {} };
  // Keep object literals in the production module's realm: lifecycle boundary
  // guards intentionally reject foreign prototypes, including VM records.
  const evaluate = vm.runInThisContext(
    '(function (module, exports, require) {\n' + fs.readFileSync(filename, 'utf8') + '\n})',
    { filename }
  );
  evaluate(module, module.exports, (name) =>
    Object.hasOwn(dependencies, name) ? dependencies[name] : actualRequire(name)
  );
  return module.exports.exerciseRuntimeReopenRevocation;
}

function syntheticAssertions(mode) {
  const states = new Map();
  const calls = { owners: 0, ownerCloses: 0, stores: 0, storeCloses: 0 };
  function createContextRecoveryRuntime(options) {
    assert.deepEqual(Object.keys(options), ['dataDirectory']);
    calls.owners++;
    const state = states.get(options.dataDirectory) || { records: 0, owners: 0 };
    states.set(options.dataDirectory, state);
    const reopened = state.owners++ > 0;
    let begins = 0;
    const view = {
      ok: true,
      async replyAsync(name) {
        if (!state.records && !(reopened && mode === 'reopen-read')) return { ok: false };
        return {
          ok: true,
          text: JSON.stringify(
            name.includes('list')
              ? { sources: [{ sourceId: 'synthetic-source', digest: 'a'.repeat(64) }] }
              : { page: { text: mode === 'seed-read' ? 'PRIVATE_DATA' : original } }
          ),
        };
      },
    };
    return {
      configureSettings(config) {
        assert.deepEqual(JSON.parse(JSON.stringify(config)), {
          appSettings: { contextRecoveryEnabled: true, contextRecoveryPersistenceEnabled: true },
        });
      },
      ready: async () => ({ ok: mode !== 'ready' }),
      inspect: () => ({
        storage: 'persistent',
        appliedEnabled: true,
        appliedPersistence: true,
        restartRetention: false,
      }),
      sessions: {
        async beginAsync() {
          if (reopened) return mode === 'reopen-read' ? view : { ok: false };
          if (++begins > 2) return view;
          return {
            ok: true,
            snapshotId: 'synthetic-snapshot',
            async completeObservedAsync() {
              state.records = 1;
              return { ok: true };
            },
          };
        },
        async revokeAsync(principal) {
          assert.equal(principal, 'n09-owner');
          if (mode === 'revoke-throw') throw new Error('PRIVATE_DATA');
          state.records = 0;
          return { ok: mode !== 'revoke' };
        },
      },
      async clearAsync() {
        state.records = 0;
        return { ok: mode !== 'clear' };
      },
      async shutdownAsync() {
        calls.ownerCloses++;
        return mode === 'runtime-close-shape' ? {} : { ok: mode !== 'runtime-close' };
      },
    };
  }
  async function openContextRecoveryStorage(options) {
    assert.deepEqual(Object.keys(options), ['directory']);
    calls.stores++;
    const state = states.get(path.dirname(options.directory));
    return {
      async execute(request) {
        if (request.operation === 'inspect')
          return { records: mode === 'reopen-record' ? 1 : state.records, bytes: 0 };
        assert.equal(request.operation, 'load');
        return mode === 'reopen-load' ? { state: {} } : null;
      },
      async close() {
        calls.storeCloses++;
        if (mode === 'storage-close') throw new Error('PRIVATE_DATA');
        if (mode === 'storage-close-shape') return {};
      },
    };
  }
  const exercise = loadAssertions({
    '../../lib/proxy/context-recovery-runtime': { createContextRecoveryRuntime },
    '../../lib/proxy/context-recovery-storage': { openContextRecoveryStorage },
  });
  return {
    exercise,
    calls,
    runtimeApi: { createContextRecoveryRuntime },
    storageApi: { openContextRecoveryStorage },
  };
}

test('synthetic trusted API composition exclusively uses supplied capabilities', async (t) => {
  const root = caseFixture(t);
  const fixture = syntheticAssertions();
  const exercise = loadAssertions({
    '../../lib/proxy/context-recovery-runtime': new Proxy(
      {},
      {
        get() {
          throw new Error('checkout forbidden');
        },
      }
    ),
    '../../lib/proxy/context-recovery-storage': new Proxy(
      {},
      {
        get() {
          throw new Error('checkout forbidden');
        },
      }
    ),
  });
  assert.deepEqual(
    await exercise({
      caseRoot: root,
      runtimeApi: fixture.runtimeApi,
      storageApi: fixture.storageApi,
    }),
    expected
  );
  assert.deepEqual(fixture.calls, { owners: 4, ownerCloses: 4, stores: 2, storeCloses: 2 });
});

test('synthetic capabilities invoke function bodies without reading their own bind getters', async (t) => {
  const root = caseFixture(t);
  const fixture = syntheticAssertions();
  let getterCalls = 0;
  for (const api of [fixture.runtimeApi, fixture.storageApi]) {
    for (const method of Object.values(api)) {
      Object.defineProperty(method, 'bind', {
        get() {
          getterCalls++;
          throw new Error('must not access bind');
        },
      });
    }
  }
  assert.deepEqual(
    await exerciseRuntimeReopenRevocation({
      caseRoot: root,
      runtimeApi: fixture.runtimeApi,
      storageApi: fixture.storageApi,
    }),
    expected
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(fixture.calls, { owners: 4, ownerCloses: 4, stores: 2, storeCloses: 2 });
});

test('invalid input capabilities reject missing methods, selectors, getters and proxies without invocation', async (t) => {
  const root = caseFixture(t);
  let invoked = 0;
  const method = () => {
    invoked++;
    throw new Error('must not execute');
  };
  const runtimeApi = { createContextRecoveryRuntime: method };
  const storageApi = { openContextRecoveryStorage: method };
  const getter = {};
  Object.defineProperty(getter, 'createContextRecoveryRuntime', {
    enumerable: true,
    get() {
      invoked++;
      return method;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        invoked++;
        return [];
      },
    }
  );
  const functionProxy = new Proxy(method, {
    apply() {
      invoked++;
    },
  });
  for (const input of [
    { caseRoot: root, runtimeApi },
    { caseRoot: root, storageApi },
    { caseRoot: root, runtimeApi, storageApi, modulePath: 'anything' },
    ...[
      null,
      [],
      {},
      { createContextRecoveryRuntime: null },
      getter,
      proxy,
      Object.create(runtimeApi),
      { createContextRecoveryRuntime: functionProxy },
      { ...runtimeApi, modulePath: 'anything' },
    ].map((bad) => ({ caseRoot: root, runtimeApi: bad, storageApi })),
    ...[null, {}, { openContextRecoveryStorage: 'anything' }].map((bad) => ({
      caseRoot: root,
      runtimeApi,
      storageApi: bad,
    })),
  ])
    await assert.rejects(exerciseRuntimeReopenRevocation(input), failure);
  const accessorInput = { caseRoot: root, storageApi };
  Object.defineProperty(accessorInput, 'runtimeApi', {
    enumerable: true,
    get() {
      invoked++;
      return runtimeApi;
    },
  });
  await assert.rejects(exerciseRuntimeReopenRevocation(accessorInput), failure);
  assert.equal(invoked, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('synthetic assertion wiring returns only fixed checks after every owner closes', async (t) => {
  const root = caseFixture(t);
  const fixture = syntheticAssertions();
  assert.deepEqual(
    JSON.parse(JSON.stringify(await fixture.exercise({ caseRoot: root }))),
    expected
  );
  assert.deepEqual(fixture.calls, { owners: 4, ownerCloses: 4, stores: 2, storeCloses: 2 });
  assert.equal(fs.readdirSync(root).length, 1);
});

test('actual runtime and lifecycle use synthetic in-memory SQLite without claiming DPAPI', async (t) => {
  const root = caseFixture(t);
  const { DatabaseSync } = require('node:sqlite');
  const { randomBytes } = require('node:crypto');
  const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
  const { createContextRecoveryRuntime } = require('../lib/proxy/context-recovery-runtime');
  const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
  const stores = new Map();
  t.after(() => {
    for (const { database } of stores.values()) database.close();
  });
  function storage(directory) {
    if (!stores.has(directory))
      stores.set(directory, {
        database: new DatabaseSync(':memory:'),
        dataKey: randomBytes(32).toString('base64'),
      });
    const engine = createRecoverySqliteStore(stores.get(directory));
    return {
      execute: (request) => engine.execute(request),
      close() {
        engine.close();
      },
    };
  }
  const exercise = loadAssertions({
    '../../lib/proxy/context-recovery-runtime': {
      createContextRecoveryRuntime: ({ dataDirectory }) =>
        createContextRecoveryRuntime({
          dataDirectory,
          prepareDirectory: async () => {},
          createLifecycle: ({ directory }) =>
            createContextRecoveryLifecycle(directory ? { storage: storage(directory) } : {}),
        }),
    },
    '../../lib/proxy/context-recovery-storage': {
      openContextRecoveryStorage: async ({ directory }) => storage(directory),
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await exercise({ caseRoot: root }))), expected);
  assert.equal(stores.size, 2);
});

test('invalid input, accessors, proxies, extra selectors and links fail before creating artifacts', async (t) => {
  const root = caseFixture(t);
  let executed = 0;
  const accessor = {
    get caseRoot() {
      executed++;
      return root;
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        executed++;
        return [];
      },
    }
  );
  for (const input of [
    null,
    [],
    {},
    '',
    { caseRoot: '' },
    { caseRoot: 'relative' },
    { caseRoot: root, dataDirectory: root },
    { caseRoot: 'x'.repeat(4097) },
    { caseRoot: root + '\0' },
    accessor,
    proxy,
    Object.create({ caseRoot: root }),
  ]) {
    await assert.rejects(exerciseRuntimeReopenRevocation(input), failure);
  }
  const target = path.join(root, 'target');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(target);
  fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exerciseRuntimeReopenRevocation({ caseRoot: linked }), failure);
  assert.equal(executed, 0);
  assert.deepEqual(fs.readdirSync(root).sort(), ['linked', 'target']);
});

test('synthetic failures and failed or malformed close acknowledgements cannot produce success', async (t) => {
  for (const mode of [
    'ready',
    'seed-read',
    'revoke',
    'revoke-throw',
    'clear',
    'reopen-record',
    'reopen-load',
    'reopen-read',
    'runtime-close',
    'runtime-close-shape',
    'storage-close',
    'storage-close-shape',
  ]) {
    await t.test(mode, async (sub) => {
      const root = caseFixture(sub);
      const fixture = syntheticAssertions(mode);
      await assert.rejects(
        exerciseRuntimeReopenRevocation({
          caseRoot: root,
          runtimeApi: fixture.runtimeApi,
          storageApi: fixture.storageApi,
        }),
        (error) => {
          assert.equal(error.message, failure.message);
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(String(error), /PRIVATE_DATA|hpm-runtime-reopen-test/);
          return true;
        }
      );
      assert.ok(fixture.calls.ownerCloses >= 1);
      if (fixture.calls.stores) assert.ok(fixture.calls.storeCloses >= 1);
    });
  }
});

test(
  'real default runtime and protected storage deny revoked and cleared roots after orderly reopen',
  {
    timeout: 60000,
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const root = caseFixture(t);
    assert.deepEqual(
      await exerciseRuntimeReopenRevocation(
        { caseRoot: root },
        {
          onPhase(event) {
            process.stderr.write(
              JSON.stringify({ scope: 'runtime-reopen-phase', ...event }) + '\n'
            );
          },
        }
      ),
      expected
    );
    const [work] = fs.readdirSync(root);
    assert.ok(work.startsWith('runtime-reopen-'));
    for (const action of ['revoke', 'clear']) {
      const directory = path.join(root, work, action, 'context-recovery-v1');
      assert.ok(fs.statSync(path.join(directory, '.data-key')).isFile());
      assert.equal(
        fs.readFileSync(path.join(directory, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
    }
  }
);

test('the assertions regression participates in unified test discovery', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-runtime-reopen-assertions.test.js'
    )
  );
});
