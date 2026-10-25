'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { createRequire } = require('node:module');
const phases = [
  'key_file_open_started',
  'key_file_opened',
  'key_acl_started',
  'key_acl_finished',
  'key_file_write_started',
  'key_file_write_finished',
  'key_file_flush_started',
  'key_file_flush_finished',
  'key_file_closed',
  'key_file_readback_started',
  'key_file_readback_finished',
];
function fixture(t, failure, observer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-key-progress-'));
  const opened = new Set(),
    events = [];
  t.after(() => {
    assert.equal(opened.size, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  let armed = false;
  const fileSystem = { ...fs };
  for (const name of ['openSync', 'writeFileSync', 'fsyncSync', 'readSync', 'closeSync'])
    fileSystem[name] = function (...args) {
      if (armed && failure === name && name !== 'closeSync') throw Error('PRIVATE_SYNTHETIC');
      const result = Reflect.apply(fs[name], fs, args);
      if (name === 'openSync') opened.add(result);
      if (name === 'closeSync') {
        opened.delete(args[0]);
        if (armed && failure === name) throw Error('PRIVATE_SYNTHETIC');
      }
      return result;
    };
  const filename = path.resolve(__dirname, '../lib/proxy/context-recovery-storage-paths.js');
  const localRequire = createRequire(filename),
    loaded = { exports: {} };
  const factory = vm.runInThisContext(
    `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  factory(
    (name) =>
      name === 'node:fs'
        ? fileSystem
        : name === './context-recovery-private-path'
          ? {
              secureRecoveryStoragePath(file) {
                if (armed && failure === 'acl') throw Error('PRIVATE_SYNTHETIC');
                return file;
              },
            }
          : localRequire(name),
    loaded,
    loaded.exports
  );
  const directory = path.join(root, 'store');
  const paths = loaded.exports.createStoragePaths(directory, (event) => {
    events.push(event);
    return observer?.(event);
  });
  armed = true;
  return {
    paths,
    events,
    directory,
    opened,
    clearFailure() {
      failure = undefined;
    },
  };
}
for (const value of ['', 'synthetic wrapped', 'é🙂', 'x'.repeat(17000)])
  test(
    'fixed key write phases preserve exact bytes and return: bytes=' + Buffer.byteLength(value),
    (t) => {
      const f = fixture(t);
      assert.equal(f.paths.writeKey(value), value);
      assert.deepEqual(
        f.events.map((x) => x.phase),
        phases
      );
      assert.ok(
        f.events.every(
          (x, i) =>
            Object.isFrozen(x) &&
            Object.keys(x).join(',') === 'phase,elapsedMs' &&
            Number.isSafeInteger(x.elapsedMs) &&
            x.elapsedMs >= 0 &&
            (!i || x.elapsedMs >= f.events[i - 1].elapsedMs)
        )
      );
      assert.equal(fs.readFileSync(path.join(f.directory, '.data-key'), 'utf8'), value);
      assert.equal(f.paths.pinKey(), value);
      assert.equal(f.events.length, phases.length, 'existing key pin emits no fresh write phases');
      assert.equal(f.opened.size, 0);
    }
  );
for (const [failure, last] of [
  ['openSync', 'key_file_open_started'],
  ['acl', 'key_acl_started'],
  ['writeFileSync', 'key_file_write_started'],
  ['fsyncSync', 'key_file_flush_started'],
  ['closeSync', 'key_file_flush_finished'],
  ['readSync', 'key_file_readback_started'],
])
  test('key write failure retains fixed last phase and closes descriptors: ' + failure, (t) => {
    const f = fixture(t, failure);
    assert.throws(() => f.paths.writeKey('synthetic wrapping'), {
      message: 'context_recovery_storage_unavailable',
      code: 'context_recovery_storage_unavailable',
    });
    assert.equal(f.events.at(-1).phase, last);
    assert.equal(
      f.events.some((x) => x.phase === 'key_file_readback_finished'),
      false
    );
    assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false);
    assert.equal(f.opened.size, 0);
    const { createWorkerStartupEvidence } = require('../scripts/lib/nsis-worker-startup-evidence');
    const evidence = createWorkerStartupEvidence();
    const complete = [
      'worker_started',
      'key_protect_finished',
      'key_write_started',
      ...phases,
      'key_write_finished',
      'database_opened',
      'engine_ready',
      'ready',
    ];
    const {
      createPublicationStartupProgress,
    } = require('./helpers/publication-startup-progress.cjs');
    const timeline = createPublicationStartupProgress();
    for (const phase of complete) {
      evidence.observe({ phase });
      timeline.observe({ phase, elapsedMs: 0 });
    }
    assert.equal(evidence.receipt(false).ready, true);
    assert.equal(timeline.describe().phase, 'ready');
  });
test('key progress observer throws or rejects cannot change durable writes', async (t) => {
  for (const observer of [
    () => {
      throw Error('PRIVATE');
    },
    () => Promise.reject(Error('PRIVATE')),
  ]) {
    const f = fixture(t, undefined, observer);
    assert.equal(f.paths.writeKey('synthetic'), 'synthetic');
    assert.equal(f.events.at(-1).phase, 'key_file_readback_finished');
  }
  await new Promise(setImmediate);
});
test('invalid and oversized wrapping fails before emitting write phases', (t) => {
  for (const value of [null, {}, 'x'.repeat(17001)]) {
    const f = fixture(t);
    assert.throws(() => f.paths.writeKey(value), /context_recovery_storage_unavailable/);
    assert.deepEqual(f.events, []);
    assert.equal(fs.existsSync(path.join(f.directory, '.data-key')), false);
  }
});

test('diagnostic state does not restrict an explicit caller after its failed file is removed', (t) => {
  const f = fixture(t, 'fsyncSync');
  assert.throws(() => f.paths.writeKey('synthetic'), /context_recovery_storage_unavailable/);
  assert.equal(f.opened.size, 0);
  fs.unlinkSync(path.join(f.directory, '.data-key'));
  f.clearFailure();
  const before = f.events.length;
  assert.equal(f.paths.writeKey('synthetic'), 'synthetic');
  assert.deepEqual(
    f.events.slice(before).map((x) => x.phase),
    phases
  );
});

test('invalid progress callbacks fail before creating a storage leaf', (t) => {
  const { createStoragePaths } = require('../lib/proxy/context-recovery-storage-paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-key-progress-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const observer of [null, {}, 1]) {
    const directory = path.join(root, 'store');
    assert.throws(
      () => createStoragePaths(directory, observer),
      /context_recovery_storage_unavailable/
    );
    assert.equal(fs.existsSync(directory), false);
  }
});
