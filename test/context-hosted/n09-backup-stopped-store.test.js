'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createStoppedStoreBackup,
} = require('../../scripts/context-hosted/n09-backup/stopped-store-backup');

const safe = (error) => error?.message === 'n09_stopped_store_backup_failed';
function fixture(t) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const ownedRoot = fs.mkdtempSync(path.join(temporary, 'n09-stopped-backup-'));
  const runtimeDir = path.join(ownedRoot, 'runtime');
  const store = path.join(runtimeDir, 'context-recovery-v1');
  fs.mkdirSync(store, { recursive: true });
  const database = path.join(store, 'checkpoint.sqlite');
  const key = path.join(store, '.data-key');
  const anchor = path.join(ownedRoot, 'independent-anchor-sentinel');
  fs.writeFileSync(database, 'synthetic encrypted database baseline');
  fs.writeFileSync(key, 'synthetic wrapped key baseline');
  fs.writeFileSync(anchor, 'synthetic current independent anchor');
  const original = [fs.readFileSync(database), fs.readFileSync(key)];
  const state = { stopped: true, calls: 0 };
  const options = { ownedRoot, runtimeDir };
  const backup = createStoppedStoreBackup(options, () => {
    state.calls++;
    return state.stopped;
  });
  t.after(() => {
    backup.close();
    assert.equal(path.dirname(ownedRoot), temporary);
    assert.equal(fs.realpathSync.native(ownedRoot), ownedRoot);
    assert.ok(path.basename(ownedRoot).startsWith('n09-stopped-backup-'));
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  return { backup, options, state, store, database, key, anchor, original };
}

test('stopped backup restores exact two files, retaining identities and independent anchor', (t) => {
  const f = fixture(t);
  assert.equal(f.state.calls, 0, 'construction must be passive');
  const before = [f.database, f.key].map((file) => fs.statSync(file).ino);
  assert.deepEqual(f.backup.capture(), {
    encryptedFilesCaptured: 2,
    independentAnchorCaptured: false,
  });
  fs.writeFileSync(f.database, 'different synthetic revocation state, deliberately longer');
  fs.writeFileSync(f.key, 'different synthetic key');
  fs.writeFileSync(f.anchor, 'later independent anchor');
  assert.deepEqual(f.backup.restore(), {
    encryptedFilesRestored: 2,
    independentAnchorRestored: false,
  });
  for (const [index, file] of [f.database, f.key].entries()) {
    assert.equal(fs.readFileSync(file).equals(f.original[index]), true);
    assert.equal(fs.statSync(file).ino, before[index]);
  }
  assert.equal(fs.readFileSync(f.anchor, 'utf8'), 'later independent anchor');
  assert.deepEqual(fs.readdirSync(f.store).sort(), ['.data-key', 'checkpoint.sqlite']);
  assert.throws(() => f.backup.restore(), safe);
});

test('live or unacknowledged owner cannot capture or restore and writes no files', (t) => {
  for (const value of [false, null, undefined, {}, Promise.resolve(true)]) {
    const f = fixture(t);
    f.state.stopped = value;
    assert.throws(() => f.backup.capture(), safe);
    assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
  }
  const f = fixture(t);
  f.backup.capture();
  fs.writeFileSync(f.database, 'current encrypted state');
  f.state.stopped = false;
  assert.throws(() => f.backup.restore(), safe);
  assert.equal(fs.readFileSync(f.database, 'utf8'), 'current encrypted state');
  f.state.stopped = true;
  assert.throws(() => f.backup.restore(), safe, 'failed fixture is never reused');
});

test('stopped backup rejects malformed input and executable capabilities without evaluation', (t) => {
  const f = fixture(t);
  let evaluated = 0;
  const getter = Object.defineProperty({}, 'ownedRoot', {
    get() {
      evaluated++;
      return '';
    },
  });
  const proxied = new Proxy(
    {},
    {
      ownKeys() {
        evaluated++;
        return [];
      },
    }
  );
  const callbackProxy = new Proxy(() => true, {
    apply() {
      evaluated++;
      return true;
    },
  });
  for (const input of [
    undefined,
    null,
    [],
    {},
    getter,
    proxied,
    { ...f.options, extra: true },
    { ...f.options, runtimeDir: f.options.ownedRoot },
    { ...f.options, runtimeDir: path.dirname(f.options.ownedRoot) },
    { ...f.options, runtimeDir: 'relative' },
    { ...f.options, ownedRoot: 'x'.repeat(4097) },
  ]) {
    assert.throws(() => createStoppedStoreBackup(input, () => true), safe);
  }
  for (const callback of [undefined, false, {}, callbackProxy, async () => true, function* () {}])
    assert.throws(() => createStoppedStoreBackup(f.options, callback), safe);
  assert.equal(evaluated, 0);
  const rejected = createStoppedStoreBackup(f.options, () => {
    throw new Error('PRIVATE_CALLBACK_SENTINEL');
  });
  assert.throws(() => rejected.capture(), safe);
});

test('stopped backup rejects empty, missing and oversized encrypted files', (t) => {
  for (const [name, bytes] of [
    ['checkpoint.sqlite', 0],
    ['checkpoint.sqlite', 1024 * 1024 + 1],
    ['.data-key', 0],
    ['.data-key', 17001],
  ]) {
    const f = fixture(t);
    fs.truncateSync(path.join(f.store, name), bytes);
    assert.throws(() => f.backup.capture(), safe);
  }
  const f = fixture(t);
  fs.unlinkSync(f.key);
  assert.throws(() => f.backup.capture(), safe);
});

test('every SQLite journal is rejected before capture and before restore', (t) => {
  for (const name of [
    'checkpoint.sqlite-journal',
    'checkpoint.sqlite-wal',
    'checkpoint.sqlite-shm',
    '.writer.sqlite-journal',
    '.writer.sqlite-wal',
    '.writer.sqlite-shm',
  ]) {
    for (const phase of ['capture', 'restore']) {
      const f = fixture(t);
      if (phase === 'restore') f.backup.capture();
      fs.writeFileSync(path.join(f.store, name), 'synthetic journal');
      assert.throws(() => f.backup[phase](), safe);
      assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
    }
  }
});

test('replacement, hardlink and directory aliases reject before restoring either target', (t) => {
  for (const name of ['checkpoint.sqlite', '.data-key']) {
    const f = fixture(t);
    f.backup.capture();
    const target = path.join(f.store, name);
    fs.renameSync(target, target + '.original');
    fs.writeFileSync(target, 'replacement file');
    const before = [f.database, f.key].map((file) => fs.readFileSync(file));
    assert.throws(() => f.backup.restore(), safe);
    for (const [index, file] of [f.database, f.key].entries())
      assert.equal(fs.readFileSync(file).equals(before[index]), true);
  }
  const linked = fixture(t);
  fs.linkSync(linked.key, path.join(linked.store, 'second-key-link'));
  assert.throws(() => linked.backup.capture(), safe);
  const aliased = fixture(t);
  const other = path.join(aliased.options.ownedRoot, 'other-store');
  fs.renameSync(aliased.store, other);
  fs.symlinkSync(other, aliased.store, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => aliased.backup.capture(), safe);
});

test('partial restore failure remains failed, closes descriptors and cannot be retried', (t) => {
  const f = fixture(t);
  f.backup.capture();
  fs.writeFileSync(f.database, 'changed database');
  let closes = 0;
  const originalClose = fs.closeSync;
  t.mock.method(fs, 'closeSync', (fd) => {
    closes++;
    return originalClose(fd);
  });
  t.mock.method(fs, 'fsyncSync', () => {
    throw new Error('PRIVATE_IO_SENTINEL');
  });
  assert.throws(() => f.backup.restore(), safe);
  assert.equal(closes, 2);
  assert.throws(() => f.backup.restore(), safe);
  assert.equal(fs.readFileSync(f.anchor, 'utf8'), 'synthetic current independent anchor');
  t.mock.restoreAll();
});

test('capture is single-use and close prevents further filesystem operations', (t) => {
  const f = fixture(t);
  assert.throws(() => f.backup.restore(), safe);
  f.backup.capture();
  assert.throws(() => f.backup.capture(), safe);
  f.backup.close();
  f.backup.close();
  const before = f.state.calls;
  assert.throws(() => f.backup.capture(), safe);
  assert.throws(() => f.backup.restore(), safe);
  assert.equal(f.state.calls, before);
});

test('unexpected rejected promise from a synchronous stop witness is drained and rejected', async (t) => {
  const f = fixture(t);
  const backup = createStoppedStoreBackup(f.options, () =>
    Promise.reject(new Error('PRIVATE_STOP_SENTINEL'))
  );
  assert.throws(() => backup.capture(), safe);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
  backup.close();
});
