'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecoveryAnchorSession } = require('../lib/proxy/context-recovery-anchor');
const { createAsyncStorageOwner } = require('../lib/proxy/context-recovery-storage-owner');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');
const { DatabaseSync } = require('node:sqlite');
const { types } = require('node:util');
const { storageFailureDiagnostic } = require('../lib/proxy/context-recovery-storage-failure');
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' && error.message === error.code;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-async-owner-'));
  const directory = path.join(root, 'store'),
    executable = path.join(root, 'native.exe');
  fs.writeFileSync(executable, 'synthetic-anchor-backend');
  const rows = new Map(),
    owners = [],
    gates = [];
  let writes = 0,
    closes = 0,
    channels = 0,
    syncWrites = 0,
    failed = false;
  const startupPhases = [];
  let replyValue = (text) => text;
  let waitReply = async () => {},
    waitClose = async () => {};
  const protectKey = ({ operation, value }) =>
    operation === 'protect' ? KEY_PREFIX + value : value.slice(KEY_PREFIX.length);
  const execute = (text) => {
    const request = JSON.parse(text),
      prior = rows.get(request.slot) ?? { revision: 0, value: null };
    if (request.operation === 'read') return JSON.stringify({ ok: true, ...prior });
    writes++;
    if (failed) throw Error('PRIVATE synthetic flush failure');
    assert.equal(request.expectedRevision, prior.revision);
    const next = { revision: prior.revision + 1, value: request.value };
    rows.set(request.slot, next);
    return JSON.stringify({ ok: true, ...next });
  };
  const createAnchorSession = (input) =>
    createRecoveryAnchorSession(input, {
      platform: 'win32',
      nativeExecutable: executable,
      environment: { SystemRoot: 'C:\\Windows' },
      execute: (_file, _args, options) => {
        if (JSON.parse(options.input).operation !== 'read') syncWrites++;
        return execute(options.input);
      },
      createChannel: () => {
        channels++;
        return {
          async execute(text) {
            const reply = execute(text);
            await waitReply();
            return replyValue(reply);
          },
          async close() {
            closes++;
            await waitClose();
          },
        };
      },
    });
  const open = () => {
    const owner = createAsyncStorageOwner(
      { directory, protectKey, onStartup: ({ phase }) => startupPhases.push(phase) },
      { createAnchorSession }
    );
    if (types.isPromise(owner))
      return owner.then((ready) => {
        owners.push(ready);
        return ready;
      });
    owners.push(owner);
    return owner;
  };
  t.after(async () => {
    for (const held of gates) held.resolve();
    for (const owner of owners) await owner.close();
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    open,
    directory,
    rows,
    writes: () => writes,
    closes: () => closes,
    channels: () => channels,
    syncWrites: () => syncWrites,
    startupPhases: () => [...startupPhases],
    corruptReply(mode) {
      replyValue = (text) => {
        if (mode === 'empty') return '';
        if (mode === 'malformed') return '{';
        const value = JSON.parse(text);
        value.revision = mode === 'extreme-revision' ? Number.MAX_SAFE_INTEGER : value.revision + 1;
        return JSON.stringify(value);
      };
    },
    validReply() {
      replyValue = (text) => text;
    },
    rejectReply() {
      waitReply = async () => {
        throw Error('PRIVATE synthetic reply failure');
      };
    },
    resumeReplies() {
      waitReply = async () => {};
    },
    fail() {
      failed = true;
    },
    restore() {
      failed = false;
    },
    holdReply() {
      const held = gate();
      gates.push(held);
      waitReply = () => held.promise;
      return held;
    },
    holdClose() {
      const held = gate();
      gates.push(held);
      waitClose = () => held.promise;
      return held;
    },
  };
}
const scope = 'a'.repeat(64);
const save = (owner, expiresAt, revision = 0) =>
  owner.execute({
    operation: 'save',
    scope,
    expectedRevision: revision,
    expiresAt,
    state: { original: 'PRIVATE synthetic', calls: 4 - revision },
  });

test('async owner retains synchronous empty intent and durable startup, waits for exact ACK and reopens unchanged expiry', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  assert.equal(f.writes(), 2);
  const held = f.holdReply(),
    pending = save(owner, expiresAt);
  let acknowledged = false;
  void pending.then(() => {
    acknowledged = true;
  });
  await turn();
  assert.equal(acknowledged, false);
  const db = new DatabaseSync(path.join(f.directory, 'checkpoint.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM recovery_state').get().count, 1);
  } finally {
    db.close();
  }
  await assert.rejects(owner.execute({ operation: 'inspect' }), safe);
  held.resolve();
  assert.deepEqual(await pending, { revision: 1 });
  await owner.close();
  const reopened = await f.open();
  const state = await reopened.execute({ operation: 'load', scope });
  assert.equal(state.expiresAt, expiresAt);
  assert.equal(state.revision, 1);
});

test('failed post-SQL ACK never succeeds and writer lock remains held until actual channel close', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const held = f.holdClose();
  f.fail();
  const pending = save(owner, expiresAt, 1),
    rejected = assert.rejects(pending, (error) => {
      assert.deepEqual(storageFailureDiagnostic(error), {
        phase: 'anchor-request',
        cleanupFailed: false,
      });
      return safe(error);
    });
  await turn();
  assert.equal(f.closes(), 1);
  assert.throws(f.open, safe, 'cannot grant another writer while native cleanup is pending');
  held.resolve();
  await rejected;
  await assert.rejects(owner.execute({ operation: 'load', scope }), safe);
  f.restore();
  const reopened = await f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).revision, 2);
});

test('rejected stale SQL remains retryable and does not submit another anchor write', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const writes = f.writes();
  await assert.rejects(save(owner, expiresAt), (error) => {
    assert.deepEqual(storageFailureDiagnostic(error), {
      phase: 'engine-execute',
      cleanupFailed: false,
    });
    return safe(error);
  });
  assert.equal(f.writes(), writes);
  assert.deepEqual(await save(owner, expiresAt, 1), { revision: 2 });
});

test('close during async ACK holds the writer lock, rejects in-flight result and is idempotent', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    reply = f.holdReply(),
    closed = f.holdClose();
  const rejected = assert.rejects(save(owner, Date.now() + 60000), safe),
    closing = owner.close();
  assert.equal(owner.close(), closing);
  reply.resolve();
  await turn();
  assert.throws(f.open, safe);
  closed.resolve();
  await closing;
  await rejected;
  const reopened = await f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).revision, 1);
});

test('path verification failure closes an already-used async channel before releasing writer authority', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const key = path.join(f.directory, '.data-key'),
    moved = key + '-moved';
  const held = f.holdClose();
  fs.renameSync(key, moved);
  const rejected = assert.rejects(owner.execute({ operation: 'inspect' }), safe);
  await turn();
  assert.equal(f.closes(), 1);
  const lock = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  try {
    assert.throws(() => lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'));
  } finally {
    lock.close();
  }
  held.resolve();
  await rejected;
  fs.renameSync(moved, key);
  const reopened = await f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).expiresAt, expiresAt);
});

test('async startup waits for its real channel ACK and reuses that channel for the first request', async (t) => {
  const f = fixture(t),
    held = f.holdReply(),
    pending = f.open();
  assert.equal(types.isPromise(pending), true, 'startup must await the owned native channel');
  let ready = false;
  void pending.then(() => {
    ready = true;
  });
  await turn();
  assert.equal(ready, false);
  assert.equal(
    f.syncWrites(),
    1,
    'empty enrollment intent still precedes SQL COMMIT synchronously'
  );
  assert.equal(f.writes(), 2);
  assert.equal(f.channels(), 1);
  assert.throws(f.open, safe, 'pending startup retains the exclusive writer');
  held.resolve();
  const owner = await pending;
  assert.equal(f.startupPhases().filter((phase) => phase === 'engine_ready').length, 1);
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
  assert.equal(f.channels(), 1, 'first operation cannot spawn another anchor channel');
  assert.equal(f.syncWrites(), 1, 'startup final ACK must not use another one-shot process');
});

test('failed startup ACK stays rejected and retains writer authority until actual channel cleanup', async (t) => {
  const f = fixture(t),
    held = f.holdClose();
  f.rejectReply();
  const pending = f.open();
  assert.equal(types.isPromise(pending), true);
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(storageFailureDiagnostic(error).phase, 'anchor-request');
    return safe(error);
  });
  await turn();
  assert.equal(f.closes(), 1);
  assert.throws(f.open, safe);
  held.resolve();
  await rejected;
  f.resumeReplies();
  const reopened = await f.open();
  assert.deepEqual(await reopened.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

for (const mode of ['empty', 'malformed', 'wrong-revision', 'extreme-revision']) {
  test(
    'async startup rejects ' + mode + ' ACK, closes the channel and never returns ready',
    async (t) => {
      const f = fixture(t);
      f.corruptReply(mode);
      await assert.rejects(f.open(), safe);
      assert.equal(f.startupPhases().includes('engine_ready'), false);
      assert.equal(f.closes(), 1);
      assert.equal(f.syncWrites(), 1);
      f.validReply();
      const owner = await f.open();
      assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
    }
  );
}

test('path replacement during startup ACK cannot return ready or release its writer before cleanup', async (t) => {
  const f = fixture(t),
    reply = f.holdReply(),
    cleanup = f.holdClose();
  const pending = f.open();
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(storageFailureDiagnostic(error).phase, 'owner-verify');
    return safe(error);
  });
  await turn();
  const key = path.join(f.directory, '.data-key'),
    moved = key + '-during-startup';
  fs.renameSync(key, moved);
  reply.resolve();
  await turn();
  assert.equal(f.startupPhases().includes('engine_ready'), false);
  assert.equal(f.closes(), 1);
  const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  try {
    assert.throws(() => mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'));
  } finally {
    mutex.close();
  }
  cleanup.resolve();
  await rejected;
  fs.renameSync(moved, key);
  const owner = await f.open();
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});
