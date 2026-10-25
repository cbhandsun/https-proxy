'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createStorageOwner } = require('../lib/proxy/context-recovery-storage-owner');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');

const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503;
const scope = 'a'.repeat(64);
const hash = (value) => createHash('sha256').update(value).digest('hex');
// Explicit synthetic key and retained backend injection. Real owner wiring and
// SQLite commits are exercised, without executing the production registry CLI.
function fixture(t) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-anchor-owner-'));
  const directory = path.join(root, 'store');
  const rows = new Map(),
    owners = [];
  let writes = 0,
    failAt;
  const protectKey = ({ operation, value }) =>
    operation === 'protect' ? KEY_PREFIX + value : value.slice(KEY_PREFIX.length);
  function createAnchorRepository({ directory, dataKey }) {
    const keyIdentity = hash(dataKey),
      locationHash = hash(directory);
    let expected = rows.get(keyIdentity)?.revision ?? 0;
    return {
      identity: { keyIdentity, locationHash },
      read: () => rows.get(keyIdentity)?.value ?? null,
      commit(value) {
        writes++;
        if (writes === failAt) throw new Error('PRIVATE synthetic flush failure');
        assert.equal(expected, rows.get(keyIdentity)?.revision ?? 0);
        rows.set(keyIdentity, { revision: ++expected, value });
        return { revision: expected };
      },
      close() {},
    };
  }
  function open() {
    const owner = createStorageOwner({ directory, protectKey }, { createAnchorRepository });
    owners.push(owner);
    return owner;
  }
  t.after(() => {
    for (const owner of owners) owner.close();
    assert.equal(path.dirname(root), temporary);
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('hpm-anchor-owner-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    directory,
    rows,
    open,
    writes: () => writes,
    failNext() {
      failAt = writes + 1;
    },
    failAfter(count) {
      failAt = writes + count;
    },
    restoreBackend() {
      failAt = undefined;
    },
  };
}
function save(owner, expectedRevision = 0, expiresAt = Date.now() + 60000) {
  return owner.execute({
    operation: 'save',
    scope,
    expectedRevision,
    expiresAt,
    state: { original: 'PRIVATE synthetic fixture', calls: 4 - expectedRevision },
  });
}

test('production owner refuses original backup after acknowledged revocation with independent retained backend', (t) => {
  const f = fixture(t),
    owner = f.open();
  assert.equal(f.writes(), 2, 'empty intent then normal startup must both persist before ready');
  const inspected = new DatabaseSync(path.join(f.directory, 'checkpoint.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 3);
  } finally {
    inspected.close();
  }
  save(owner);
  const file = path.join(f.directory, 'checkpoint.sqlite');
  const prior = fs.readFileSync(file);
  owner.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  owner.close();
  const reopened = f.open();
  reopened.close();
  fs.writeFileSync(file, prior);
  assert.throws(f.open, safe);
});

test('production owner waits for anchor ACK and cannot continue after failed post-SQLite flush', (t) => {
  const f = fixture(t),
    owner = f.open();
  const expiresAt = Date.now() + 60000;
  save(owner, 0, expiresAt);
  f.failNext();
  assert.throws(() => save(owner, 1, expiresAt), safe);
  assert.throws(() => owner.execute({ operation: 'load', scope }), safe);
  f.restoreBackend();
  const reopened = f.open();
  assert.equal(reopened.execute({ operation: 'load', scope }).revision, 2);
});

test('format sealing failure never returns a ready owner and releases the writer lock for a checked retry', (t) => {
  const f = fixture(t);
  const original = DatabaseSync.prototype.exec;
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'PRAGMA user_version=3') throw Error('PRIVATE synthetic format failure');
    return Reflect.apply(original, this, [sql]);
  });
  assert.throws(f.open, safe);
  assert.equal(f.writes(), 1, 'initial intent is not a ready-owner acknowledgement');
  mocked.mock.restore();
  const owner = f.open();
  save(owner);
  owner.close();
  assert.equal(f.open().execute({ operation: 'load', scope }).revision, 1);
});

test('interrupted initial startup retains empty intent and permits same-storeId retry without data loss', (t) => {
  const f = fixture(t);
  // Initial empty intent succeeds; the final startup watermark fails.
  // The owner must not return ready, and the next owner must reconcile it.
  const ordinaryOpen = f.open;
  f.failAfter(2);
  assert.throws(ordinaryOpen, safe);
  assert.equal(f.rows.size, 1);
  const intentStoreId = [...f.rows.values()][0].value.storeId;
  const database = new DatabaseSync(path.join(f.directory, 'checkpoint.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(
      database.prepare('SELECT store_id FROM recovery_header').get().store_id,
      intentStoreId
    );
  } finally {
    database.close();
  }
  f.restoreBackend();
  const owner = f.open();
  assert.equal([...f.rows.values()][0].value.storeId, intentStoreId);
  save(owner);
  owner.close();
  const reopened = f.open();
  assert.equal(reopened.execute({ operation: 'load', scope }).state.calls, 4);
});

test('an existing nonempty database with lost independent enrollment never silently re-enrolls', (t) => {
  const f = fixture(t),
    owner = f.open();
  save(owner);
  owner.close();
  f.rows.clear();
  assert.throws(f.open, safe);
  const database = new DatabaseSync(path.join(f.directory, 'checkpoint.sqlite'));
  try {
    assert.equal(database.prepare('SELECT count(*) AS count FROM recovery_state').get().count, 1);
  } finally {
    database.close();
  }
});

test('rejected stale SQLite writes preserve live owner and independent anchor until a later valid request', (t) => {
  const f = fixture(t),
    owner = f.open();
  const expiresAt = Date.now() + 60000;
  save(owner, 0, expiresAt);
  const writes = f.writes();
  assert.throws(() => save(owner, 0, expiresAt), safe);
  assert.equal(f.writes(), writes, 'rejected transaction must not acknowledge or advance anchor');
  const loaded = owner.execute({ operation: 'load', scope });
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.state.calls, 4);
  assert.equal(loaded.expiresAt, expiresAt);
  assert.deepEqual(owner.execute({ operation: 'sweep' }), { removedRecords: 0, removedBytes: 0 });
  assert.equal(save(owner, 1, expiresAt).revision, 2);
});

test('capacity rejection preserves all four acknowledged states and permits a later valid update', (t) => {
  const f = fixture(t),
    owner = f.open();
  const expiresAt = Date.now() + 60000;
  const requests = ['a', 'b', 'c', 'd'].map((letter, index) => ({
    operation: 'save',
    scope: letter.repeat(64),
    expectedRevision: 0,
    expiresAt,
    state: { synthetic: index },
  }));
  for (const request of requests) assert.equal(owner.execute(request).revision, 1);
  const retained = globalThis.structuredClone([...f.rows]);
  const writes = f.writes();
  assert.throws(() => owner.execute({ ...requests[0], scope: 'e'.repeat(64) }), safe);
  assert.equal(f.writes(), writes);
  assert.deepEqual(
    [...f.rows],
    retained,
    'rejected transaction must leave retained anchor unchanged'
  );
  assert.equal(owner.execute({ operation: 'inspect' }).records, 4);
  for (const request of requests) {
    const loaded = owner.execute({ operation: 'load', scope: request.scope });
    assert.equal(loaded.revision, 1);
    assert.equal(loaded.expiresAt, expiresAt);
    assert.deepEqual({ ...loaded.state }, request.state);
  }
  assert.equal(owner.execute({ ...requests[0], expectedRevision: 1 }).revision, 2);
  owner.close();
  const reopened = f.open();
  assert.equal(reopened.execute({ operation: 'inspect' }).records, 4);
  assert.equal(reopened.execute({ operation: 'load', scope: requests[0].scope }).revision, 2);
});

test('production owner combines startup and format sealing while retaining independent snapshot and anchor ACK', (t) => {
  const f = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  const events = [];
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (['BEGIN IMMEDIATE', 'BEGIN', 'COMMIT'].includes(sql)) {
      const file = this.prepare('PRAGMA database_list')
        .all()
        .find((row) => row.name === 'main')?.file;
      if (file && path.basename(file) === 'checkpoint.sqlite') {
        events.push({ sql, version: this.prepare('PRAGMA user_version').get().user_version });
      }
    }
    return Reflect.apply(exec, this, [sql]);
  });
  const owner = f.open();
  assert.deepEqual(events, [
    { sql: 'BEGIN IMMEDIATE', version: 0 },
    { sql: 'COMMIT', version: 3 },
    { sql: 'BEGIN', version: 3 },
    { sql: 'COMMIT', version: 3 },
  ]);
  assert.equal(
    f.writes(),
    2,
    'initial intent and final independent snapshot both require anchor ACK'
  );
  owner.close();
  events.length = 0;
  const reopened = f.open();
  assert.deepEqual(events, [
    { sql: 'BEGIN IMMEDIATE', version: 3 },
    { sql: 'COMMIT', version: 3 },
    { sql: 'BEGIN', version: 3 },
    { sql: 'COMMIT', version: 3 },
  ]);
  assert.equal(f.writes(), 3);
  reopened.close();
});

test('default production owner durably anchors a byte-unchanged scan and closes on failed anchor ACK', (t) => {
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  const f = fixture(t),
    owner = f.open();
  const file = path.join(f.directory, 'checkpoint.sqlite');
  const before = fs.readFileSync(file),
    writes = f.writes();
  time = 1010;
  assert.deepEqual(owner.execute({ operation: 'scan-reference', after: null }), {
    catalog: [],
    scope: null,
    record: null,
  });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.writes(), writes + 1);
  const anchored = [...f.rows.values()][0].value;
  assert.equal(anchored.version, 2);
  assert.equal(anchored.maxTime, time);
  assert.match(anchored.headerTag, /^[a-f0-9]{64}$/);
  let expectedWrites = writes + 1;
  for (const operation of ['load', 'load-reference', 'inspect']) {
    time++;
    const result = owner.execute(
      operation === 'inspect' ? { operation } : { operation, scope: 'a'.repeat(64) }
    );
    assert.deepEqual(result, operation === 'inspect' ? { records: 0, bytes: 0 } : null);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(f.writes(), ++expectedWrites);
    assert.equal([...f.rows.values()][0].value.maxTime, time);
  }
  time = 1020;
  f.failNext();
  assert.throws(() => owner.execute({ operation: 'scan-reference', after: null }), safe);
  assert.throws(() => owner.execute({ operation: 'scan-reference', after: null }), safe);
  assert.deepEqual(fs.readFileSync(file), before);
  f.restoreBackend();
  const reopened = f.open();
  assert.deepEqual(reopened.execute({ operation: 'scan-reference', after: null }), {
    catalog: [],
    scope: null,
    record: null,
  });
});
