'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = ['checkpoint.sqlite', '.data-key'];

function isolateBackupRollbackEnvironment(t) {
  const { createIsolatedTestEnv } = require('../../lib/test-runtime');
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-backup-rollback-'));
  const previous = { ...process.env };
  const isolated = createIsolatedTestEnv(previous, root);
  for (const key of Object.keys(isolated)) {
    if (key.toUpperCase() === 'WORKBUDDY_CONFIG_DIR') delete isolated[key];
  }
  isolated.WORKBUDDY_CONFIG_DIR = path.join(root, 'workbuddy');
  isolated.PROXY_DATA_DIR = path.join(root, 'data');
  isolated.PROXY_CERT_DIR = path.join(root, 'certs');
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated);
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    // Keep the exact mkdtemp owner identity; no caller-supplied deletion target.
    assert.equal(path.dirname(root), temporary);
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('hpm-backup-rollback-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function createBackupRollbackFixture(t, root, label) {
  assert.ok(['control', 'rollback'].includes(label));
  const parent = path.join(root, label);
  fs.mkdirSync(parent, { mode: 0o700 });
  const store = path.join(parent, 'store');
  const backup = path.join(parent, 'backup');
  let owner;
  let receipt;
  function ownedFile(directory, name) {
    assert.ok(files.includes(name));
    assert.ok(directory === store || directory === backup);
    assert.equal(path.dirname(directory), parent);
    assert.equal(fs.realpathSync.native(directory), directory);
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.ok(stat.size > 0 && stat.size <= 1024 * 1024);
    return file;
  }
  function closedStore() {
    assert.equal(owner, undefined, 'backup/restore requires an acknowledged closed worker');
    for (const name of [
      'checkpoint.sqlite-journal',
      'checkpoint.sqlite-wal',
      '.writer.sqlite-journal',
    ])
      assert.equal(
        fs.existsSync(path.join(store, name)),
        false,
        'closed-store backup must not omit a live SQLite journal'
      );
  }
  async function close() {
    if (!owner) return;
    // Production close resolves only after close ACK and clean worker exit.
    await owner.close();
    owner = undefined;
  }
  t.after(close);
  return {
    async open() {
      assert.equal(owner, undefined);
      const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
      // No WorkerType/protectKey override: actual CurrentUser DPAPI and OS owner.
      owner = await openContextRecoveryStorage({ directory: store });
      return owner;
    },
    close,
    snapshot() {
      closedStore();
      fs.mkdirSync(backup, { mode: 0o700 });
      receipt = files.map((name) => {
        const source = ownedFile(store, name);
        const bytes = fs.readFileSync(source);
        const target = path.join(backup, name);
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        assert.equal(digest(fs.readFileSync(ownedFile(backup, name))), digest(bytes));
        return { name, digest: digest(bytes) };
      });
      return { files: receipt.map((entry) => entry.name) };
    },
    restore() {
      closedStore();
      assert.equal(receipt?.length, 2);
      for (const entry of receipt) {
        const source = ownedFile(backup, entry.name);
        const target = ownedFile(store, entry.name);
        const bytes = fs.readFileSync(source);
        assert.equal(digest(bytes), entry.digest);
        // Overwrite only the two existing owned files, preserving their ACL and
        // inode. Never restore a live lock or replace the storage directory.
        const descriptor = fs.openSync(target, 'r+');
        try {
          const stat = fs.fstatSync(descriptor);
          const current = fs.lstatSync(target);
          assert.equal(stat.dev, current.dev);
          assert.equal(stat.ino, current.ino);
          assert.equal(stat.nlink, 1);
          fs.ftruncateSync(descriptor, 0);
          fs.writeFileSync(descriptor, bytes);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        assert.equal(digest(fs.readFileSync(target)), entry.digest);
      }
    },
    wrappedKeyDigest() {
      const bytes = fs.readFileSync(ownedFile(store, '.data-key'));
      const { KEY_PREFIX } = require('../../lib/proxy/context-recovery-key-contract');
      assert.ok(bytes.toString('utf8').startsWith(KEY_PREFIX), 'expected a DPAPI-wrapped key');
      return digest(bytes);
    },
  };
}

module.exports = { isolateBackupRollbackEnvironment, createBackupRollbackFixture, digest };
