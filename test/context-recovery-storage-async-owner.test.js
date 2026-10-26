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
    failed = false;
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
      execute: (_file, _args, options) => execute(options.input),
      createChannel: () => ({
        async execute(text) {
          const reply = execute(text);
          await waitReply();
          return reply;
        },
        async close() {
          closes++;
          await waitClose();
        },
      }),
    });
  const open = () => {
    const owner = createAsyncStorageOwner({ directory, protectKey }, { createAnchorSession });
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

test('async owner retains synchronous empty intent and startup, waits for exact ACK and reopens unchanged expiry', async (t) => {
  const f = fixture(t),
    owner = f.open(),
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
  const reopened = f.open();
  const state = await reopened.execute({ operation: 'load', scope });
  assert.equal(state.expiresAt, expiresAt);
  assert.equal(state.revision, 1);
});

test('failed post-SQL ACK never succeeds and writer lock remains held until actual channel close', async (t) => {
  const f = fixture(t),
    owner = f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const held = f.holdClose();
  f.fail();
  const pending = save(owner, expiresAt, 1),
    rejected = assert.rejects(pending, safe);
  await turn();
  assert.equal(f.closes(), 1);
  assert.throws(f.open, safe, 'cannot grant another writer while native cleanup is pending');
  held.resolve();
  await rejected;
  await assert.rejects(owner.execute({ operation: 'load', scope }), safe);
  f.restore();
  const reopened = f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).revision, 2);
});

test('rejected stale SQL remains retryable and does not submit another anchor write', async (t) => {
  const f = fixture(t),
    owner = f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const writes = f.writes();
  await assert.rejects(save(owner, expiresAt), safe);
  assert.equal(f.writes(), writes);
  assert.deepEqual(await save(owner, expiresAt, 1), { revision: 2 });
});

test('close during async ACK holds the writer lock, rejects in-flight result and is idempotent', async (t) => {
  const f = fixture(t),
    owner = f.open(),
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
  const reopened = f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).revision, 1);
});

test('path verification failure closes an already-used async channel before releasing writer authority', async (t) => {
  const f = fixture(t),
    owner = f.open(),
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
  const reopened = f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).expiresAt, expiresAt);
});
