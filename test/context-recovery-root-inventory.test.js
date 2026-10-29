'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecoveryRootLoading } = require('../lib/proxy/context-recovery-root-loading');
const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
const {
  createRecoveryStorageInventory,
  aliasRecoveryStorageInventory,
  createRecoveryRootInventory,
} = require('../lib/proxy/context-recovery-storage-inventory');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  createContextRecoveryStorageOpening,
} = require('../lib/proxy/context-recovery-storage-opening');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
  initializeContextRecoveryStorage,
} = require('../lib/proxy/context-recovery-sessions');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

test('a complete current online inventory removes the redundant offline scan before a live continuation', async () => {
  let scans = 0;
  const selected = {
    ok: true,
    reason: 'observed_continuation',
    rootId: 'hbs_' + 'a'.repeat(32),
    location: 'online',
  };
  const loader = createRecoveryRootLoading({
    capture: () => () => 100,
    probe: () => selected,
    probeMetadata: () => selected,
    referenceScan: () => true,
    activeRoots: () => new Set([selected.rootId]),
    allStoredRootsActive: () => true,
    execute: () => () => {
      scans++;
      throw Error('unexpected_offline_scan');
    },
    waitObserved: async () => {},
    begin: () => ({ ok: true }),
  });
  assert.deepEqual(
    await loader.begin(
      {
        principal: 'owner',
        protocol: 'chat',
        target: 'target',
        history: [{ role: 'user', content: 'question' }],
      },
      [],
      () => true,
      false
    ),
    { ok: true }
  );
  assert.equal(scans, 0);
  await loader.drain();
});

function inventoryFixture() {
  const storage = { execute() {} };
  const writes = createRecoveryStorageInventory(storage);
  const roots = new Map([['root', {}]]);
  const inventory = createRecoveryRootInventory(storage, roots);
  return { storage, writes, roots, inventory, active: new Set(['root']) };
}

test('only complete unchanged discovery certifies an inventory; each acknowledged owner write advances its fence', () => {
  const f = inventoryFixture();
  assert.equal(f.inventory.allActive(f.active), false);
  f.inventory.completeDiscovery(f.inventory.beforeDiscovery());
  assert.equal(f.inventory.allActive(f.active), true);
  assert.equal(f.inventory.allActive(new Set()), false);
  const finish = f.inventory.begin('save-reference-state');
  const done = f.writes.begin('save-reference-state');
  assert.equal(f.inventory.allActive(f.active), false);
  done();
  done();
  finish(true);
  finish(false);
  assert.equal(f.inventory.allActive(f.active), true);
  const read = f.inventory.begin('load-reference');
  f.writes.begin('load-reference')();
  read(true);
  assert.equal(f.inventory.allActive(f.active), true);
});

test('unknown, overlapping, failed and closed writes never restore a certificate from an old ACK', () => {
  for (const mode of ['external', 'overlap', 'failure', 'closed', 'pruned']) {
    const f = inventoryFixture();
    f.inventory.completeDiscovery(f.inventory.beforeDiscovery());
    const finish = f.inventory.begin('save');
    const done = f.writes.begin('save');
    if (mode === 'external' || mode === 'overlap') {
      const other = f.writes.begin('save');
      if (mode === 'overlap') f.inventory.begin('save')(false);
      other();
    } else if (mode === 'closed') f.writes.close();
    else if (mode === 'pruned') {
      f.roots.delete('root');
      f.inventory.invalidate();
    }
    done();
    finish(mode !== 'failure');
    assert.equal(f.inventory.allActive(f.active), false, mode);
  }
  const f = inventoryFixture();
  const before = f.inventory.beforeDiscovery();
  f.writes.begin('save')();
  f.inventory.completeDiscovery(before);
  assert.equal(f.inventory.allActive(f.active), false);
});

test('lazy fresh services can certify after opening; adapters, changed methods and malicious sets cannot', () => {
  const f = inventoryFixture();
  const facade = { execute() {} };
  const inventory = createRecoveryRootInventory(facade, f.roots);
  const before = inventory.beforeDiscovery();
  assert.equal(aliasRecoveryStorageInventory(facade, f.storage), true);
  inventory.completeDiscovery(before);
  assert.equal(inventory.allActive(f.active), true);
  let hooks = 0;
  const badSet = new Set(['root']);
  badSet.has = () => {
    hooks++;
    return true;
  };
  assert.equal(inventory.allActive(badSet), true);
  for (const bad of [null, {}, [], new Proxy(f.active, {})])
    assert.equal(inventory.allActive(bad), false);
  Object.defineProperty(f.storage, 'execute', {
    get() {
      hooks++;
      return () => {};
    },
  });
  assert.equal(inventory.allActive(f.active), false);
  assert.equal(aliasRecoveryStorageInventory({}, f.storage), false);
  assert.equal(hooks, 0);
  const untracked = createRecoveryRootInventory({ execute() {} }, new Map());
  untracked.completeDiscovery(untracked.beforeDiscovery());
  assert.equal(untracked.allActive(new Set()), false);
  assert.throws(() => createRecoveryStorageInventory(new Proxy({}, {})));
  assert.throws(() => createRecoveryRootInventory({}, new Proxy(new Map(), {})));
});

test('discovery mutations, index pruning and nonfresh lazy backends cannot produce a zero-generation certificate', () => {
  for (const mode of ['write', 'pruned', 'nonfresh']) {
    const f = inventoryFixture();
    const facade = { execute() {} };
    const inventory = createRecoveryRootInventory(facade, f.roots);
    const before = inventory.beforeDiscovery();
    if (mode === 'pruned') inventory.invalidate();
    else f.writes.begin('save')();
    assert.equal(aliasRecoveryStorageInventory(facade, f.storage), true);
    inventory.completeDiscovery(before);
    assert.equal(inventory.allActive(f.active), false, mode);
  }
});

test('all mutation kinds invalidate unknown writes; facade chains stay bounded and cannot be rebound', () => {
  for (const operation of [
    'save',
    'save-reference',
    'save-reference-state',
    'settle-reader',
    'read-source-and-settle',
    'revoke',
    'revoke-all',
    'revoke-scopes',
    'sweep',
  ]) {
    const f = inventoryFixture();
    f.inventory.completeDiscovery(f.inventory.beforeDiscovery());
    const finish = f.writes.begin(operation);
    assert.equal(f.inventory.allActive(f.active), false, operation);
    finish();
    assert.equal(f.inventory.allActive(f.active), false, operation);
  }
  const f = inventoryFixture();
  let source = f.storage;
  for (let index = 0; index < 7; index++) {
    const facade = { execute() {} };
    assert.equal(aliasRecoveryStorageInventory(facade, source), true);
    assert.equal(aliasRecoveryStorageInventory(facade, f.storage), false);
    source = facade;
  }
  assert.equal(aliasRecoveryStorageInventory({ execute() {} }, source), false);
  assert.throws(() => createRecoveryStorageInventory(f.storage));
  const unknown = inventoryFixture();
  unknown.inventory.completeDiscovery(unknown.inventory.beforeDiscovery());
  const finishUnknown = unknown.inventory.begin('future-write');
  unknown.writes.begin('future-write')();
  finishUnknown(true);
  assert.equal(unknown.inventory.allActive(unknown.active), false);
});

test('generation exhaustion disables the optimization even with overlapping completions', () => {
  const module = { exports: {} };
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/proxy/context-recovery-storage-inventory.js'),
    'utf8'
  );
  vm.runInNewContext(source, {
    module,
    Object,
    Number: { MAX_SAFE_INTEGER: 5 },
    require(name) {
      if (name === 'node:util') return require('node:util');
      if (name === './context-recovery-storage-contract')
        return require('../lib/proxy/context-recovery-storage-contract');
      throw Error('unexpected_import');
    },
  });
  const storage = { execute() {} };
  const fence = module.exports.createRecoveryStorageInventory(storage);
  const inventory = module.exports.createRecoveryRootInventory(storage, new Map());
  inventory.completeDiscovery(inventory.beforeDiscovery());
  assert.equal(inventory.allActive(new Set()), true);
  const completions = [fence.begin('save'), fence.begin('save'), fence.begin('save')];
  for (const finish of completions) {
    finish();
    finish();
  }
  inventory.completeDiscovery(inventory.beforeDiscovery());
  assert.equal(inventory.allActive(new Set()), false);
});

test('the denial index keeps the exact expiry on the original scan/prune path', async (t) => {
  const storage = { execute: () => [] };
  createRecoveryStorageInventory(storage);
  const transactions = createRecoveryRootStorage(storage);
  t.after(() => transactions.close());
  await transactions.discover();
  const rootId = 'hbs_' + 'a'.repeat(32);
  transactions.registerRoot({ rootId, principal: 'owner', createdAt: 100, expiresAt: 200 });
  const active = new Set([rootId]);
  assert.equal(transactions.allStoredRootsActive(active, 199), true);
  for (const time of [
    0,
    99,
    200,
    201,
    undefined,
    null,
    NaN,
    Infinity,
    -1,
    0.5,
    '100',
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(transactions.allStoredRootsActive(active, time), false);
});

test('a fast-path certificate is checked again after waiting and malformed or async predicates never begin a request', async () => {
  for (const mode of ['changed', 'throws', 'object', 'async', 'reject', 'thenable', 'revoked']) {
    let calls = 0,
      begins = 0,
      hooks = 0,
      authorized = true;
    const selected = { ok: true, location: 'online', rootId: 'hbs_' + 'a'.repeat(32) };
    const loader = createRecoveryRootLoading({
      capture: () => () => 100,
      probe: () => selected,
      probeMetadata: () => selected,
      referenceScan: () => true,
      activeRoots: () => new Set([selected.rootId]),
      allStoredRootsActive() {
        calls++;
        if (mode === 'throws') throw Error('PRIVATE');
        if (mode === 'object') return {};
        if (mode === 'async') return Promise.resolve(true);
        if (mode === 'reject') return Promise.reject(Error('PRIVATE'));
        if (mode === 'thenable')
          return Object.defineProperty({}, 'then', {
            get() {
              hooks++;
              return undefined;
            },
          });
        return mode !== 'changed' || calls === 1;
      },
      execute: () => () => {
        throw Error('unexpected_scan');
      },
      async waitObserved() {
        if (mode === 'revoked') authorized = false;
      },
      begin() {
        begins++;
        return { ok: true };
      },
    });
    assert.deepEqual(
      await loader.begin(
        {
          principal: 'owner',
          protocol: 'chat',
          target: 'target',
          history: [{ role: 'user', content: 'question' }],
        },
        [],
        () => authorized,
        false
      ),
      { ok: false, code: 'context_recovery_storage_unavailable' },
      mode
    );
    assert.equal(begins, 0);
    assert.equal(hooks, 0);
    await loader.drain();
  }
});

// Physical SQLite and real service protocol, with a synthetic worker/key only.
// These fixtures confer no Windows, DPAPI, OS-anchor or daemon qualification.
async function fixture(t, lazy = false, observed = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-inventory-test-'));
  const database = new DatabaseSync(path.join(directory, 'checkpoint.sqlite'));
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const requests = [];
  let stopped = false;
  function stop() {
    if (!stopped) {
      stopped = true;
      engine.close();
      database.close();
    }
  }
  class EngineWorker extends EventEmitter {
    constructor() {
      super();
      this.stdout = this.stderr = { resume() {} };
      queueMicrotask(() => this.emit('message', { id: 0, ok: true }));
    }
    postMessage({ id, request }) {
      requests.push(request);
      queueMicrotask(() => {
        if (request.operation === 'close') {
          this.emit('message', { id, ok: true, result: null });
          stop();
          this.emit('exit', 0);
          return;
        }
        let result;
        try {
          result = engine.execute(request);
        } catch {
          this.emit('message', { id, ok: false });
          return;
        }
        this.emit('message', { id, ok: true, result });
      });
    }
    terminate() {
      stop();
      return Promise.resolve(1);
    }
  }
  const exports = {
    openContextRecoveryStorage: (options) =>
      openContextRecoveryStorage({ ...options, WorkerType: EngineWorker }),
  };
  const observer = observed
    ? require('../scripts/context-hosted/n09-business/publication-storage-observer').installPublicationStorageObserver(
        {
          storageExports: exports,
          storageContract: require('../lib/proxy/context-recovery-storage-contract'),
          storageInventory: require('../lib/proxy/context-recovery-storage-inventory'),
          expectedDirectory: directory,
        }
      )
    : null;
  const native = await exports.openContextRecoveryStorage({ directory });
  const storage = lazy
    ? createContextRecoveryStorageOpening({ directory, openStorage: async () => native })
    : native;
  const sessions = createContextRecoverySessions({ now: () => 100 });
  const lifecycle = createContextRecoveryLifecycle({ sessions, storage });
  t.after(async () => {
    try {
      await lifecycle.shutdownAsync();
    } finally {
      observer?.close();
      stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  assert.deepEqual(await lifecycle.configureAsync(true), { ok: true });
  return { directory, database, engine, requests, native, storage, sessions, lifecycle, observer };
}
const original = 'bounded synthetic evidence\r\nélève🙂';
const user = (content) => ({ role: 'user', content });
async function seedInto(sessions) {
  const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
  const history = [user('question')];
  const external = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const root = sessions.begin({ ...binding, history });
  assert.equal(
    (
      await root.completeObservedAsync(
        [external],
        [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }]
      )
    ).ok,
    true
  );
  const captured = [
    ...history,
    external,
    { role: 'tool', tool_call_id: 'external', content: original },
  ];
  const child = sessions.begin({ ...binding, history: captured }, [
    { callId: 'external', output: original },
  ]);
  const list = await child.replyAsync(LIST, {});
  assert.equal(list.ok, true);
  const receipt = JSON.parse(list.text).sources[0];
  const output = [{ role: 'assistant', content: 'done' }];
  assert.equal((await child.completeObservedAsync(output)).ok, true);
  return {
    request: { ...binding, history: [...captured, ...output, user('continue')] },
    receipt,
    rootId: root.snapshotId,
    scope: createHash('sha256')
      .update('hpm/recovery-root/v1\0' + root.snapshotId)
      .digest('hex'),
  };
}

for (const mode of [
  { lazy: false, observed: false },
  { lazy: true, observed: false },
  { lazy: false, observed: true },
  { lazy: true, observed: true },
])
  test(
    'warm continuation skips scanning while exact durable accounting and expiry remain: lazy=' +
      mode.lazy +
      ', observed=' +
      mode.observed,
    async (t) => {
      const f = await fixture(t, mode.lazy, mode.observed);
      const seeded = await seedInto(f.sessions);
      const before = await f.storage.execute({ operation: 'load-reference', scope: seeded.scope });
      f.requests.length = 0;
      const session = await f.sessions.beginAsync(seeded.request, [], () => true);
      assert.equal(session.ok, true);
      assert.equal(session.reason, 'observed_continuation');
      assert.equal(
        f.requests.some((request) => request.operation === 'scan-reference'),
        false
      );
      // Existing transaction owners keep their captured method after the tap
      // is removed; real storage/accounting must continue without observation.
      if (mode.observed) f.observer.close();
      const listed = await session.replyAsync(LIST, {});
      assert.equal(listed.ok, true);
      const read = await session.replyAsync(READ, {
        sourceId: seeded.receipt.sourceId,
        digest: seeded.receipt.digest,
      });
      assert.equal(read.ok, true);
      assert.equal(JSON.parse(read.text).page.text, original);
      const after = await f.storage.execute({ operation: 'load-reference', scope: seeded.scope });
      assert.equal(after.expiresAt, before.expiresAt);
      assert.equal(
        after.reference.metadata.budget.calls,
        before.reference.metadata.budget.calls + 2
      );
      const wireBytes = (reply) =>
        Buffer.byteLength(
          JSON.stringify({
            success: reply.ok,
            contentItems: [{ type: 'inputText', text: reply.text }],
          })
        );
      assert.equal(
        after.reference.metadata.budget.returnedBytes,
        before.reference.metadata.budget.returnedBytes + wireBytes(listed) + wireBytes(read)
      );
      assert.ok(f.requests.some((request) => request.operation === 'save-reference-state'));
      assert.ok(f.requests.some((request) => request.operation === 'read-source-and-settle'));
      session.abort();
    }
  );

for (const observed of [false, true])
  test(
    'an external writer invalidates the native certificate and preserves online/offline ambiguity: observed=' +
      observed,
    async (t) => {
      const f = await fixture(t, false, observed);
      const seeded = await seedInto(f.sessions);
      const other = createContextRecoverySessions({ now: () => 100 });
      other.configure(true);
      attachContextRecoveryStorage(other, f.native);
      try {
        await seedInto(other);
      } finally {
        await other.shutdownAsync();
      }
      f.requests.length = 0;
      assert.deepEqual(await f.sessions.beginAsync(seeded.request, [], () => true), {
        ok: false,
        code: 'context_recovery_ambiguous',
      });
      assert.ok(f.requests.some((request) => request.operation === 'scan-reference'));
      assert.equal(f.sessions.inspect().roots, 1);
    }
  );

for (const observed of [false, true])
  test(
    'a warm inventory never bypasses current authorization or authenticating corrupted evidence before disclosure: observed=' +
      observed,
    async (t) => {
      const f = await fixture(t, false, observed);
      const seeded = await seedInto(f.sessions);
      f.requests.length = 0;
      assert.deepEqual(await f.sessions.beginAsync(seeded.request, [], () => false), {
        ok: false,
        code: 'context_recovery_storage_unavailable',
      });
      assert.equal(f.requests.length, 0);
      f.database.prepare('UPDATE recovery_blob SET envelope=zeroblob(length(envelope))').run();
      const session = await f.sessions.beginAsync(seeded.request, [], () => true);
      assert.equal(session.ok, true);
      const read = await session.replyAsync(READ, {
        sourceId: seeded.receipt.sourceId,
        digest: seeded.receipt.digest,
      });
      assert.equal(read.ok, false);
      assert.equal((await session.replyAsync(LIST, {})).ok, false);
      session.abort();
    }
  );

test('failed external writes still invalidate the fence and use the original scan without a write retry', async (t) => {
  const f = await fixture(t);
  const seeded = await seedInto(f.sessions);
  const originalRequest = f.requests.find(
    (request) => request.operation === 'save-reference-state'
  );
  f.requests.length = 0;
  await assert.rejects(f.native.execute(originalRequest), {
    code: 'context_recovery_storage_unavailable',
  });
  const session = await f.sessions.beginAsync(seeded.request, [], () => true);
  assert.equal(session.ok, true);
  assert.ok(f.requests.some((request) => request.operation === 'scan-reference'));
  assert.equal(
    f.requests.filter((request) => request.operation === 'save-reference-state').length,
    1
  );
  session.abort();
});

test('a cold owner still scans and imports only the selected root before warm scans can be removed', async (t) => {
  const f = await fixture(t);
  const seeded = await seedInto(f.sessions);
  const sessions = createContextRecoverySessions({ now: () => 100 });
  t.after(() => sessions.shutdownAsync());
  assert.deepEqual(await initializeContextRecoveryStorage(sessions, f.native), { ok: true });
  sessions.configure(true);
  assert.equal(sessions.inspect().roots, 0);
  f.requests.length = 0;
  const cold = await sessions.beginAsync(seeded.request, [], () => true);
  assert.equal(cold.ok, true);
  assert.ok(f.requests.some((request) => request.operation === 'scan-reference'));
  cold.abort();
  f.requests.length = 0;
  const warm = await sessions.beginAsync(seeded.request, [], () => true);
  assert.equal(warm.ok, true);
  assert.equal(
    f.requests.some((request) => request.operation === 'scan-reference'),
    false
  );
  warm.abort();
});

test('cached root identities never bypass native tombstone authentication or delete a corrupt record', async (t) => {
  const f = await fixture(t);
  const seeded = await seedInto(f.sessions);
  const scope = 'f'.repeat(64);
  // Fault injection outside the tracked API. It cannot create read authority.
  f.engine.execute({ operation: 'save', scope, expectedRevision: 0, expiresAt: 1000, state: {} });
  f.engine.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  f.database
    .prepare('UPDATE recovery_state SET envelope=zeroblob(length(envelope)) WHERE scope=?')
    .run(scope);
  const session = await f.sessions.beginAsync(seeded.request, [], () => true);
  assert.equal(session.ok, true);
  assert.equal((await session.replyAsync(LIST, {})).ok, false);
  assert.equal(
    (
      await session.replyAsync(READ, {
        sourceId: seeded.receipt.sourceId,
        digest: seeded.receipt.digest,
      })
    ).ok,
    false
  );
  const row = f.database
    .prepare('SELECT kind,revision,envelope FROM recovery_state WHERE scope=?')
    .get(scope);
  assert.equal(row.kind, 'revoked');
  assert.equal(row.revision, 2);
  assert.ok(Buffer.from(row.envelope).every((byte) => byte === 0));
  session.abort();
});
