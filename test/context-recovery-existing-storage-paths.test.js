'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');

const safe = { code: 'context_recovery_storage_unavailable' };
const identity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
};
function load(relative, replacements) {
  const filename = require.resolve(relative);
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  const factory = vm.runInThisContext(
    `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  factory(
    (name) => (Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name)),
    module,
    module.exports
  );
  return module.exports;
}
function fixture(t, onSecure) {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-existing-paths-'));
  const directory = path.join(root, 'store');
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compoundCalls = [],
    secured = [];
  const paths = load('../lib/proxy/context-recovery-storage-paths', {
    './context-recovery-private-path': {
      secureRecoveryStoragePath(file, kind) {
        secured.push({ file, kind });
        onSecure?.(file, kind);
      },
      prepareRecoveryStorageDirectory(file, dispatch) {
        compoundCalls.push(file);
        dispatch();
        const writer = path.join(file, '.writer.sqlite');
        if (!fs.existsSync(writer)) fs.writeFileSync(writer, '');
        return { directory: identity(file), writer: identity(writer) };
      },
    },
  });
  return { root, directory, paths, compoundCalls, secured };
}

for (const disappear of [false, true])
  test(
    'offline enrollment cannot create a missing writer or vanished directory: ' + disappear,
    (t) => {
      const f = fixture(t);
      let removed = false;
      const owner = load('../lib/proxy/context-recovery-anchor-legacy-owner', {
        './context-recovery-storage-paths': f.paths,
        'node:fs': {
          ...fs,
          lstatSync(file, ...args) {
            const stat = fs.lstatSync(file, ...args);
            if (disappear && file === f.directory && !removed) {
              removed = true;
              fs.rmdirSync(file);
            }
            return stat;
          },
        },
      });
      let protectedCalls = 0;
      const denied = () => {
        protectedCalls++;
        throw Error('synthetic offline dependency must not run');
      };
      assert.throws(
        () =>
          owner.runLegacyAnchorEnrollment(
            { directory: f.directory },
            { protectKey: denied, createAnchorRepository: denied, inspectSnapshot: denied }
          ),
        safe
      );
      assert.equal(fs.existsSync(path.join(f.directory, '.writer.sqlite')), false);
      assert.equal(fs.existsSync(f.directory), !disappear);
      assert.equal(f.compoundCalls.length, 0);
      assert.equal(protectedCalls, 0);
    }
  );

test('existing-only capability retains exact ACL and identity checks without creation methods', (t) => {
  const f = fixture(t);
  const writer = path.join(f.directory, '.writer.sqlite');
  const key = path.join(f.directory, '.data-key');
  fs.writeFileSync(writer, 'synthetic writer bytes');
  fs.writeFileSync(key, 'synthetic wrapped key');
  const before = identity(writer);
  const paths = f.paths.createExistingStoragePaths(f.directory);
  assert.deepEqual(Object.keys(paths).sort(), ['directory', 'pinExisting', 'pinKey', 'verify']);
  assert(Object.isFrozen(paths));
  assert.equal(paths.pinExisting('.writer.sqlite'), writer);
  assert.equal(paths.pinKey(), 'synthetic wrapped key');
  paths.verify();
  assert.deepEqual(identity(writer), before);
  assert.equal(fs.readFileSync(writer, 'utf8'), 'synthetic writer bytes');
  assert.deepEqual(f.compoundCalls, []);
  assert.deepEqual(
    f.secured.map(({ kind }) => kind),
    ['directory', 'file', 'file']
  );
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['.data-key', '.writer.sqlite']);
});

test('existing-only capability refuses missing, invalid and oversized entries without replacement', (t) => {
  const f = fixture(t);
  for (const input of [null, '', 'relative', path.join(f.root, 'absent')])
    assert.throws(() => f.paths.createExistingStoragePaths(input), safe);
  assert.equal(fs.existsSync(path.join(f.root, 'absent')), false);
  const paths = f.paths.createExistingStoragePaths(f.directory);
  for (const name of ['.writer.sqlite', '../escape', 'unknown'])
    assert.throws(() => paths.pinExisting(name), safe);
  assert.throws(() => paths.pinKey(), safe);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const writer = path.join(f.directory, '.writer.sqlite');
  fs.writeFileSync(writer, Buffer.alloc(1048577));
  assert.throws(() => f.paths.createExistingStoragePaths(f.directory), safe);
  assert.equal(fs.statSync(writer).size, 1048577);
  assert.deepEqual(f.compoundCalls, []);
});

test('existing-only capability rejects replaced identities and hardlinks with original bytes retained', (t) => {
  const f = fixture(t);
  const writer = path.join(f.directory, '.writer.sqlite');
  fs.writeFileSync(writer, 'synthetic retained');
  const paths = f.paths.createExistingStoragePaths(f.directory);
  paths.pinExisting('.writer.sqlite');
  const original = path.join(f.root, 'original');
  fs.renameSync(writer, original);
  fs.writeFileSync(writer, 'synthetic replacement');
  assert.throws(() => paths.verify(), safe);
  fs.unlinkSync(writer);
  fs.linkSync(original, writer);
  assert.throws(() => f.paths.createExistingStoragePaths(f.directory), safe);
  assert.equal(fs.readFileSync(original, 'utf8'), 'synthetic retained');
  assert.deepEqual(f.compoundCalls, []);
});

test('existing-only ACL failures never dispatch creation or replace retained files', (t) => {
  const f = fixture(t, () => {
    throw Error('synthetic private ACL failure');
  });
  const writer = path.join(f.directory, '.writer.sqlite');
  fs.writeFileSync(writer, 'synthetic unchanged');
  assert.throws(() => f.paths.createExistingStoragePaths(f.directory), safe);
  assert.deepEqual(f.compoundCalls, []);
  assert.equal(fs.readFileSync(writer, 'utf8'), 'synthetic unchanged');
  assert.deepEqual(fs.readdirSync(f.directory), ['.writer.sqlite']);
});
