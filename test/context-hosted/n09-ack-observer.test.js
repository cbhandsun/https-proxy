'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createN09HostAckObserver } = require('../../scripts/context-hosted/n09-ack/observer');
const { createRecoveryDurableAck } = require('../../lib/proxy/context-recovery-durable-ack');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../../lib/proxy/context-recovery-root-checkpoint');
const {
  referenceStateFromCheckpoint,
  createReferenceState,
} = require('../../lib/proxy/context-recovery-reference-state');
const config = { pid: 123, epoch: 'a'.repeat(32) };
function reference() {
  const sessions = createContextRecoverySessions({ now: () => 100 });
  sessions.configure(true);
  try {
    const session = sessions.begin({
      principal: 'synthetic-private-principal',
      protocol: 'chat',
      target: 'target',
      history: [{ role: 'user', content: 'synthetic question' }],
    });
    assert.equal(
      session.complete([{ role: 'assistant', content: 'synthetic answer' }], [], 'r-1').ok,
      true
    );
    return referenceStateFromCheckpoint(
      createRootCheckpoint(exportContextRecoveryRoot(sessions, session.snapshotId), [])
    );
  } finally {
    sessions.close();
  }
}
function safe(error) {
  assert.equal(error.message, 'n09_host_ack_rejected');
  assert.equal(error.code, error.message);
  assert.equal(error.cause, undefined);
  return true;
}
function setup(t, extra = {}) {
  const observer = createN09HostAckObserver({ ...config, createRecoveryDurableAck, ...extra });
  t.after(() => observer.close());
  const state = reference();
  const calls = [];
  const sessions = {
    async revokeAsync(principal) {
      calls.push({ self: this, principal });
      return { ok: true };
    },
  };
  observer.bindSessions(sessions);
  observer.createRecoveryDurableAck(state, 1);
  const command = (operation = 'arm-save', overrides = {}) => ({
    version: 1,
    operation,
    ...config,
    sequence: 1,
    rootId: state.metadata.rootId,
    expiresAt: state.metadata.expiresAt,
    minRevision: 1,
    ...overrides,
  });
  return { observer, state, sessions, calls, command };
}

test('save observation waits for successful original factory and exposes only metadata budget', async (t) => {
  let invoked = 0;
  const f = setup(t, {
    createRecoveryDurableAck(...args) {
      invoked++;
      return createRecoveryDurableAck(...args);
    },
  });
  const pending = f.observer.armSave(f.command());
  let completed = false;
  void pending.then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  const token = f.observer.createRecoveryDurableAck(f.state, 2);
  assert.ok(Object.isFrozen(token));
  const ack = await pending;
  assert.equal(invoked, 2);
  assert.equal(ack.kind, 'host-save-completed');
  assert.equal(ack.revision, 2);
  assert.equal(ack.rootId, f.state.metadata.rootId);
  assert.equal(ack.calls, f.state.metadata.budget.calls);
  assert.equal(ack.returnedBytes, f.state.metadata.budget.returnedBytes);
  assert.equal(ack.liveDaemonProved, false);
  const bytes = JSON.stringify(ack);
  for (const secret of [f.state.metadata.principal, 'synthetic question', 'synthetic answer'])
    assert.equal(bytes.includes(secret), false);
  assert.equal(f.calls.length, 0);
});

test('revoke invokes the same bound sessions and awaits strict success without inventing revoke revision', async (t) => {
  const f = setup(t);
  const result = await f.observer.revokeBoundRoot(f.command('revoke-bound-root'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].self, f.sessions);
  assert.equal(f.calls[0].principal, f.state.metadata.principal);
  assert.equal(result.kind, 'host-revoke-completed');
  assert.equal(result.durableBoundary, 'await-revokeAsync');
  assert.equal(result.revision, 1);
  assert.equal(result.revisionSource, 'validated-reference-save');
  await assert.rejects(
    f.observer.revokeBoundRoot(f.command('revoke-bound-root', { sequence: 2 })),
    safe
  );
  assert.equal(f.calls.length, 1);
});

test('unknown roots, old epochs, stale sequence/revision and concurrent operations are rejected', async (t) => {
  const f = setup(t);
  for (const change of [
    { rootId: 'hbs_' + 'd'.repeat(32) },
    { epoch: 'b'.repeat(32) },
    { pid: 124 },
    { sequence: 2 },
    { minRevision: 2 },
    { expiresAt: f.state.metadata.expiresAt + 1 },
  ])
    assert.throws(() => f.observer.armSave(f.command('arm-save', change)), safe);
  const pending = f.observer.armSave(f.command());
  assert.throws(() => f.observer.armSave(f.command()), safe);
  await assert.rejects(
    f.observer.revokeBoundRoot(f.command('revoke-bound-root', { sequence: 2 })),
    safe
  );
  f.observer.createRecoveryDurableAck(f.state, 2);
  await pending;
  assert.throws(() => f.observer.armSave(f.command()), safe);
  assert.equal(f.calls.length, 0);
});

test('failed original producer never emits ACK and cleanup rejects a pending or late save', async (t) => {
  let rejectOriginal = false;
  const f = setup(t, {
    createRecoveryDurableAck(...args) {
      if (rejectOriginal) throw new Error('private producer failure');
      return createRecoveryDurableAck(...args);
    },
  });
  const pending = f.observer.armSave(f.command());
  const rejected = assert.rejects(pending, safe);
  rejectOriginal = true;
  assert.throws(() => f.observer.createRecoveryDurableAck(f.state, 2), safe);
  await rejected;
  assert.throws(() => f.observer.armSave(f.command()), safe);
  const clean = setup(t);
  const waiting = clean.observer.armSave(clean.command());
  const cleanup = assert.rejects(waiting, safe);
  clean.observer.close();
  clean.observer.close();
  await cleanup;
  assert.throws(() => clean.observer.createRecoveryDurableAck(clean.state, 2), safe);
});

test('invalid revoke results, rejection and close during an awaited revoke cannot report success', async (t) => {
  for (const value of [null, { ok: false }, { ok: true, extra: true }]) {
    const f = setup(t);
    // Bind captures the original method, so later mutation cannot replace it.
    f.sessions.revokeAsync = async () => value;
    assert.equal(
      (await f.observer.revokeBoundRoot(f.command('revoke-bound-root'))).kind,
      'host-revoke-completed'
    );
  }
  for (const value of [null, { ok: false }, { ok: true, extra: true }]) {
    const observer = createN09HostAckObserver({ ...config, createRecoveryDurableAck });
    t.after(() => observer.close());
    observer.bindSessions({
      async revokeAsync() {
        return value;
      },
    });
    const state = reference();
    observer.createRecoveryDurableAck(state, 1);
    await assert.rejects(
      observer.revokeBoundRoot({
        version: 1,
        operation: 'revoke-bound-root',
        ...config,
        sequence: 1,
        rootId: state.metadata.rootId,
        expiresAt: state.metadata.expiresAt,
        minRevision: 1,
      }),
      safe
    );
  }
  const f = setup(t);
  const observer = createN09HostAckObserver({ ...config, createRecoveryDurableAck });
  t.after(() => observer.close());
  let finish;
  observer.bindSessions({
    revokeAsync() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  observer.createRecoveryDurableAck(f.state, 1);
  const pending = observer.revokeBoundRoot(f.command('revoke-bound-root'));
  const rejected = assert.rejects(pending, safe);
  await assert.rejects(
    observer.revokeBoundRoot(f.command('revoke-bound-root', { sequence: 2 })),
    safe
  );
  assert.throws(() => observer.armSave(f.command('arm-save', { sequence: 2 })), safe);
  observer.close();
  await rejected;
  finish({ ok: true });
  await Promise.resolve();
});

test('strict input rejects getters, proxies, unknown state and multiple sessions without execution', (t) => {
  let hits = 0;
  const f = setup(t);
  const getter = f.command();
  Object.defineProperty(getter, 'operation', {
    enumerable: true,
    get() {
      hits++;
      return 'arm-save';
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        hits++;
      },
      ownKeys() {
        hits++;
      },
      getPrototypeOf() {
        hits++;
      },
    }
  );
  assert.throws(() => f.observer.armSave(getter), safe);
  assert.throws(() => f.observer.armSave(proxy), safe);
  assert.throws(() => createN09HostAckObserver(proxy), safe);
  assert.throws(
    () =>
      f.observer.bindSessions({
        async revokeAsync() {
          hits++;
          return { ok: true };
        },
      }),
    safe
  );
  assert.equal(hits, 0);
  assert.throws(() => f.observer.createRecoveryDurableAck({}, 2), safe);
  assert.equal(f.calls.length, 0);
});

test('empty observer cannot arm or revoke an unobserved root and never invokes unknown then getters', async (t) => {
  const observer = createN09HostAckObserver({ ...config, createRecoveryDurableAck });
  t.after(() => observer.close());
  const f = setup(t);
  let hits = 0;
  observer.bindSessions({
    revokeAsync() {
      hits++;
      return Promise.resolve({ ok: true });
    },
  });
  assert.throws(() => observer.armSave(f.command()), safe);
  await assert.rejects(observer.revokeBoundRoot(f.command('revoke-bound-root')), safe);
  assert.equal(hits, 0);
  const hostile = createN09HostAckObserver({ ...config, createRecoveryDurableAck });
  t.after(() => hostile.close());
  hostile.bindSessions({
    revokeAsync() {
      return Object.defineProperty({}, 'then', {
        get() {
          hits++;
          return undefined;
        },
      });
    },
  });
  hostile.createRecoveryDurableAck(f.state, 1);
  await assert.rejects(hostile.revokeBoundRoot(f.command('revoke-bound-root')), safe);
  assert.equal(hits, 0);
  const failed = createN09HostAckObserver({ ...config, createRecoveryDurableAck });
  t.after(() => failed.close());
  failed.bindSessions({
    async revokeAsync() {
      throw new Error('private reject');
    },
  });
  failed.createRecoveryDurableAck(f.state, 1);
  await assert.rejects(failed.revokeBoundRoot(f.command('revoke-bound-root')), safe);
});

test('unknown or regressing ACK metadata cannot grant another root or restore budget', async (t) => {
  const f = setup(t);
  const waiting = f.observer.armSave(f.command());
  const rejected = assert.rejects(waiting, safe);
  assert.throws(() => f.observer.createRecoveryDurableAck(f.state, 1), safe);
  await rejected;
  const other = setup(t);
  const changed = reference();
  assert.notEqual(changed.metadata.rootId, other.state.metadata.rootId);
  assert.throws(() => other.observer.createRecoveryDurableAck(changed, 2), safe);
  const budget = setup(t);
  const larger = createReferenceState(
    { ...budget.state.metadata, budget: { ...budget.state.metadata.budget, calls: 1 } },
    budget.state.stagedSources,
    budget.state.publications
  );
  budget.observer.createRecoveryDurableAck(larger, 2);
  assert.throws(() => budget.observer.createRecoveryDurableAck(budget.state, 3), safe);
});
