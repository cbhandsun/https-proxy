'use strict';
// Pure filesystem fixture. The ACL/native boundary is replaced before module load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-storage-identity-pure-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hpm-storage-identity-pure-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ids = new Map();
  let duringRead;
  let bigintReads = 0;
  function preciseStat(actual, options) {
    const key = `${actual.dev}:${actual.ino}`;
    if (!ids.has(key)) ids.set(key, (1n << 60n) + BigInt(ids.size));
    const precise = options?.bigint === true;
    if (precise) bigintReads++;
    // Distinct 64-bit IDs intentionally collide as JavaScript numbers.
    return Object.assign(actual, {
      dev: precise ? 1n : 1,
      ino: precise ? ids.get(key) : Number(ids.get(key)),
      birthtimeMs: precise ? 1000n : 1000,
      ...(precise ? { birthtimeNs: 1000000000n } : {}),
    });
  }
  const fileSystem = {
    ...fs,
    lstatSync(file, options) {
      return preciseStat(fs.lstatSync(file, options), options);
    },
    fstatSync(fd, options) {
      return preciseStat(fs.fstatSync(fd, options), options);
    },
    readSync(...args) {
      const result = fs.readSync(...args);
      const callback = duringRead;
      duringRead = undefined;
      callback?.();
      return result;
    },
  };
  const filename = path.resolve(__dirname, '../lib/proxy/context-recovery-storage-paths.js');
  const localRequire = createRequire(filename);
  const loaded = { exports: {} };
  const factory = vm.runInThisContext(
    `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  factory(
    (name) => {
      if (name === 'node:fs') return fileSystem;
      if (name === './context-recovery-private-path')
        return { secureRecoveryStoragePath: (file) => file };
      return localRequire(name);
    },
    loaded,
    loaded.exports
  );
  const directory = path.join(root, 'storage');
  const paths = loaded.exports.createStoragePaths(directory);
  return {
    root,
    directory,
    paths,
    onRead(callback) {
      duringRead = callback;
    },
    bigintReads: () => bigintReads,
  };
}

test('precise storage identity rejects replacement with equal bytes and colliding numeric file IDs during read', (t) => {
  assert.equal(Number((1n << 60n) + 1n), Number((1n << 60n) + 2n));
  const f = fixture(t);
  f.paths.writeKey('synthetic-wrapped-fixture');
  f.paths.verify();
  f.onRead(() => {
    const key = path.join(f.directory, '.data-key');
    fs.renameSync(key, path.join(f.root, 'prior-key'));
    fs.writeFileSync(key, 'synthetic-wrapped-fixture');
  });
  assert.throws(
    () => f.paths.verify(),
    (error) => {
      assert.equal(error.code, 'context_recovery_storage_unavailable');
      assert.equal(error.message, error.code);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
  assert.throws(() => f.paths.prepare('checkpoint.sqlite'));
});

test('precise storage stats preserve key write, readback, pinning, file sizes and inventory limits', (t) => {
  const f = fixture(t);
  assert.equal(f.paths.writeKey('synthetic-wrapped-fixture'), 'synthetic-wrapped-fixture');
  assert.equal(f.paths.pinKey(), 'synthetic-wrapped-fixture');
  assert.equal(f.paths.read('.data-key').toString(), 'synthetic-wrapped-fixture');
  const writer = f.paths.prepare('.writer.sqlite');
  assert.equal(f.paths.pinExisting('.writer.sqlite'), writer);
  assert.equal(f.paths.read('.writer.sqlite').length, 0);
  assert.equal(f.paths.exists('.writer.sqlite'), true);
  assert.equal(f.paths.exists('checkpoint.sqlite'), false);
  f.paths.verify();
  assert.ok(f.bigintReads() > 0);
  fs.writeFileSync(path.join(f.directory, '.data-key'), 'x'.repeat(17001));
  assert.throws(() => f.paths.verify());
});

test('precise identities reject replacing pinned database or ancestor with colliding numeric IDs', (t) => {
  for (const mode of ['database', 'directory']) {
    const f = fixture(t);
    const writer = f.paths.prepare('.writer.sqlite');
    f.paths.verify();
    if (mode === 'database') {
      fs.renameSync(writer, path.join(f.root, 'prior-writer'));
      fs.writeFileSync(writer, '');
    } else {
      fs.renameSync(f.directory, path.join(f.root, 'prior-directory'));
      fs.mkdirSync(f.directory);
      fs.writeFileSync(path.join(f.directory, '.writer.sqlite'), '');
    }
    assert.throws(() => f.paths.verify(), /^Error: context_recovery_storage_unavailable$/);
    assert.throws(() => f.paths.prepare('checkpoint.sqlite'));
  }
});

test('precise stats retain hardlink and same-inode content tampering rejection', (t) => {
  for (const mode of ['hardlink', 'content', 'size']) {
    const f = fixture(t);
    f.paths.writeKey('synthetic-wrapped-fixture');
    const key = path.join(f.directory, '.data-key');
    if (mode === 'hardlink') fs.linkSync(key, path.join(f.root, 'linked-key'));
    if (mode === 'content') fs.writeFileSync(key, 'synthetic-wrapped-changed');
    if (mode === 'size') f.onRead(() => fs.appendFileSync(key, 'longer'));
    assert.throws(() => f.paths.verify(), /^Error: context_recovery_storage_unavailable$/);
  }
});
