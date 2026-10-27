'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, 'helpers/installed-fixture-cleanup.js'),
  'utf8'
);
const bad = { message: 'installed_fixture_cleanup_failed' };
function fixture(t, remove, prefix = 'hpm-installed-boundary-') {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  t.after(() => {
    for (const file of [directory, directory + '-original'])
      fs.rmSync(file, { recursive: true, force: true });
  });
  const delays = [],
    calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    require(name) {
      if (name === 'node:fs')
        return {
          ...fs,
          rmSync(file, options) {
            assert.equal(file, directory);
            assert.equal(options.recursive, true);
            assert.equal(options.force, true);
            calls.push(file);
            return remove(file, options, calls.length);
          },
        };
      return require(name);
    },
    setTimeout(resolve, delay) {
      delays.push(delay);
      queueMicrotask(resolve);
    },
  });
  return {
    directory,
    delays,
    calls,
    create: module.exports.createInstalledFixtureCleanup,
    createOwner: module.exports.createPhysicalOwnerFixtureCleanup,
  };
}

test('physical owner cleanup waits out only bounded ENOTEMPTY and verifies actual removal', async (t) => {
  const f = fixture(
    t,
    (file, options, attempt) => {
      if (attempt < 3) throw Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOTEMPTY' });
      fs.rmSync(file, options);
    },
    'hpm-v7-owner-'
  );
  await f.createOwner(f.directory)();
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.delays, [75, 75]);
});

test('physical owner cleanup rejects foreign prefixes and preserves persistent failure evidence', async (t) => {
  const f = fixture(
    t,
    () => {
      throw Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOTEMPTY' });
    },
    'hpm-v7-owner-'
  );
  const foreign = fixture(t, () => assert.fail('foreign removal'));
  for (const input of [
    null,
    '',
    '.',
    os.tmpdir(),
    path.dirname(f.directory),
    path.join(f.directory, 'nested'),
    f.directory + '/..',
    f.directory + '\0',
    foreign.directory,
  ])
    assert.throws(() => f.createOwner(input), bad);
  fs.writeFileSync(path.join(f.directory, 'evidence'), 'synthetic');
  await assert.rejects(f.createOwner(f.directory)(), bad);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.delays, [75, 75, 75]);
  assert.equal(fs.readFileSync(path.join(f.directory, 'evidence'), 'utf8'), 'synthetic');
});

test('transient Windows busy locks are retried only for the same pinned directory and actual removal is verified', async (t) => {
  const f = fixture(t, (file, options, attempt) => {
    if (attempt < 3) throw Object.assign(new Error('PRIVATE_NATIVE_PATH'), { code: 'EBUSY' });
    fs.rmSync(file, options);
  });
  const cleanup = f.create(f.directory);
  await cleanup();
  await cleanup();
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.delays, [75, 75]);
});

test('persistent image lock still fails after four attempts and keeps evidence', async (t) => {
  const f = fixture(t, () => {
    throw Object.assign(new Error('PRIVATE_NATIVE_PATH'), { code: 'EBUSY' });
  });
  fs.writeFileSync(path.join(f.directory, 'evidence'), 'synthetic');
  await assert.rejects(f.create(f.directory)(), bad);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.delays, [75, 75, 75]);
  assert.equal(fs.readFileSync(path.join(f.directory, 'evidence'), 'utf8'), 'synthetic');
});

test('directory replacement between attempts never permits deletion of its replacement', async (t) => {
  const f = fixture(t, (file) => {
    fs.renameSync(file, file + '-original');
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'preserved'), 'synthetic');
    throw Object.assign(new Error('PRIVATE'), { code: 'EBUSY' });
  });
  await assert.rejects(f.create(f.directory)(), bad);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.directory, 'preserved'), 'utf8'), 'synthetic');
});

test('unknown errors, malicious error fields and false deletion success fail without retries or disclosure', async (t) => {
  let traps = 0;
  const errors = [
    new Error('PRIVATE'),
    Object.assign(new Error('PRIVATE'), { code: 'EIO' }),
    Object.defineProperty({}, 'code', {
      get() {
        traps++;
        return 'EBUSY';
      },
    }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          traps++;
          return undefined;
        },
      }
    ),
  ];
  for (const error of errors) {
    const f = fixture(t, () => {
      throw error;
    });
    await assert.rejects(f.create(f.directory)(), bad);
    assert.equal(f.calls.length, 1);
    assert.equal(f.delays.length, 0);
  }
  const f = fixture(t, () => {});
  await assert.rejects(f.create(f.directory)(), bad);
  assert.equal(f.calls.length, 1);
  assert.equal(traps, 0);
});

test('cleanup admits only the owned physical fixture root and refuses empty, foreign and nested targets', (t) => {
  const f = fixture(t, () => {
    throw new Error('must_not_delete');
  });
  for (const directory of [
    null,
    '',
    '.',
    os.tmpdir(),
    path.dirname(f.directory),
    path.join(f.directory, 'nested'),
    f.directory + '/..',
    f.directory + '\0',
  ])
    assert.throws(() => f.create(directory), bad);
  assert.equal(f.calls.length, 0);
});
