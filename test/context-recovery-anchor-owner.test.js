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

test('interrupted initial startup retains empty intent and permits same-storeId retry without data loss', (t) => {
  const f = fixture(t);
  // Initial empty intent succeeds; the final startup watermark fails.
  // The owner must not return ready, and the next owner must reconcile it.
  const ordinaryOpen = f.open;
  f.failAfter(2);
  assert.throws(ordinaryOpen, safe);
  assert.equal(f.rows.size, 1);
  f.restoreBackend();
  const owner = f.open();
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
