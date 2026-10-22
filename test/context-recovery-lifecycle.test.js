'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
  restoreContextRecoverySessions,
  initializeContextRecoveryStorage,
} = require('../lib/proxy/context-recovery-sessions');
const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
const { discoverRecoveryStorage } = require('../lib/proxy/context-recovery-storage-discovery');
const { createRecoveryStorageStartup } = require('../lib/proxy/context-recovery-storage-startup');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { createProxyShutdown } = require('../lib/proxy/server-shutdown');
const {
  createContextRecoveryStorageOpening,
} = require('../lib/proxy/context-recovery-storage-opening');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const original = '原文\r\nélève🙂';
const unavailable = 'context_recovery_storage_unavailable';
const user = (content) => ({ role: 'user', content });
const answer = [{ role: 'assistant', content: 'done' }];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(worker = null) {
  const database = worker ? null : new DatabaseSync(':memory:');
  const store =
    worker ??
    createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
      now: () => 100,
    });
  const runtime = createContextRecoverySessions({ now: worker ? Date.now : () => 100 });
  const requests = [];
  let hook;
  runtime.configure(true);
  attachContextRecoveryStorage(runtime, {
    execute(request) {
      requests.push(globalThis.structuredClone(request));
      return hook ? hook(request, () => store.execute(request)) : store.execute(request);
    },
  });
  let sequence = 0;
  return {
    runtime,
    store,
    database,
    requests,
    hook(value) {
      hook = value;
    },
    async seed(principal = 'owner') {
      const id = String(++sequence);
      const binding = { principal, protocol: 'chat', target: 'target' };
      const history = [user('question-' + id)];
      const external = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      };
      const root = runtime.begin({ ...binding, history });
      assert.equal(
        (
          await root.completeObservedAsync(
            [external],
            [{ callId: id, toolName: 'lookup', arguments: {}, completed: true, output: '' }]
          )
        ).ok,
        true
      );
      const capturedHistory = [
        ...history,
        external,
        { role: 'tool', tool_call_id: id, content: original },
      ];
      const captured = runtime.begin({ ...binding, history: capturedHistory }, [
        { callId: id, output: original },
      ]);
      assert.equal((await captured.completeObservedAsync(answer)).ok, true);
      const view = runtime.begin({ ...binding, history: [...capturedHistory, ...answer] });
      const scope = requests.find(
        (request) => request.operation === 'save' && request.state.root.rootId === root.snapshotId
      ).scope;
      return {
        root,
        view,
        scope,
        binding,
        history: [...capturedHistory, ...answer],
        initial: { ...binding, history },
      };
    },
    async close() {
      await runtime.shutdownAsync();
      if (!worker) {
        store.close();
        database.close();
      }
    },
  };
}
function hold(f, operation, afterWrite = false, nth = 1) {
  const entered = deferred(),
    release = deferred();
  let matches = 0;
  f.hook((request, next) => {
    if (request.operation === operation && ++matches === nth) {
      const result = afterWrite ? next() : undefined;
      entered.resolve();
      return release.promise.then(() => (afterWrite ? result : next()));
    }
    return next();
  });
  return { entered: entered.promise, release: release.resolve };
}

test('principal revocation atomically removes every enrolled root and leaves other principals usable', async () => {
  const f = fixture();
  try {
    const a = await f.seed(),
      b = await f.seed(),
      c = await f.seed('other'),
      d = await f.seed('other');
    assert.equal((await f.runtime.revokeAsync('owner')).ok, true);
    for (const item of [a, b]) {
      assert.equal(f.store.execute({ operation: 'load', scope: item.scope }), null);
      assert.equal((await item.view.replyAsync(LIST, {})).ok, false);
    }
    for (const item of [c, d]) assert.equal((await item.view.replyAsync(LIST, {})).ok, true);
    assert.equal(f.requests.filter((request) => request.operation === 'revoke-scopes').length, 1);
    assert.equal(
      f.requests.find((request) => request.operation === 'revoke-scopes').entries.length,
      2
    );
    // Revoked roots release active capacity without permitting their reuse.
    await f.seed();
    await f.seed();
    assert.equal(f.store.execute({ operation: 'inspect' }).records, 4);
    assert.equal((await f.runtime.revokeAsync('owner')).ok, true);
    assert.equal(f.store.execute({ operation: 'inspect' }).records, 2);
  } finally {
    await f.close();
  }
});

test('trusted restored roots are enrolled for revocation before their first read or write', async () => {
  const f = fixture();
  let restored;
  try {
    const a = await f.seed();
    const record = f.store.execute({ operation: 'load', scope: a.scope });
    assert.equal((await f.runtime.shutdownAsync()).ok, true);
    restored = restoreContextRecoverySessions({ now: () => 100 }, [
      { binding: a.initial, state: record.state.root },
    ]);
    let calls = 0;
    attachContextRecoveryStorage(restored, {
      execute(request) {
        calls++;
        return f.store.execute(request);
      },
    });
    assert.equal(calls, 0);
    assert.equal((await restored.revokeAsync('owner')).ok, true);
    assert.equal(calls, 1);
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
  } finally {
    await restored?.shutdownAsync();
    await f.close();
  }
});

test('denial-only root registration validates immutable identities, executable data and active capacity', async () => {
  let calls = 0,
    executed = 0;
  const service = createRecoveryRootStorage({
    execute(request) {
      calls++;
      return { revoked: request.entries.length };
    },
  });
  const first = {
    rootId: 'hbs_' + 'a'.repeat(32),
    principal: 'owner',
    createdAt: 100,
    expiresAt: 1000,
  };
  try {
    for (const value of [
      null,
      undefined,
      [],
      {},
      { ...first, extra: true },
      { ...first, rootId: '../escape' },
      { ...first, principal: {} },
      { ...first, createdAt: -1 },
      { ...first, expiresAt: 100 },
      { ...first, expiresAt: Number.MAX_SAFE_INTEGER },
      {
        get rootId() {
          executed++;
          return first.rootId;
        },
      },
    ])
      assert.throws(() => service.registerRoot(value), { code: unavailable });
    service.registerRoot(first);
    service.registerRoot(first);
    assert.throws(() => service.registerRoot({ ...first, principal: 'other' }), {
      code: unavailable,
    });
    for (const letter of ['b', 'c', 'd'])
      service.registerRoot({ ...first, rootId: 'hbs_' + letter.repeat(32) });
    assert.throws(() => service.registerRoot({ ...first, rootId: 'hbs_' + 'e'.repeat(32) }), {
      code: unavailable,
    });
    assert.equal(calls, 0);
    assert.equal(executed, 0);
    assert.equal((await service.revokePrincipal('owner')).ok, true);
    service.registerRoot({ ...first, rootId: 'hbs_' + 'e'.repeat(32) });
    assert.equal(calls, 1);
  } finally {
    service.close();
  }
});

test('disable revokes all disk records including unregistered scopes and can reenable only after ACK', async () => {
  const f = fixture();
  try {
    const a = await f.seed();
    const offline = 'f'.repeat(64);
    f.store.execute({
      operation: 'save',
      scope: offline,
      expectedRevision: 0,
      expiresAt: 1000,
      state: { synthetic: true },
    });
    const blocked = hold(f, 'revoke-all');
    const disabled = f.runtime.configureAsync(false);
    await blocked.entered;
    f.runtime.configure(true);
    assert.equal(f.runtime.begin({ ...a.binding, history: [user('new')] }).ok, false);
    assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
    blocked.release();
    assert.equal((await disabled).ok, true);
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
    assert.equal(f.store.execute({ operation: 'load', scope: offline }), null);
    assert.equal((await f.runtime.configureAsync(true)).ok, true);
    await f.seed();
    assert.equal(f.store.execute({ operation: 'inspect' }).records, 1);
    f.runtime.configure(false);
    f.runtime.configure(false);
    assert.equal((await f.runtime.configureAsync(false)).ok, true);
    assert.equal(f.requests.filter((request) => request.operation === 'revoke-all').length, 2);
  } finally {
    await f.close();
  }
});

test('retaining suspension drains every reader boundary without deletion and principal revocation still wins', async () => {
  for (const operation of ['load', 'save']) {
    for (const action of ['resume', 'revoke', 'shutdown']) {
      const f = fixture();
      let blocked;
      try {
        const a = await f.seed();
        const before = f.store.execute({ operation: 'load', scope: a.scope });
        blocked = hold(f, operation, true);
        const reading = a.view.replyAsync(LIST, {});
        await blocked.entered;
        let finished = false;
        const suspension = f.runtime.suspendAsync().then((reply) => {
          finished = true;
          return reply;
        });
        await flush();
        assert.equal(finished, false);
        assert.equal(f.runtime.inspect().enabled, false);
        assert.equal(f.runtime.begin(a.initial).ok, false);
        let revocation, shutdown;
        if (action === 'revoke') revocation = f.runtime.revokeAsync('owner');
        if (action === 'shutdown') shutdown = f.runtime.shutdownAsync();
        blocked.release();
        assert.equal((await reading).ok, false);
        const suspended = await suspension;
        if (action === 'shutdown') assert.equal(suspended.code, 'context_recovery_disabled');
        else assert.equal(suspended.ok, true);
        if (revocation) {
          assert.equal((await revocation).ok, true);
          assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
        } else {
          if (shutdown) assert.equal((await shutdown).ok, true);
          const retained = f.store.execute({ operation: 'load', scope: a.scope });
          assert.ok(retained);
          assert.equal(retained.expiresAt, before.expiresAt);
          assert.equal(
            f.requests.some((request) => request.operation.startsWith('revoke')),
            false
          );
          if (action === 'resume') {
            assert.equal((await f.runtime.configureAsync(true)).ok, true);
            assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
            const fresh = await f.runtime.beginAsync(
              { ...a.binding, history: a.history },
              [],
              () => true
            );
            assert.equal(fresh.ok, true);
            assert.equal((await fresh.replyAsync(LIST, {})).ok, true);
          }
        }
      } finally {
        blocked?.release();
        await f.close();
      }
    }
  }
});

test('retaining suspension preserves idle denial identities for later explicit principal revocation', async () => {
  const f = fixture();
  try {
    const a = await f.seed();
    assert.deepEqual(await f.runtime.suspendAsync(), { ok: true });
    assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
    assert.deepEqual(await f.runtime.revokeAsync('owner'), { ok: true });
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
    assert.equal(f.requests.filter((request) => request.operation === 'revoke-scopes').length, 1);
  } finally {
    await f.close();
  }
});

test('suspended expiration releases admission quota and revoked identities are never reactivated', async () => {
  let calls = 0;
  const service = createRecoveryRootStorage({
    execute(request) {
      calls++;
      assert.equal(request.operation, 'revoke-scopes');
      return { revoked: request.entries.length };
    },
  });
  try {
    for (let index = 0; index < 4; index++)
      service.registerRoot({
        rootId: 'hbs_' + String(index).repeat(32),
        principal: 'owner',
        createdAt: 100,
        expiresAt: 200,
      });
    assert.deepEqual(await service.suspendAll(), { ok: true });
    service.registerRoot({
      rootId: 'hbs_' + 'a'.repeat(32),
      principal: 'other',
      createdAt: 201,
      expiresAt: 300,
    });
    assert.deepEqual(await service.revokePrincipal('owner'), { ok: true });
    assert.equal(calls, 0);
    assert.deepEqual(await service.revokePrincipal('other'), { ok: true });
    assert.equal(calls, 1);
    assert.deepEqual(await service.suspendAll(), { ok: true });
    assert.deepEqual(await service.revokePrincipal('other'), { ok: true });
    assert.equal(calls, 1);
    service.close();
    assert.deepEqual(await service.suspendAll(), { ok: false, code: unavailable });
  } finally {
    service.close();
  }
  const sessions = createContextRecoverySessions();
  sessions.configure(true);
  await sessions.shutdownAsync();
  assert.deepEqual(await sessions.suspendAsync(), { ok: false, code: 'context_recovery_disabled' });
});

test('suspension during startup defeats earlier enable without deleting enrolled offline records', async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  let owner;
  try {
    const a = await f.seed();
    await f.runtime.shutdownAsync();
    let held = false;
    owner = createContextRecoveryLifecycle({
      sessions: createContextRecoverySessions({ now: () => 100 }),
      storage: {
        async execute(request) {
          if (!held && request.operation === 'catalog') {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return f.store.execute(request);
        },
        close() {},
      },
    });
    await entered.promise;
    const enabling = owner.configureAsync(true);
    const suspended = owner.suspendAsync();
    for (let index = 0; index < 2048; index++) owner.suspend();
    release.resolve();
    assert.equal((await enabling).code, 'context_recovery_disabled');
    assert.deepEqual(await suspended, { ok: true });
    assert.equal(owner.sessions.inspect().enabled, false);
    assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
    assert.deepEqual(await owner.configureAsync(true), { ok: true });
    const fresh = await owner.sessions.beginAsync(
      { ...a.binding, history: a.history },
      [],
      () => true
    );
    assert.equal(fresh.ok, true);
    assert.equal((await fresh.replyAsync(LIST, {})).ok, true);
  } finally {
    release.resolve();
    await owner?.shutdownAsync();
    await f.close();
  }
});

test('unsupported or malformed suspension cannot silently fall back to destructive disable', async () => {
  for (const mode of ['missing', 'throw', 'shape', 'thenable']) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
    });
    const sessions = createContextRecoverySessions();
    let executed = 0;
    const operations = [];
    const actual = sessions.suspendAsync;
    if (mode === 'missing') {
      delete sessions.suspend;
      delete sessions.suspendAsync;
    } else
      sessions.suspendAsync = () => {
        void actual();
        if (mode === 'throw') throw new Error('PRIVATE_SUSPEND_FAILURE');
        if (mode === 'shape') return { ok: true, content: 'PRIVATE_SUSPEND_FAILURE' };
        return {
          get then() {
            executed++;
            throw new Error('PRIVATE_SUSPEND_FAILURE');
          },
        };
      };
    const owner = createContextRecoveryLifecycle({
      sessions,
      storage: {
        execute(request) {
          operations.push(request.operation);
          return engine.execute(request);
        },
        close() {},
      },
    });
    try {
      assert.deepEqual(await owner.configureAsync(true), { ok: true });
      assert.deepEqual(await owner.suspendAsync(), { ok: false, code: unavailable });
      assert.equal(owner.inspect().state, 'failed');
      assert.equal(owner.sessions.inspect().enabled, false);
      assert.equal(
        operations.some((operation) => operation.startsWith('revoke')),
        false
      );
      assert.equal(executed, 0);
      assert.doesNotMatch(JSON.stringify(owner.inspect()), /PRIVATE_SUSPEND_FAILURE/);
    } finally {
      await owner.shutdownAsync();
      engine.close();
      database.close();
    }
  }
});

test('suspension rejects every late publication phase while retaining previously committed evidence', async () => {
  for (const phase of ['prepared', 'sending', 'transport-finished']) {
    const f = fixture();
    const entered = deferred(),
      release = deferred();
    try {
      const a = await f.seed();
      let held = false;
      f.hook((request, next) => {
        if (
          !held &&
          request.operation === 'save' &&
          request.state.publications.some(
            (entry) => entry.snapshotId === a.view.snapshotId && entry.state === phase
          )
        ) {
          held = true;
          const result = next();
          entered.resolve();
          return release.promise.then(() => result);
        }
        return next();
      });
      let pending;
      if (phase === 'prepared') pending = a.view.completeAsync(answer);
      else {
        assert.equal((await a.view.completeAsync(answer)).ok, true);
        if (phase === 'sending') pending = a.view.startPublicationAsync();
        else {
          assert.equal((await a.view.startPublicationAsync()).ok, true);
          pending = a.view.finishPublicationAsync();
        }
      }
      await entered.promise;
      const suspended = f.runtime.suspendAsync();
      release.resolve();
      assert.equal((await pending).ok, false);
      assert.deepEqual(await suspended, { ok: true });
      assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
      assert.equal(
        f.requests.some((request) => request.operation.startsWith('revoke')),
        false
      );
      assert.deepEqual(await f.runtime.configureAsync(true), { ok: true });
      assert.equal((await a.view.finishPublicationAsync()).ok, false);
      const fresh = await f.runtime.beginAsync(
        { ...a.binding, history: a.history },
        [],
        () => true
      );
      assert.equal(fresh.ok, true);
      assert.equal((await fresh.replyAsync(LIST, {})).ok, true);
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

test('revocation waits for every reader storage boundary and rejects all late results', async () => {
  for (const operation of ['load', 'save'])
    for (const afterWrite of [false, true]) {
      for (const nth of operation === 'save' ? [1, 2] : [1]) {
        const f = fixture();
        try {
          const a = await f.seed();
          const blocked = hold(f, operation, afterWrite, nth);
          const read = a.view.replyAsync(LIST, {});
          await blocked.entered;
          let done = false;
          const revoked = f.runtime.revokeAsync('owner').then((result) => {
            done = true;
            return result;
          });
          await flush();
          assert.equal(done, false);
          assert.equal(
            f.requests.some((request) => request.operation === 'revoke-scopes'),
            false
          );
          assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
          blocked.release();
          assert.equal((await read).ok, false);
          assert.equal((await revoked).ok, true);
          assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
          assert.equal(f.store.execute({ operation: 'inspect' }).records, 0);
        } finally {
          await f.close();
        }
      }
    }
});

test('durable close fences pending publication at prepare, sending and finish without resurrecting records', async () => {
  for (const phase of ['prepared', 'sending', 'transport-finished'])
    for (const afterWrite of [false, true]) {
      const f = fixture();
      try {
        const a = await f.seed();
        let held = false;
        const entered = deferred(),
          release = deferred();
        f.hook((request, next) => {
          if (
            !held &&
            request.operation === 'save' &&
            request.state.publications.some(
              (item) => item.snapshotId === a.view.snapshotId && item.state === phase
            )
          ) {
            held = true;
            const result = afterWrite ? next() : undefined;
            entered.resolve();
            return release.promise.then(() => (afterWrite ? result : next()));
          }
          return next();
        });
        let pending;
        if (phase === 'prepared') pending = a.view.completeAsync(answer);
        else {
          assert.equal((await a.view.completeAsync(answer)).ok, true);
          if (phase === 'sending') pending = a.view.startPublicationAsync();
          else {
            assert.equal((await a.view.startPublicationAsync()).ok, true);
            pending = a.view.finishPublicationAsync();
          }
        }
        await entered.promise;
        const closing = f.runtime.closeAsync();
        assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
        release.resolve();
        assert.equal((await pending).ok, false);
        assert.equal((await closing).ok, true);
        assert.equal((await f.runtime.closeAsync()).ok, true);
        assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
        assert.equal(f.requests.filter((request) => request.operation === 'revoke-all').length, 1);
      } finally {
        await f.close();
      }
    }
});

test('unknown write ACK does not prevent terminal revocation and never retries the original operation', async () => {
  const f = fixture();
  try {
    const a = await f.seed();
    let failed = false;
    f.hook((request, next) => {
      const result = next();
      if (!failed && request.operation === 'save') {
        failed = true;
        throw new Error('SECRET');
      }
      return result;
    });
    assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
    const writes = f.requests.filter((request) => request.operation === 'save').length;
    assert.equal((await f.runtime.revokeAsync('owner')).ok, true);
    assert.equal(f.requests.filter((request) => request.operation === 'save').length, writes);
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
  } finally {
    await f.close();
  }
});

test('revocation failure and invalid ACK remain failed, block reenable and never report durable success', async () => {
  for (const mode of ['throw', 'bad', 'thenable', 'post-write']) {
    const f = fixture();
    let executed = 0;
    try {
      const a = await f.seed();
      f.hook((request, next) => {
        if (request.operation !== 'revoke-all') return next();
        if (mode === 'throw') throw new Error('SECRET');
        if (mode === 'post-write') {
          next();
          throw new Error('SECRET');
        }
        if (mode === 'thenable')
          return {
            get then() {
              executed++;
              throw new Error('SECRET');
            },
          };
        return { revoked: -1 };
      });
      assert.deepEqual(await f.runtime.configureAsync(false), { ok: false, code: unavailable });
      assert.equal((await f.runtime.configureAsync(true)).ok, false);
      assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
      assert.equal((await f.runtime.closeAsync()).ok, false);
      assert.equal(f.requests.filter((request) => request.operation === 'revoke-all').length, 1);
      assert.equal(executed, 0);
    } finally {
      await f.close();
    }
  }
});

test('graceful shutdown retains committed bytes and consumed budget while old capabilities remain unusable', async () => {
  const f = fixture();
  try {
    const a = await f.seed();
    const index = JSON.parse((await a.view.replyAsync(LIST, {})).text);
    const page = JSON.parse(
      (
        await a.view.replyAsync(READ, {
          sourceId: index.sources[0].sourceId,
          digest: index.sources[0].digest,
        })
      ).text
    );
    assert.equal(page.page.text, original);
    const before = f.store.execute({ operation: 'load', scope: a.scope });
    assert.equal((await f.runtime.shutdownAsync()).ok, true);
    assert.equal((await a.view.replyAsync(READ, {})).ok, false);
    const after = f.store.execute({ operation: 'load', scope: a.scope });
    assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
    assert.equal(after.state.root.budget.calls, 2);
    assert.equal(
      f.requests.some((request) => request.operation.startsWith('revoke-')),
      false
    );
  } finally {
    await f.close();
  }
});

test('lifecycle rejects illegal principal and policy values without invoking coercion', async () => {
  const f = fixture();
  let executed = 0;
  try {
    for (const value of [
      null,
      undefined,
      [],
      {},
      '',
      '../escape',
      'x'.repeat(257),
      {
        toString() {
          executed++;
          return 'owner';
        },
      },
    ])
      assert.equal((await f.runtime.revokeAsync(value)).ok, false);
    for (const value of [null, {}, 'true', 1])
      await assert.rejects(f.runtime.configureAsync(value), /Invalid recovery session policy/);
    assert.equal(executed, 0);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test('startup discovery enrolls every offline root for principal denial without restoring authority', async () => {
  const f = fixture();
  let service;
  try {
    const a = await f.seed(),
      b = await f.seed('other'),
      c = await f.seed();
    await f.runtime.shutdownAsync();
    const requests = [];
    service = createRecoveryRootStorage({
      execute(request) {
        requests.push(globalThis.structuredClone(request));
        return f.store.execute(request);
      },
    });
    const pending = service.discover();
    assert.equal(service.discover(), pending);
    assert.equal(service.available(), false);
    assert.deepEqual(await pending, { ok: true, roots: 3 });
    assert.equal(service.available(), true);
    assert.deepEqual(
      requests.map((request) => request.operation),
      ['catalog', 'load', 'load', 'load', 'catalog']
    );
    assert.equal(f.runtime.inspect().roots, 0);
    assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
    assert.equal((await service.revokePrincipal('owner')).ok, true);
    for (const item of [a, c])
      assert.equal(f.store.execute({ operation: 'load', scope: item.scope }), null);
    assert.ok(f.store.execute({ operation: 'load', scope: b.scope }));
    const metadata = await discoverRecoveryStorage(f.store);
    assert.deepEqual(Object.keys(metadata[0]).sort(), [
      'createdAt',
      'expiresAt',
      'principal',
      'rootId',
    ]);
    assert.equal(metadata[0].principal, 'other');
    assert.equal(JSON.stringify(metadata).includes(original), false);
  } finally {
    service?.close();
    await f.close();
  }
});

test('startup discovery handles empty stores and keeps admission fenced until a complete scan', async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const service = createRecoveryRootStorage({
    async execute(request) {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return f.store.execute(request);
    },
  });
  try {
    const pending = service.discover();
    await entered.promise;
    assert.equal(service.available(), false);
    assert.equal((await service.revokePrincipal('owner')).ok, false);
    assert.equal((await service.revokeAll()).ok, false);
    assert.throws(() => service.registerRoot({}), { code: unavailable });
    await assert.rejects(service.begin({}), { code: unavailable });
    release.resolve();
    assert.deepEqual(await pending, { ok: true, roots: 0 });
    assert.equal(service.available(), true);
    assert.equal(calls, 2);
  } finally {
    release.resolve();
    service.close();
    await f.close();
  }
});

async function stagedFixture(f) {
  const a = await f.seed();
  const call = {
    callId: 'pending-call',
    toolName: 'lookup',
    arguments: {},
    completed: true,
    output: '',
  };
  const external = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: call.callId, type: 'function', function: { name: call.toolName, arguments: '{}' } },
    ],
  };
  assert.equal((await a.view.completeObservedAsync([external], [call])).ok, true);
  const pending = f.runtime.begin(
    {
      ...a.binding,
      history: [
        ...a.history,
        external,
        { role: 'tool', tool_call_id: call.callId, content: 'unpublished synthetic🙂' },
      ],
    },
    [{ callId: call.callId, output: 'unpublished synthetic🙂' }]
  );
  assert.equal((await pending.replyAsync(LIST, {})).ok, true);
  const record = await f.store.execute({ operation: 'load', scope: a.scope });
  assert.equal(record.state.stagedSources.length, 1);
  assert.equal(record.state.root.ledger.sources.length, 1);
  return { ...a, pending, record };
}

test('startup discards authenticated orphan staging while preserving published state and every counter', async () => {
  const f = fixture();
  let service;
  try {
    const a = await stagedFixture(f);
    await f.runtime.shutdownAsync();
    const requests = [];
    service = createRecoveryRootStorage({
      execute(request) {
        requests.push(request.operation);
        return f.store.execute(request);
      },
    });
    assert.deepEqual(await service.discover(), { ok: true, roots: 1 });
    const after = f.store.execute({ operation: 'load', scope: a.scope });
    assert.deepEqual(after.state.stagedSources, []);
    assert.deepEqual(after.state.root, a.record.state.root);
    assert.deepEqual(after.state.publications, a.record.state.publications);
    assert.equal(after.revision, a.record.revision + 1);
    assert.equal(after.createdAt, a.record.createdAt);
    assert.equal(after.expiresAt, a.record.expiresAt);
    assert.deepEqual(requests, ['catalog', 'load', 'catalog', 'save', 'load', 'catalog']);
    assert.equal((await a.pending.replyAsync(LIST, {})).ok, false);
    assert.equal(f.runtime.inspect().roots, 0);
    service.close();
    const again = createRecoveryRootStorage(f.store);
    try {
      assert.deepEqual(await again.discover(), { ok: true, roots: 1 });
      assert.equal(f.store.execute({ operation: 'load', scope: a.scope }).revision, after.revision);
    } finally {
      again.close();
    }
  } finally {
    service?.close();
    await f.close();
  }
});

test('staging cleanup failures and concurrent changes fence admission without retrying or refunding state', async () => {
  for (const mode of [
    'write-failure',
    'bad-ack',
    'executable-ack',
    'missing-readback',
    'changed-readback',
    'catalog-generation',
    'cas-race',
    'close-before-write',
    'close-after-write',
  ]) {
    const f = fixture();
    let service;
    try {
      const a = await stagedFixture(f);
      await f.runtime.shutdownAsync();
      let writes = 0,
        loads = 0,
        catalogs = 0,
        executed = 0;
      service = createRecoveryRootStorage({
        execute(request) {
          if (request.operation === 'catalog') {
            catalogs++;
            if (mode === 'close-before-write' && catalogs === 2) service.close();
            if (mode === 'catalog-generation' && catalogs === 3) {
              const record = f.store.execute({ operation: 'load', scope: a.scope });
              f.store.execute({
                operation: 'save',
                scope: a.scope,
                expectedRevision: record.revision,
                expiresAt: record.expiresAt,
                state: record.state,
              });
            }
          }
          if (request.operation === 'load' && ++loads === 2) {
            if (mode === 'missing-readback') return null;
            if (mode === 'changed-readback') {
              const record = f.store.execute(request);
              record.state.root.budget.calls++;
              record.state = createRootCheckpoint(record.state.root, [], record.state.publications);
              return record;
            }
          }
          if (request.operation === 'save') {
            writes++;
            if (mode === 'write-failure') throw new Error('synthetic-secret');
            if (mode === 'cas-race') {
              const record = f.store.execute({ operation: 'load', scope: a.scope });
              f.store.execute({ ...request, state: record.state });
            }
            const result = f.store.execute(request);
            if (mode === 'bad-ack') return { revision: result.revision + 1 };
            if (mode === 'executable-ack')
              return {
                get revision() {
                  executed++;
                  return result.revision;
                },
              };
            if (mode === 'close-after-write') service.close();
            return result;
          }
          return f.store.execute(request);
        },
      });
      await assert.rejects(service.discover(), { code: unavailable, message: unavailable });
      assert.equal(service.available(), false);
      assert.equal((await service.drain()).ok, false);
      assert.throws(() => service.registerRoot({}), { code: unavailable });
      assert.equal(writes, mode === 'close-before-write' ? 0 : 1);
      assert.equal(executed, 0);
      const after = f.store.execute({ operation: 'load', scope: a.scope });
      assert.deepEqual(after.state.root, a.record.state.root);
      assert.deepEqual(after.state.publications, a.record.state.publications);
      assert.equal(after.createdAt, a.record.createdAt);
      assert.equal(after.expiresAt, a.record.expiresAt);
      assert.equal(
        after.state.stagedSources.length,
        ['write-failure', 'cas-race', 'close-before-write'].includes(mode) ? 1 : 0
      );
    } finally {
      service?.close();
      await f.close();
    }
  }
});

test('staging cleanup validates every root and every staged byte before writing any record', async () => {
  for (const mode of ['staged-corruption', 'later-root-corruption']) {
    const f = fixture();
    let service;
    try {
      const a = await stagedFixture(f);
      const b = mode === 'later-root-corruption' ? await f.seed('other') : a;
      await f.runtime.shutdownAsync();
      const before = f.store.execute({ operation: 'load', scope: a.scope });
      let writes = 0;
      service = createRecoveryRootStorage({
        execute(request) {
          if (request.operation === 'save') writes++;
          const result = f.store.execute(request);
          if (request.operation === 'load' && request.scope === b.scope) {
            if (mode === 'staged-corruption') {
              result.state.stagedSources[0].output = 'corrupted synthetic';
              result.state = createRootCheckpoint(
                result.state.root,
                result.state.stagedSources,
                result.state.publications
              );
            } else result.state.digest = '0'.repeat(64);
          }
          return result;
        },
      });
      await assert.rejects(service.discover(), { code: unavailable });
      assert.equal(writes, 0);
      assert.deepEqual(f.store.execute({ operation: 'load', scope: a.scope }), before);
    } finally {
      service?.close();
      await f.close();
    }
  }
});

test('discovery lifetime guard rejects invalid and asynchronous results without executing data hooks', async () => {
  let calls = 0,
    executed = 0;
  const store = {
    execute() {
      calls++;
      return [];
    },
  };
  for (const guard of [
    null,
    () => false,
    () => {
      throw new Error('synthetic-secret');
    },
    () => Promise.resolve(true),
    () => Promise.reject(new Error('synthetic-secret')),
    () => ({
      then() {
        executed++;
      },
    }),
  ]) {
    await assert.rejects(discoverRecoveryStorage(store, guard), {
      code: unavailable,
      message: unavailable,
    });
  }
  assert.equal(calls, 0);
  assert.equal(executed, 0);
});

test('staging cleanup refuses revision overflow before any write', async () => {
  const f = fixture();
  let service;
  try {
    const a = await stagedFixture(f);
    await f.runtime.shutdownAsync();
    let writes = 0;
    service = createRecoveryRootStorage({
      execute(request) {
        if (request.operation === 'save') writes++;
        const result = f.store.execute(request);
        if (request.operation === 'catalog')
          return result.map((entry) => ({ ...entry, revision: Number.MAX_SAFE_INTEGER }));
        if (request.operation === 'load') result.revision = Number.MAX_SAFE_INTEGER;
        return result;
      },
    });
    await assert.rejects(service.discover(), { code: unavailable });
    assert.equal(writes, 0);
    assert.deepEqual(f.store.execute({ operation: 'load', scope: a.scope }), a.record);
  } finally {
    service?.close();
    await f.close();
  }
});

test('a failed multi-root cleanup admits nothing and a fresh owner cleans only the remaining orphan data', async () => {
  const f = fixture();
  let service, fresh;
  try {
    const roots = [await stagedFixture(f), await stagedFixture(f)];
    await f.runtime.shutdownAsync();
    let writes = 0;
    service = createRecoveryRootStorage({
      execute(request) {
        if (request.operation === 'save' && ++writes === 2) throw new Error('synthetic-secret');
        return f.store.execute(request);
      },
    });
    await assert.rejects(service.discover(), { code: unavailable });
    assert.equal(service.available(), false);
    assert.equal(writes, 2);
    const prior = roots.map((a) => f.store.execute({ operation: 'load', scope: a.scope }));
    assert.deepEqual(prior.map((record) => record.state.stagedSources.length).sort(), [0, 1]);
    fresh = createRecoveryRootStorage(f.store);
    assert.deepEqual(await fresh.discover(), { ok: true, roots: 2 });
    for (let index = 0; index < roots.length; index++) {
      const a = roots[index];
      const after = f.store.execute({ operation: 'load', scope: a.scope });
      assert.deepEqual(after.state.stagedSources, []);
      assert.equal(after.revision, a.record.revision + 1);
      assert.deepEqual(after.state.root, a.record.state.root);
      assert.deepEqual(after.state.publications, a.record.state.publications);
      assert.equal(after.createdAt, a.record.createdAt);
      assert.equal(after.expiresAt, a.record.expiresAt);
    }
  } finally {
    service?.close();
    fresh?.close();
    await f.close();
  }
});

test(
  'actual encrypted worker startup removes orphan staging and retains committed evidence across reopening',
  { timeout: 30000 },
  async (t) => {
    const started = performance.now();
    const timeline = [];
    const loop = monitorEventLoopDelay({ resolution: 20 });
    const phases = new Set([
      'worker_started',
      'paths_ready',
      'ownership_acquired',
      'key_protect_started',
      'key_protect_finished',
      'key_unprotect_started',
      'key_unprotect_finished',
      'database_opened',
      'engine_ready',
      'ready',
      'failed',
    ]);
    const mark = (phase) => {
      if (timeline.length < 64)
        timeline.push({ phase, elapsedMs: Math.floor(performance.now() - started) });
    };
    let attempt = 0;
    const open = (directory) => {
      const current = ++attempt;
      mark('open_' + current + '_started');
      return openContextRecoveryStorage({
        directory,
        onStartup({ phase }) {
          if (phases.has(phase)) mark('open_' + current + '_' + phase);
        },
      });
    };
    loop.enable();
    t.after(() => {
      loop.disable();
      t.diagnostic(
        JSON.stringify({ startup: timeline, eventLoopMaxMs: Math.floor(loop.max / 1e6) })
      );
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-staging-worker-'));
    let storage, f, restored;
    try {
      const dataDirectory = path.join(directory, 'store');
      storage = await open(dataDirectory);
      f = fixture(storage);
      const a = await stagedFixture(f);
      mark('staging_finished');
      await f.runtime.shutdownAsync();
      mark('first_shutdown_finished');
      await storage.close();
      mark('first_close_finished');
      storage = await open(dataDirectory);
      assert.equal(
        (await storage.execute({ operation: 'load', scope: a.scope })).state.stagedSources.length,
        1
      );
      restored = createContextRecoverySessions();
      assert.deepEqual(await initializeContextRecoveryStorage(restored, storage), { ok: true });
      mark('cleanup_initialized');
      assert.equal(restored.inspect().roots, 0);
      assert.equal(restored.inspect().enabled, false);
      const after = await storage.execute({ operation: 'load', scope: a.scope });
      assert.deepEqual(after.state.stagedSources, []);
      assert.deepEqual(after.state.root, a.record.state.root);
      assert.deepEqual(after.state.publications, a.record.state.publications);
      assert.equal(after.revision, a.record.revision + 1);
      assert.equal(after.createdAt, a.record.createdAt);
      assert.equal(after.expiresAt, a.record.expiresAt);
      await restored.shutdownAsync();
      mark('second_shutdown_finished');
      await storage.close();
      mark('second_close_finished');
      storage = await open(dataDirectory);
      const reopened = await storage.execute({ operation: 'load', scope: a.scope });
      assert.deepEqual(reopened, after);
      mark('reopen_verified');
    } finally {
      mark('final_cleanup_started');
      await restored?.shutdownAsync();
      await f?.runtime.shutdownAsync();
      await storage?.close();
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('hpm-staging-worker-'));
      fs.rmSync(directory, { recursive: true, force: true });
      mark('final_cleanup_finished');
    }
  }
);

test('startup discovery rejects changed generations, invalid roots and read failures atomically', async () => {
  for (const mode of [
    'load-failure',
    'missing',
    'revision',
    'scope',
    'digest',
    'generation',
    'catalog',
  ]) {
    const f = fixture();
    let service;
    try {
      const a = await f.seed(),
        b = await f.seed('other');
      await f.runtime.shutdownAsync();
      let scans = 0,
        loads = 0,
        writes = 0;
      service = createRecoveryRootStorage({
        execute(request) {
          if (request.operation === 'catalog') {
            scans++;
            if (mode === 'catalog') return [{ scope: a.scope, state: original }];
            if (mode === 'generation' && scans === 2) {
              const current = f.store.execute({ operation: 'load', scope: a.scope });
              f.store.execute({
                operation: 'save',
                scope: a.scope,
                expectedRevision: current.revision,
                expiresAt: current.expiresAt,
                state: current.state,
              });
            }
          }
          if (request.operation === 'load' && ++loads === 2) {
            if (mode === 'load-failure') throw new Error('secret-value');
            if (mode === 'missing') return null;
            const record = globalThis.structuredClone(f.store.execute(request));
            if (mode === 'revision') record.revision++;
            if (mode === 'scope') record.state.root.rootId = 'hbs_' + 'f'.repeat(32);
            if (mode === 'digest') record.state.digest = '0'.repeat(64);
            return record;
          }
          if (request.operation.startsWith('revoke')) writes++;
          return f.store.execute(request);
        },
      });
      await assert.rejects(service.discover(), { code: unavailable, message: unavailable });
      assert.equal(service.available(), false);
      assert.equal((await service.drain()).ok, false);
      assert.equal((await service.revokePrincipal('owner')).ok, false);
      assert.throws(() => service.registerRoot({}), { code: unavailable });
      assert.equal(writes, 0);
      assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
      assert.ok(f.store.execute({ operation: 'load', scope: b.scope }));
    } finally {
      service?.close();
      await f.close();
    }
  }
});

test('startup discovery refuses executable backends and close during scanning cannot revive admission', async () => {
  let executed = 0;
  await assert.rejects(
    discoverRecoveryStorage({
      get execute() {
        executed++;
        return () => [];
      },
    }),
    { code: unavailable }
  );
  await assert.rejects(
    discoverRecoveryStorage({
      execute() {
        return {
          then() {
            executed++;
          },
        };
      },
    }),
    { code: unavailable }
  );
  assert.equal(executed, 0);
  const entered = deferred(),
    release = deferred();
  const service = createRecoveryRootStorage({
    async execute() {
      entered.resolve();
      await release.promise;
      return [];
    },
  });
  const pending = service.discover();
  const rejected = assert.rejects(pending, { code: unavailable });
  await entered.promise;
  assert.equal((await service.closeAsync()).ok, false);
  release.resolve();
  await rejected;
  assert.equal(service.available(), false);
  assert.equal((await service.drain()).ok, false);
});

test('fresh session initialization enrolls offline denial identities but grants no stored read capabilities', async () => {
  const f = fixture();
  let runtime;
  try {
    const a = await f.seed(),
      b = await f.seed('other');
    await f.runtime.shutdownAsync();
    runtime = createContextRecoverySessions({ now: () => 100 });
    assert.deepEqual(await initializeContextRecoveryStorage(runtime, f.store), { ok: true });
    assert.equal(runtime.inspect().enabled, false);
    assert.equal(runtime.inspect().roots, 0);
    assert.equal((await runtime.revokeAsync('owner')).ok, true);
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
    assert.ok(f.store.execute({ operation: 'load', scope: b.scope }));
    assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
    assert.equal((await runtime.configureAsync(true)).ok, true);
    const fresh = runtime.begin({
      principal: 'other',
      protocol: 'chat',
      target: 'target',
      history: [user('new question')],
    });
    assert.equal(fresh.ok, true);
    const external = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'fresh-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    };
    assert.equal(
      (
        await fresh.completeObservedAsync(
          [external],
          [{ callId: 'fresh-call', toolName: 'lookup', arguments: {}, completed: true, output: '' }]
        )
      ).ok,
      true
    );
    const next = runtime.begin({
      principal: 'other',
      protocol: 'chat',
      target: 'target',
      history: [user('new question'), external],
    });
    const page = await next.replyAsync(LIST, {});
    assert.equal(page.ok, true);
    assert.deepEqual(JSON.parse(page.text).sources, []);
    assert.equal((await next.completeObservedAsync(answer)).ok, true);
  } finally {
    await runtime?.shutdownAsync();
    await f.close();
  }
});

test('initialization fences synchronous enable and duplicate attachment until scan completion', async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  const runtime = createContextRecoverySessions({ now: () => 100 });
  let calls = 0;
  try {
    const pending = initializeContextRecoveryStorage(runtime, {
      async execute(request) {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return f.store.execute(request);
      },
    });
    await entered.promise;
    runtime.configure(true);
    assert.equal(runtime.inspect().enabled, false);
    assert.equal(runtime.begin({}).ok, false);
    await assert.rejects(initializeContextRecoveryStorage(runtime, f.store), { code: unavailable });
    assert.throws(() => attachContextRecoveryStorage(runtime, f.store), { code: unavailable });
    const enabling = runtime.configureAsync(true);
    release.resolve();
    assert.deepEqual(await pending, { ok: true });
    assert.equal((await enabling).ok, true);
    assert.equal(runtime.inspect().enabled, true);
    assert.equal(calls, 2);
  } finally {
    release.resolve();
    await runtime.shutdownAsync();
    await f.close();
  }
});

test('startup lifecycle requests wait at every scan boundary and preserve principal and shutdown semantics', async () => {
  for (const phase of ['first-catalog', 'load', 'final-catalog']) {
    for (const mode of ['disable', 'revoke', 'close', 'shutdown']) {
      const f = fixture();
      const entered = deferred(),
        release = deferred();
      let runtime;
      try {
        const a = await f.seed(),
          b = await f.seed('other');
        await f.runtime.shutdownAsync();
        runtime = createContextRecoverySessions({ now: () => 100 });
        let catalogs = 0,
          held = false;
        const initialization = initializeContextRecoveryStorage(runtime, {
          async execute(request) {
            if (request.operation === 'catalog') catalogs++;
            if (
              !held &&
              ((phase === 'first-catalog' && request.operation === 'catalog' && catalogs === 1) ||
                (phase === 'load' && request.operation === 'load') ||
                (phase === 'final-catalog' && request.operation === 'catalog' && catalogs === 2))
            ) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return f.store.execute(request);
          },
        }).then(
          () => true,
          (error) => {
            assert.equal(error.code, unavailable);
            return false;
          }
        );
        await entered.promise;
        const operation =
          mode === 'disable'
            ? runtime.configureAsync(false)
            : mode === 'revoke'
              ? runtime.revokeAsync('owner')
              : mode === 'close'
                ? runtime.closeAsync()
                : runtime.shutdownAsync();
        let complete = false;
        void operation.then(() => {
          complete = true;
        });
        await flush();
        assert.equal(complete, false);
        assert.equal(runtime.inspect().enabled, false);
        release.resolve();
        assert.equal((await operation).ok, true);
        assert.equal(await initialization, mode === 'disable' || mode === 'revoke');
        for (const item of [a, b]) {
          const expected = mode === 'shutdown' || (mode === 'revoke' && item === b);
          assert.equal(
            f.store.execute({ operation: 'load', scope: item.scope }) !== null,
            expected
          );
        }
        if (mode === 'disable') {
          assert.equal((await runtime.configureAsync(true)).ok, true);
          assert.equal(runtime.inspect().enabled, true);
        }
      } finally {
        release.resolve();
        await runtime?.shutdownAsync();
        await f.close();
      }
    }
  }
});

test('a newer disable defeats an older async enable while startup and durable revoke ACKs are pending', async () => {
  const f = fixture();
  let runtime;
  const scanEntered = deferred(),
    scanRelease = deferred(),
    revokeEntered = deferred(),
    revokeRelease = deferred();
  try {
    await f.seed();
    await f.runtime.shutdownAsync();
    runtime = createContextRecoverySessions({ now: () => 100 });
    let scanned = false;
    const initialization = initializeContextRecoveryStorage(runtime, {
      async execute(request) {
        if (request.operation === 'catalog' && !scanned) {
          scanned = true;
          scanEntered.resolve();
          await scanRelease.promise;
        }
        if (request.operation === 'revoke-all') {
          revokeEntered.resolve();
          await revokeRelease.promise;
        }
        return f.store.execute(request);
      },
    });
    await scanEntered.promise;
    const enabling = runtime.configureAsync(true);
    const disabling = runtime.configureAsync(false);
    scanRelease.resolve();
    await revokeEntered.promise;
    assert.equal(runtime.inspect().enabled, false);
    let installed = false;
    void initialization.then(() => {
      installed = true;
    });
    await flush();
    assert.equal(installed, false);
    revokeRelease.resolve();
    assert.equal((await enabling).code, 'context_recovery_disabled');
    assert.equal((await disabling).ok, true);
    await initialization;
    assert.equal(runtime.inspect().enabled, false);
    assert.equal((await runtime.configureAsync(true)).ok, true);
  } finally {
    scanRelease.resolve();
    revokeRelease.resolve();
    await runtime?.shutdownAsync();
    await f.close();
  }
});

test('async enable outside startup also cannot overtake a newer disable', async () => {
  const f = fixture();
  try {
    await f.seed();
    const pending = hold(f, 'revoke-all');
    const firstDisable = f.runtime.configureAsync(false);
    await pending.entered;
    const enabling = f.runtime.configureAsync(true);
    const newerDisable = f.runtime.configureAsync(false);
    pending.release();
    assert.equal((await firstDisable).ok, true);
    assert.equal((await newerDisable).ok, true);
    assert.equal((await enabling).code, 'context_recovery_disabled');
    assert.equal(f.runtime.inspect().enabled, false);
  } finally {
    await f.close();
  }
});

test('startup failures and invalid queued revocation ACKs remain terminal without fallback or retry', async () => {
  for (const mode of ['catalog', 'load', 'revoke', 'thenable']) {
    const f = fixture();
    let runtime;
    const entered = deferred(),
      release = deferred();
    let executed = 0;
    try {
      const a = await f.seed();
      await f.runtime.shutdownAsync();
      runtime = createContextRecoverySessions({ now: () => 100 });
      let first = true,
        revokes = 0;
      function respond(request) {
        if (mode === 'catalog' && request.operation === 'catalog') return null;
        if (mode === 'load' && request.operation === 'load') throw new Error('secret-value');
        if (request.operation === 'revoke-scopes') {
          revokes++;
          return mode === 'thenable'
            ? {
                then() {
                  executed++;
                },
              }
            : { revoked: 0 };
        }
        return f.store.execute(request);
      }
      const initialization = assert.rejects(
        initializeContextRecoveryStorage(runtime, {
          execute(request) {
            if (first) {
              first = false;
              entered.resolve();
              return release.promise.then(() => respond(request));
            }
            return respond(request);
          },
        }),
        { code: unavailable, message: unavailable }
      );
      await entered.promise;
      const revoked = runtime.revokeAsync('owner');
      release.resolve();
      await initialization;
      assert.equal((await revoked).ok, false);
      assert.equal(runtime.inspect().closed, true);
      runtime.configure(true);
      assert.equal(runtime.inspect().enabled, false);
      assert.equal(runtime.begin({}).ok, false);
      assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
      assert.equal(executed, 0);
      assert.equal(revokes, ['revoke', 'thenable'].includes(mode) ? 1 : 0);
    } finally {
      release.resolve();
      await runtime?.shutdownAsync();
      await f.close();
    }
  }
});

test('startup barriers reject invalid discovery data, run cleanup after failure and never assimilate thenables', async () => {
  let executed = 0;
  for (const reply of [
    null,
    {},
    { ok: true, roots: 5 },
    { ok: true, roots: 0, extra: true },
    {
      get ok() {
        executed++;
        return true;
      },
      roots: 0,
    },
    {
      then() {
        executed++;
      },
    },
  ]) {
    const barrier = createRecoveryStorageStartup({ discover: () => reply });
    let cleaned = false,
      installed = false;
    const cleanup = barrier.enqueue(() => {
      cleaned = true;
      return { ok: true };
    });
    await assert.rejects(
      barrier.complete(() => {
        installed = true;
        return true;
      }),
      { code: unavailable }
    );
    await cleanup;
    assert.equal(cleaned, true);
    assert.equal(installed, false);
    assert.equal((await barrier.drain()).ok, false);
  }
  assert.equal(executed, 0);
});

test('initialization rejects active or unknown sessions and close after graceful shutdown still revokes disk', async () => {
  const f = fixture();
  let runtime;
  let calls = 0;
  try {
    await assert.rejects(initializeContextRecoveryStorage({}, f.store), { code: unavailable });
    const active = createContextRecoverySessions({ now: () => 100 });
    active.configure(true);
    await assert.rejects(
      initializeContextRecoveryStorage(active, {
        execute() {
          calls++;
        },
      }),
      { code: unavailable }
    );
    assert.equal(calls, 0);
    assert.equal(active.inspect().enabled, true);
    await active.shutdownAsync();
    const a = await f.seed();
    await f.runtime.shutdownAsync();
    runtime = createContextRecoverySessions({ now: () => 100 });
    await initializeContextRecoveryStorage(runtime, f.store);
    assert.equal((await runtime.shutdownAsync()).ok, true);
    assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
    assert.equal((await runtime.closeAsync()).ok, true);
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
  } finally {
    await runtime?.shutdownAsync();
    await f.close();
  }
});

test('clock failure at startup installation closes the session and durably revokes without enabling', async () => {
  const f = fixture();
  let runtime;
  try {
    const a = await f.seed();
    await f.runtime.shutdownAsync();
    runtime = createContextRecoverySessions({
      now() {
        throw new Error('secret-value');
      },
    });
    await assert.rejects(initializeContextRecoveryStorage(runtime, f.store), {
      code: unavailable,
      message: unavailable,
    });
    assert.equal(runtime.inspect().enabled, false);
    assert.equal(runtime.inspect().closed, true);
    assert.equal((await runtime.closeAsync()).ok, true);
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
  } finally {
    await runtime?.shutdownAsync();
    await f.close();
  }
});

test('lifecycle policy owner applies memory settings once per change and closes admission immediately', async () => {
  const sessions = createContextRecoverySessions();
  const changes = [];
  const originalConfigure = sessions.configure;
  sessions.configure = (value) => {
    changes.push(value);
    originalConfigure(value);
  };
  const owner = createContextRecoveryLifecycle({ sessions });
  for (let index = 0; index < 2048; index++) owner.configure(false);
  assert.deepEqual(changes, [false]);
  assert.deepEqual(await owner.configureAsync(true), { ok: true });
  for (let index = 0; index < 2048; index++) owner.configure(true);
  assert.equal(sessions.inspect().enabled, true);
  assert.deepEqual(changes, [false, true]);
  const earlier = owner.configureAsync(true);
  assert.deepEqual(await owner.configureAsync(false), { ok: true });
  assert.equal((await earlier).code, 'context_recovery_disabled');
  assert.equal(sessions.inspect().enabled, false);
  for (const value of [undefined, null, '', 0, {}, true.toString()])
    assert.throws(() => owner.configure(value), /Invalid recovery lifecycle policy/);
  const shutdown = owner.shutdownAsync();
  assert.equal(owner.shutdownAsync(), shutdown);
  assert.equal(sessions.inspect().closed, true);
  assert.deepEqual(await shutdown, { ok: true });
  assert.equal((await owner.configureAsync(true)).ok, false);
  assert.equal(owner.inspect().state, 'closed');
});

test('lifecycle readiness refuses an externally closed session and drains a throwing memory policy', async () => {
  for (const requested of [null, false, true]) {
    const sessions = createContextRecoverySessions();
    const owner = createContextRecoveryLifecycle({ sessions });
    if (requested !== null) await owner.configureAsync(requested);
    await sessions.shutdownAsync();
    assert.equal((await owner.ready()).code, 'context_recovery_disabled');
    assert.equal(owner.inspect().state, 'unavailable');
    assert.deepEqual(await owner.shutdownAsync(), { ok: true });
  }
  const sessions = createContextRecoverySessions();
  sessions.configure = () => {
    throw new Error(original);
  };
  const owner = createContextRecoveryLifecycle({ sessions });
  assert.equal((await owner.configureAsync(true)).code, unavailable);
  assert.equal(sessions.inspect().closed, true);
  assert.equal(owner.inspect().state, 'failed');
  assert.equal((await owner.shutdownAsync()).code, unavailable);
  assert.equal(JSON.stringify(owner.inspect()).includes(original), false);
});

test('lifecycle constructor rejects unknown, active and executable composition inputs', async () => {
  let executed = 0;
  const active = createContextRecoverySessions();
  active.configure(true);
  for (const options of [
    null,
    [],
    new Date(),
    1,
    { sessions: null },
    { extra: true },
    {
      get sessions() {
        executed++;
        return active;
      },
    },
    {
      sessions: {
        get configure() {
          executed++;
          return () => {};
        },
      },
    },
    {
      storage: {
        execute() {},
        get close() {
          executed++;
          return () => {};
        },
      },
    },
    { sessions: active, storage: { execute() {}, close() {} } },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('secret-value');
        },
      }
    ),
  ])
    assert.throws(() => createContextRecoveryLifecycle(options), { code: unavailable });
  assert.equal(executed, 0);
  await active.shutdownAsync();
});

test('lifecycle directory validation rejects conflicts, active sessions and getters before opening files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lifecycle-'));
  const storePath = path.join(directory, 'store');
  const active = createContextRecoverySessions();
  active.configure(true);
  let executed = 0;
  try {
    for (const options of [
      { directory: null },
      { directory: '' },
      { directory: 'relative' },
      { directory: storePath, storage: { execute() {}, close() {} } },
      { directory: storePath, sessions: active },
      {
        get directory() {
          executed++;
          return storePath;
        },
      },
    ])
      assert.throws(() => createContextRecoveryLifecycle(options), { code: unavailable });
    assert.equal(executed, 0);
    assert.equal(fs.existsSync(storePath), false);
  } finally {
    await active.shutdownAsync();
    removeDirectory(directory);
  }
});

function lifecycleFixture(
  f,
  { execute, close, sessions = createContextRecoverySessions({ now: () => 100 }) } = {}
) {
  const requests = [];
  let closes = 0;
  const owner = createContextRecoveryLifecycle({
    sessions,
    storage: {
      execute(request) {
        requests.push(globalThis.structuredClone(request));
        const next = () => f.store.execute(request);
        return execute ? execute(request, next) : next();
      },
      close() {
        closes++;
        return close?.();
      },
    },
  });
  return { owner, sessions, requests, closes: () => closes };
}

test('lifecycle discovery coalesces repeated disabled settings and an old enable cannot overtake disable', async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  let catalog = 0;
  const owned = lifecycleFixture(f, {
    execute(request, next) {
      if (request.operation === 'catalog' && ++catalog === 1) {
        entered.resolve();
        return release.promise.then(next);
      }
      return next();
    },
  });
  try {
    await entered.promise;
    assert.equal(owned.owner.inspect().state, 'initializing');
    const enable = owned.owner.configureAsync(true);
    const disable = owned.owner.configureAsync(false);
    for (let index = 0; index < 2048; index++) owned.owner.configure(false);
    assert.equal(owned.sessions.inspect().enabled, false);
    let settled = false;
    void disable.then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    release.resolve();
    assert.deepEqual(await disable, { ok: true });
    assert.equal((await enable).code, 'context_recovery_disabled');
    assert.equal(owned.requests.filter((request) => request.operation === 'revoke-all').length, 1);
    assert.deepEqual(await owned.owner.configureAsync(true), { ok: true });
    assert.equal(owned.sessions.inspect().enabled, true);
    assert.equal(owned.sessions.inspect().roots, 0);
  } finally {
    release.resolve();
    await owned.owner.shutdownAsync();
    await f.close();
  }
});

test('lifecycle normal shutdown during discovery waits for it and retains offline records without importing authority', async () => {
  const f = fixture();
  let owned;
  const entered = deferred(),
    release = deferred();
  try {
    const a = await f.seed();
    await f.runtime.shutdownAsync();
    let catalog = 0;
    owned = lifecycleFixture(f, {
      execute(request, next) {
        if (request.operation === 'catalog' && ++catalog === 1) {
          entered.resolve();
          return release.promise.then(next);
        }
        return next();
      },
    });
    await entered.promise;
    const enabling = owned.owner.configureAsync(true);
    const shutdown = owned.owner.shutdownAsync();
    assert.equal(owned.sessions.inspect().closed, true);
    assert.equal(owned.closes(), 0);
    release.resolve();
    assert.deepEqual(await shutdown, { ok: true });
    assert.equal((await enabling).code, 'context_recovery_disabled');
    assert.equal(owned.closes(), 1);
    assert.equal(owned.sessions.inspect().roots, 0);
    assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
    assert.equal(
      owned.requests.some((request) => request.operation.startsWith('revoke')),
      false
    );
  } finally {
    release.resolve();
    await owned?.owner.shutdownAsync();
    await f.close();
  }
});

test('lifecycle disable waits for durable ACK and shutdown does not close the worker ahead of pending revocation', async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  let owned;
  try {
    const a = await f.seed();
    await f.runtime.shutdownAsync();
    owned = lifecycleFixture(f, {
      execute(request, next) {
        if (request.operation === 'revoke-all') {
          entered.resolve();
          return release.promise.then(next);
        }
        return next();
      },
    });
    await owned.owner.ready();
    assert.deepEqual(await owned.owner.configureAsync(true), { ok: true });
    const disabling = owned.owner.configureAsync(false);
    await entered.promise;
    const shutdown = owned.owner.shutdownAsync();
    assert.equal(owned.closes(), 0);
    assert.equal(owned.sessions.inspect().enabled, false);
    assert.ok(f.store.execute({ operation: 'load', scope: a.scope }));
    release.resolve();
    assert.deepEqual(await shutdown, { ok: true });
    assert.equal((await disabling).code, 'context_recovery_disabled');
    assert.equal(f.store.execute({ operation: 'load', scope: a.scope }), null);
    assert.equal(owned.closes(), 1);
  } finally {
    release.resolve();
    await owned?.owner.shutdownAsync();
    await f.close();
  }
});

test('lifecycle startup failure stays terminal, is content free and still closes the worker once', async () => {
  for (const mode of ['throw', 'catalog', 'thenable']) {
    const f = fixture();
    let executed = 0;
    const owned = lifecycleFixture(f, {
      execute() {
        if (mode === 'throw') throw new Error(original);
        if (mode === 'catalog') return [{ state: original }];
        return {
          get then() {
            executed++;
            throw new Error(original);
          },
        };
      },
    });
    try {
      assert.equal((await owned.owner.configureAsync(true)).code, unavailable);
      assert.equal(owned.owner.inspect().state, 'failed');
      const count = owned.requests.length;
      assert.equal((await owned.owner.configureAsync(true)).ok, false);
      assert.equal(owned.requests.length, count);
      assert.equal(owned.sessions.inspect().enabled, false);
      assert.equal((await owned.owner.shutdownAsync()).code, unavailable);
      assert.equal(owned.closes(), 1);
      assert.equal(executed, 0);
      assert.equal(JSON.stringify(owned.owner.inspect()).includes(original), false);
    } finally {
      await owned.owner.shutdownAsync();
      await f.close();
    }
  }
});

test('lifecycle shutdown waits for actual worker close and rejects invalid or executable close replies', async () => {
  for (const mode of ['hold', 'throw', 'reply', 'thenable']) {
    const f = fixture();
    const release = deferred();
    let executed = 0;
    const owned = lifecycleFixture(f, {
      close() {
        if (mode === 'hold') return release.promise;
        if (mode === 'throw') throw new Error(original);
        if (mode === 'reply') return { ok: true };
        return {
          get then() {
            executed++;
            throw new Error(original);
          },
        };
      },
    });
    try {
      await owned.owner.ready();
      const shutdown = owned.owner.shutdownAsync();
      await flush();
      assert.equal(owned.closes(), 1);
      if (mode === 'hold') {
        assert.equal(owned.owner.inspect().state, 'closing');
        release.resolve();
        assert.deepEqual(await shutdown, { ok: true });
      } else assert.equal((await shutdown).code, unavailable);
      assert.equal(owned.owner.shutdownAsync(), shutdown);
      assert.equal(executed, 0);
    } finally {
      release.resolve();
      await owned.owner.shutdownAsync();
      await f.close();
    }
  }
});

test('lifecycle safe invocation rejects malformed policy acknowledgements and stops session admission', async () => {
  for (const mode of ['throw', 'extra', 'disabledExtra', 'thenable', 'rejected']) {
    const f = fixture();
    const sessions = createContextRecoverySessions({ now: () => 100 });
    let executed = 0;
    sessions.configureAsync = () => {
      sessions.configure(true);
      if (mode === 'throw') throw new Error(original);
      if (mode === 'extra') return { ok: true, text: original };
      if (mode === 'disabledExtra')
        return { ok: false, code: 'context_recovery_disabled', text: original };
      if (mode === 'rejected') return Promise.reject(new Error(original));
      return {
        get then() {
          executed++;
          throw new Error(original);
        },
      };
    };
    const owned = lifecycleFixture(f, { sessions });
    try {
      await owned.owner.ready();
      assert.equal((await owned.owner.configureAsync(true)).code, unavailable);
      assert.equal(sessions.inspect().enabled, false);
      assert.equal(sessions.inspect().closed, true);
      assert.equal(executed, 0);
      assert.equal((await owned.owner.shutdownAsync()).code, unavailable);
    } finally {
      await owned.owner.shutdownAsync();
      await f.close();
    }
  }
});

function removeDirectory(directory) {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('hpm-lifecycle-')
  )
    throw new Error('Unsafe synthetic cleanup target');
  fs.rmSync(target, { recursive: true, force: true });
}

test(
  'actual encrypted worker suspension retains originals across reopening with fresh authorization',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lifecycle-'));
    const storePath = path.join(directory, 'store');
    let worker, f, owner;
    try {
      worker = await openContextRecoveryStorage({ directory: storePath });
      f = fixture(worker);
      const a = await f.seed();
      const before = await worker.execute({ operation: 'load', scope: a.scope });
      assert.deepEqual(await f.runtime.suspendAsync(), { ok: true });
      assert.deepEqual(await worker.execute({ operation: 'load', scope: a.scope }), before);
      assert.equal((await a.view.replyAsync(LIST, {})).ok, false);
      await f.runtime.shutdownAsync();
      await worker.close();
      worker = await openContextRecoveryStorage({ directory: storePath });
      owner = createContextRecoveryLifecycle({ storage: worker });
      assert.deepEqual(await owner.configureAsync(true), { ok: true });
      assert.equal(
        (await owner.sessions.beginAsync({ ...a.binding, history: a.history }, [], () => false)).ok,
        false
      );
      const fresh = await owner.sessions.beginAsync(
        { ...a.binding, history: a.history },
        [],
        () => true
      );
      assert.equal(fresh.ok, true);
      const list = await fresh.replyAsync(LIST, {});
      assert.equal(list.ok, true);
      const receipt = JSON.parse(list.text).sources[0];
      const read = await fresh.replyAsync(READ, {
        sourceId: receipt.sourceId,
        digest: receipt.digest,
      });
      assert.equal(read.ok, true);
      assert.equal(JSON.parse(read.text).page.text, original);
      const after = await worker.execute({ operation: 'load', scope: a.scope });
      assert.equal(after.expiresAt, before.expiresAt);
      assert.equal(after.state.root.budget.calls, before.state.root.budget.calls + 2);
      assert.equal(
        fs.readFileSync(path.join(storePath, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
    } finally {
      await owner?.shutdownAsync();
      await f?.runtime.shutdownAsync();
      await worker?.close();
      removeDirectory(directory);
    }
  }
);
test(
  'physical lifecycle owner close and worker reopen preserve terminal root revocation and deny revision revival',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const started = Date.now();
    const mark = (phase) =>
      t.diagnostic(JSON.stringify({ phase, elapsedMs: Date.now() - started }));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lifecycle-'));
    const storePath = path.join(directory, 'store');
    let worker, f, lifecycle;
    try {
      worker = createContextRecoveryStorageOpening({
        directory: storePath,
        onStartup: ({ phase }) => mark('initial_' + phase),
      });
      f = fixture(worker);
      mark('seed_started');
      const a = await f.seed();
      mark('seed_finished');
      const prior = await worker.execute({ operation: 'load', scope: a.scope });
      assert.equal((await f.runtime.shutdownAsync()).ok, true);
      mark('old_session_shutdown');
      lifecycle = createContextRecoveryLifecycle({ storage: worker });
      assert.deepEqual(await lifecycle.ready(), { ok: true });
      mark('fresh_session_initialized');
      assert.equal(lifecycle.sessions.inspect().roots, 0);
      assert.deepEqual(await lifecycle.configureAsync(false), { ok: true });
      mark('fresh_session_revoked');
      const shutdown = createProxyShutdown({
        servers: [],
        shutdownRecovery: () => lifecycle.shutdownAsync(),
        stopPid() {
          assert.equal(lifecycle.inspect().state, 'closed');
          return true;
        },
        reportFailure() {},
      });
      assert.equal(await shutdown(), true);
      mark('first_worker_closed');
      worker = undefined;
      worker = await openContextRecoveryStorage({
        directory: storePath,
        onStartup: ({ phase }) => mark('reopen_' + phase),
      });
      assert.equal(await worker.execute({ operation: 'load', scope: a.scope }), null);
      assert.equal((await worker.execute({ operation: 'inspect' })).records, 0);
      await assert.rejects(
        worker.execute({
          operation: 'save',
          scope: a.scope,
          expectedRevision: prior.revision + 1,
          expiresAt: prior.expiresAt,
          state: prior.state,
        }),
        { code: unavailable }
      );
      assert.equal(
        fs.readFileSync(path.join(storePath, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
      mark('revocation_verified');
    } finally {
      mark('cleanup_started');
      await lifecycle?.shutdownAsync();
      if (f) await f.runtime.shutdownAsync();
      try {
        await worker?.close();
      } finally {
        removeDirectory(directory);
        mark('cleanup_finished');
      }
    }
  }
);
