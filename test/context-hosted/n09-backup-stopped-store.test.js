'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
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

test('data journals and arbitrary ownership journals reject before capture and restore', (t) => {
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

function inertMutex(f, bytes = 512) {
  const mutex = path.join(f.store, '.writer.sqlite');
  const journal = path.join(f.store, '.writer.sqlite-journal');
  const header = Buffer.alloc(bytes);
  header.writeUInt32BE(123, 12);
  header.writeUInt32BE(bytes, 20);
  header.writeUInt32BE(4096, 24);
  fs.writeFileSync(mutex, Buffer.alloc(0));
  fs.writeFileSync(journal, header);
  return { mutex, journal, header };
}

test('only an inert empty-owner journal is preserved without copying or repairing it', (t) => {
  for (const bytes of [512, 4096, 65536]) {
    const f = fixture(t);
    const m = inertMutex(f, bytes);
    const inode = fs.statSync(m.journal).ino;
    f.backup.capture();
    fs.writeFileSync(f.database, 'later encrypted state');
    f.backup.restore();
    assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
    assert.equal(fs.readFileSync(m.journal).equals(m.header), true);
    assert.equal(fs.statSync(m.journal).ino, inode);
    assert.equal(fs.statSync(m.mutex).size, 0);
  }
});

test('hot, populated, malformed, missing and oversized owner journals remain rejected', (t) => {
  const changes = [
    (m) => fs.writeFileSync(m.mutex, 'nonempty ownership database'),
    (m) => fs.unlinkSync(m.mutex),
    (m) => fs.truncateSync(m.journal, 0),
    (m) => fs.truncateSync(m.journal, 511),
    (m) => fs.truncateSync(m.journal, 65537),
    ...[0, 8, 16, 20, 24, 28].map((offset) => (m) => {
      m.header.writeUInt32BE(1, offset);
      fs.writeFileSync(m.journal, m.header);
    }),
  ];
  for (const change of changes) {
    for (const phase of ['capture', 'restore']) {
      const f = fixture(t);
      const m = inertMutex(f);
      if (phase === 'restore') f.backup.capture();
      change(m);
      assert.throws(() => f.backup[phase](), safe);
      assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
    }
  }
});

test('owner journal links, replacement and mutation during backup reject safely', (t) => {
  for (const name of ['mutex', 'journal']) {
    const f = fixture(t);
    const m = inertMutex(f);
    fs.linkSync(m[name], path.join(f.store, 'owner-extra-link'));
    assert.throws(() => f.backup.capture(), safe);
  }
  for (const replacement of [false, true]) {
    const f = fixture(t);
    const m = inertMutex(f);
    let calls = 0;
    const backup = createStoppedStoreBackup(f.options, () => {
      if (++calls === 2) {
        if (replacement) fs.renameSync(m.journal, m.journal + '.previous');
        m.header.writeUInt32BE(456, 12);
        fs.writeFileSync(m.journal, m.header);
      }
      return true;
    });
    assert.throws(() => backup.capture(), safe);
    assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
    backup.close();
  }
});

async function killEmptyMutex(f) {
  const child = fork(
    path.join(__dirname, '../helpers/n09-stopped-mutex.cjs'),
    [path.join(f.store, '.writer.sqlite')],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], windowsHide: true }
  );
  let exited = false;
  const exit = new Promise((resolve) =>
    child.once('close', () => {
      exited = true;
      resolve();
    })
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mutex_child_not_ready')), 10000);
      child.once('message', (message) => {
        clearTimeout(timer);
        if (message?.ready === true) resolve();
        else reject(new Error('mutex_child_not_ready'));
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('mutex_child_not_ready'));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('mutex_child_exited'));
      });
    });
  } finally {
    if (!exited) child.kill('SIGKILL');
    await exit;
  }
}

test(
  'real SQLite forced exits preserve inert mutex journals across backup, restart and restore',
  { timeout: 25000 },
  async (t) => {
    const f = fixture(t);
    await killEmptyMutex(f);
    const journal = path.join(f.store, '.writer.sqlite-journal');
    const first = fs.readFileSync(journal);
    f.backup.capture();
    assert.equal(fs.readFileSync(journal).equals(first), true);
    await killEmptyMutex(f);
    const current = fs.readFileSync(journal);
    fs.writeFileSync(f.database, 'current encrypted state after second owner');
    f.backup.restore();
    assert.equal(fs.readFileSync(journal).equals(current), true);
    assert.equal(fs.readFileSync(f.database).equals(f.original[0]), true);
    await killEmptyMutex(f);
  }
);

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
