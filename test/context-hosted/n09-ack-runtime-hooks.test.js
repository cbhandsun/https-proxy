'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { installN09RuntimeHooks } = require('../../scripts/context-hosted/n09-ack/runtime-hooks');
const { n09AckFailureStage } = require('../../scripts/context-hosted/n09-ack/contract');
const {
  createN09MailboxHost,
  createN09MailboxClient,
} = require('../../scripts/context-hosted/n09-ack/mailbox');
const { createRecoveryDurableAck } = require('../../lib/proxy/context-recovery-durable-ack');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../../lib/proxy/context-recovery-root-checkpoint');
const {
  referenceStateFromCheckpoint,
} = require('../../lib/proxy/context-recovery-reference-state');

const directory = path.join(os.tmpdir(), 'n09-pure-hook-directory');
const identity = { pid: 123, epoch: 'a'.repeat(32) };
function safe(error) {
  assert.equal(error.message, 'n09_host_ack_rejected');
  assert.equal(error.code, error.message);
  assert.equal(error.cause, undefined);
  return true;
}
function state(lifecycle) {
  const session = lifecycle.sessions.begin({
    principal: 'synthetic-private-owner',
    protocol: 'chat',
    target: 'target',
    history: [{ role: 'user', content: 'synthetic' }],
  });
  assert.equal(session.complete([{ role: 'assistant', content: 'done' }], [], 'r-1').ok, true);
  return referenceStateFromCheckpoint(
    createRootCheckpoint(exportContextRecoveryRoot(lifecycle.sessions, session.snapshotId), [])
  );
}
const command = (reference, sequence = 1, minRevision = 1, operation = 'arm-save') => ({
  version: 1,
  operation,
  ...identity,
  sequence,
  rootId: reference.metadata.rootId,
  expiresAt: reference.metadata.expiresAt,
  minRevision,
});
function fixture(t, options = {}) {
  const lifecycles = [],
    tokens = [];
  let creates = 0,
    shutdowns = 0;
  const ackExports = {
    createRecoveryDurableAck(...args) {
      const token = createRecoveryDurableAck(...args);
      tokens.push(token);
      return token;
    },
  };
  const lifecycleExports = {
    createContextRecoveryLifecycle(input) {
      creates++;
      if (options.onCreate) options.onCreate(input, ackExports);
      const sessions = createContextRecoverySessions({ now: () => 100 });
      sessions.configure(true);
      const lifecycle = {
        sessions,
        shutdownAsync() {
          shutdowns++;
          return options.shutdown ? options.shutdown(sessions) : sessions.shutdownAsync();
        },
      };
      lifecycles.push(lifecycle);
      return lifecycle;
    },
  };
  const originalAck = ackExports.createRecoveryDurableAck;
  const originalFactory = lifecycleExports.createContextRecoveryLifecycle;
  const hooks = installN09RuntimeHooks({
    ackExports,
    lifecycleExports,
    expectedDirectory: directory,
    ...identity,
  });
  t.after(() => {
    try {
      hooks.close();
    } finally {
      for (const lifecycle of lifecycles) lifecycle.sessions.close();
    }
  });
  return {
    hooks,
    ackExports,
    lifecycleExports,
    originalAck,
    originalFactory,
    lifecycles,
    tokens,
    counts: () => ({ creates, shutdowns }),
    open: () => lifecycleExports.createContextRecoveryLifecycle({ directory }),
  };
}

test('signed filesystem mailbox carries original ACK and same-session revoke through runtime hooks', async (t) => {
  const f = fixture(t);
  const mailboxDirectory = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'n09-hook-mailbox-')
  );
  const config = { directory: mailboxDirectory, ...identity, signingKey: 'b'.repeat(64) };
  const host = createN09MailboxHost(config, f.hooks);
  const client = createN09MailboxClient(config);
  t.after(() => {
    host.close();
    client.close();
    fs.rmSync(mailboxDirectory, { recursive: true, force: true });
  });
  const lifecycle = f.open();
  const reference = state(lifecycle);
  f.ackExports.createRecoveryDurableAck(reference, 1);
  client.submit(command(reference));
  assert.equal(host.step(), 'armed');
  assert.equal(client.readArmed(), true);
  assert.equal(client.readReceipt(), null);
  const token = f.ackExports.createRecoveryDurableAck(reference, 2);
  assert.equal(token, f.tokens[1]);
  await new Promise((resolve) => setImmediate(resolve));
  const saved = client.readReceipt();
  assert.equal(saved.kind, 'host-save-completed');
  assert.equal(saved.revision, 2);
  assert.equal(saved.liveDaemonProved, false);
  assert.equal(lifecycle.sessions.inspect().roots, 1);
  client.submit(command(reference, 2, 2, 'revoke-bound-root'));
  assert.equal(host.step(), 'revoking');
  await new Promise((resolve) => setImmediate(resolve));
  const revoked = client.readReceipt();
  assert.equal(revoked.kind, 'host-revoke-completed');
  assert.equal(revoked.revision, 2);
  assert.equal(lifecycle.sessions.inspect().roots, 0);
  for (const name of fs.readdirSync(mailboxDirectory)) {
    const bytes = fs.readFileSync(path.join(mailboxDirectory, name), 'utf8');
    for (const secret of [config.signingKey, reference.metadata.principal])
      assert.equal(bytes.includes(secret), false);
  }
  assert.equal(f.counts().shutdowns, 0);
});

test('fixed ACK hook runs original producer, retains its token and binds only target persistent sessions', async (t) => {
  const f = fixture(t);
  const memory = f.lifecycleExports.createContextRecoveryLifecycle({});
  const persistent = f.open();
  const reference = state(persistent);
  assert.equal(f.ackExports.createRecoveryDurableAck(reference, 1), f.tokens[0]);
  const pending = f.hooks.armSave(command(reference));
  assert.equal(f.ackExports.createRecoveryDurableAck(reference, 2), f.tokens[1]);
  const ack = await pending;
  assert.equal(ack.revision, 2);
  assert.equal(ack.liveDaemonProved, false);
  assert.equal(memory.sessions.inspect().roots, 0);
  assert.equal(persistent.sessions.inspect().roots, 1);
  await f.hooks.revokeBoundRoot(command(reference, 2, 2, 'revoke-bound-root'));
  assert.equal(persistent.sessions.inspect().roots, 0);
  assert.deepEqual(f.counts(), { creates: 2, shutdowns: 0 });
  f.hooks.close();
  assert.equal(f.ackExports.createRecoveryDurableAck, f.originalAck);
  assert.equal(f.lifecycleExports.createContextRecoveryLifecycle, f.originalFactory);
  assert.equal(f.counts().shutdowns, 0);
});

test('snapshot/producer revision drift and identity mismatch retain strict rejection with finite distinct stages', (t) => {
  const f = fixture(t);
  const lifecycle = f.open();
  const reference = state(lifecycle);
  f.ackExports.createRecoveryDurableAck(reference, 1);
  const stale = command(reference, 1, 1, 'revoke-bound-root');
  // Model a final publication ACK arriving after the client captured its DB baseline.
  f.ackExports.createRecoveryDurableAck(reference, 2);
  for (const [value, phase] of [
    [stale, 144],
    [{ ...stale, rootId: 'hbs_' + 'f'.repeat(32) }, 143],
    [{ ...stale, pid: 124 }, 142],
  ]) {
    assert.throws(
      () => f.hooks.revokeBoundRoot(value),
      (error) => {
        safe(error);
        assert.equal(n09AckFailureStage(error), phase);
        return true;
      }
    );
    assert.equal(lifecycle.sessions.inspect().roots, 1);
  }
  assert.equal(f.counts().shutdowns, 0);
});

test('successful original shutdown alone permits replacement while global command sequence prevents replay', async (t) => {
  const f = fixture(t);
  const first = f.open();
  const old = state(first);
  f.ackExports.createRecoveryDurableAck(old, 1);
  const waiting = f.hooks.armSave(command(old));
  f.ackExports.createRecoveryDurableAck(old, 2);
  await waiting;
  assert.throws(() => f.open(), safe);
  assert.deepEqual(await first.shutdownAsync(), { ok: true });
  const next = f.open();
  const fresh = state(next);
  f.ackExports.createRecoveryDurableAck(fresh, 1);
  assert.throws(() => f.hooks.armSave(command(fresh, 1)), safe);
  const pending = f.hooks.armSave(command(fresh, 2));
  f.ackExports.createRecoveryDurableAck(fresh, 2);
  assert.equal((await pending).sequence, 2);
  assert.equal(f.counts().shutdowns, 1);
});

test('pending shutdown blocks replacement and calls the original only once', async (t) => {
  let finish;
  const f = fixture(t, {
    shutdown: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = f.open();
  const pending = first.shutdownAsync();
  assert.equal(first.shutdownAsync(), pending);
  assert.throws(() => f.open(), safe);
  assert.equal(f.counts().shutdowns, 1);
  finish({ ok: true });
  await pending;
  assert.ok(f.open());
});

test('failed, malformed or non-native shutdown cannot release the persistent binding', async (t) => {
  for (const shutdown of [
    () => Promise.resolve({ ok: false }),
    () => Promise.resolve({ ok: true, extra: true }),
    () => Promise.reject(new Error('private shutdown')),
    () => ({ ok: true }),
    () => {
      throw new Error('private shutdown');
    },
  ]) {
    const f = fixture(t, { shutdown });
    const first = f.open();
    await assert.rejects(first.shutdownAsync(), safe);
    assert.throws(() => f.open(), safe);
    assert.equal(f.counts().creates, 1);
    assert.equal(f.counts().shutdowns, 1);
  }
});

test('mismatched persistent directory and opaque storage cannot create an unowned lifecycle', (t) => {
  const f = fixture(t);
  for (const options of [
    { directory: directory + '-other' },
    { storage: {} },
    { directory, extra: true },
    { directory: '../relative' },
  ])
    assert.throws(() => f.lifecycleExports.createContextRecoveryLifecycle(options), safe);
  assert.equal(f.counts().creates, 0);
});

test('memory lifecycle ACKs never bind an observer or grant arm/revoke capability', (t) => {
  const f = fixture(t);
  const memory = f.lifecycleExports.createContextRecoveryLifecycle({});
  const reference = state(memory);
  assert.equal(f.ackExports.createRecoveryDurableAck(reference, 1), f.tokens[0]);
  assert.throws(() => f.hooks.armSave(command(reference)), safe);
  assert.throws(() => f.hooks.revokeBoundRoot(command(reference, 1, 1, 'revoke-bound-root')), safe);
  assert.equal(memory.sessions.inspect().roots, 1);
});

test('shutdown with pending observation still invokes original but cannot permit replacement', async (t) => {
  const f = fixture(t);
  const lifecycle = f.open();
  const reference = state(lifecycle);
  f.ackExports.createRecoveryDurableAck(reference, 1);
  const waiting = f.hooks.armSave(command(reference));
  const rejected = assert.rejects(waiting, safe);
  await lifecycle.shutdownAsync();
  await rejected;
  assert.equal(f.counts().shutdowns, 1);
  assert.throws(() => f.open(), safe);
});

test('ACK during factory construction executes original but fails closed on ambiguous ownership', (t) => {
  const source = createContextRecoverySessions({ now: () => 100 });
  source.configure(true);
  t.after(() => source.close());
  const reference = state({ sessions: source });
  const f = fixture(t, {
    onCreate(input, ackExports) {
      ackExports.createRecoveryDurableAck(reference, 1);
    },
  });
  assert.throws(() => f.open(), safe);
  assert.equal(f.tokens.length, 1);
  assert.throws(() => f.open(), safe);
});

test('hook cleanup rejects pending observation without shutting down actual lifecycle', async (t) => {
  const f = fixture(t);
  const live = f.open();
  const reference = state(live);
  f.ackExports.createRecoveryDurableAck(reference, 1);
  const pending = f.hooks.armSave(command(reference));
  const rejected = assert.rejects(pending, safe);
  f.hooks.close();
  await rejected;
  assert.equal(f.counts().shutdowns, 0);
  assert.equal(live.sessions.inspect().closed, false);
  f.hooks.close();
  assert.equal(f.ackExports.createRecoveryDurableAck(reference, 2), f.tokens.at(-1));
});

test('descriptor-only install and options validation never invokes getters or Proxy traps', () => {
  let hits = 0;
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
  assert.throws(() => installN09RuntimeHooks(proxy), safe);
  const ackExports = {};
  Object.defineProperty(ackExports, 'createRecoveryDurableAck', {
    enumerable: true,
    configurable: true,
    get() {
      hits++;
      return undefined;
    },
  });
  assert.throws(
    () =>
      installN09RuntimeHooks({
        ackExports,
        lifecycleExports: {},
        expectedDirectory: directory,
        ...identity,
      }),
    safe
  );
  assert.equal(hits, 0);
});

test('a second installer cannot stack ownership over the same exports', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      installN09RuntimeHooks({
        ackExports: f.ackExports,
        lifecycleExports: f.lifecycleExports,
        expectedDirectory: directory,
        ...identity,
      }),
    safe
  );
  assert.equal(f.counts().creates, 0);
});

test('cleanup restores owned descriptors but never overwrites third-party drift', () => {
  const ackExports = { createRecoveryDurableAck };
  const originalFactory = () => ({});
  const lifecycleExports = { createContextRecoveryLifecycle: originalFactory };
  const hooks = installN09RuntimeHooks({
    ackExports,
    lifecycleExports,
    expectedDirectory: directory,
    ...identity,
  });
  const thirdParty = () => Object.freeze({});
  ackExports.createRecoveryDurableAck = thirdParty;
  assert.throws(() => hooks.close(), safe);
  assert.equal(ackExports.createRecoveryDurableAck, thirdParty);
  assert.equal(lifecycleExports.createContextRecoveryLifecycle, originalFactory);
  assert.throws(() => hooks.close(), safe);
});
