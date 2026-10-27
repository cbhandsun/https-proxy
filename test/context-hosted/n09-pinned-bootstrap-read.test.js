'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readBootstrap,
  physical,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-client');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'n09-pinned-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'mailbox');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, '{"value":1}');
  const pins = new Map();
  physical(file, false, pins);
  return { root, directory, file, pins };
}

test('bounded reads bind prior file and ancestor identities before opening a replacement', (t) => {
  const f = fixture(t);
  assert.deepEqual(readBootstrap(f.file, 4096, f.pins), { value: 1 });
  fs.renameSync(f.file, path.join(f.directory, 'old-state.json'));
  fs.writeFileSync(f.file, '{"value":2}');
  assert.throws(() => readBootstrap(f.file, 4096, f.pins));
  // Existing readers without a prior identity still retain their original API.
  assert.deepEqual(readBootstrap(f.file, 4096), { value: 2 });
  const other = fixture(t);
  fs.renameSync(other.directory, path.join(other.root, 'old-mailbox'));
  fs.mkdirSync(other.directory);
  fs.writeFileSync(other.file, '{"value":1}');
  assert.throws(() => readBootstrap(other.file, 4096, other.pins));
});

test('pinned reads retain empty, malformed, UTF-8 and exact maximum rejection', (t) => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('{'),
    Buffer.from([255]),
    Buffer.from('{}\n'),
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => readBootstrap(f.file, 4096, f.pins));
  }
  const f = fixture(t);
  assert.deepEqual(readBootstrap(f.file, 11, f.pins), { value: 1 });
  assert.throws(() => readBootstrap(f.file, 10, f.pins));
  for (const maximum of [0, 1, -1, 131073, Infinity, NaN, '4096', null])
    assert.throws(() => readBootstrap(f.file, maximum, f.pins));
});

test('pinned reads reject hard links and physical aliases', (t) => {
  const f = fixture(t);
  fs.linkSync(f.file, path.join(f.root, 'hardlink.json'));
  assert.throws(() => readBootstrap(f.file, 4096, f.pins));
  const other = fixture(t);
  const target = path.join(other.root, 'target');
  fs.renameSync(other.directory, target);
  fs.symlinkSync(target, other.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readBootstrap(other.file, 4096, other.pins));
});

test('physical pinned reads use native Map methods without invoking overrides or proxy hooks', (t) => {
  const f = fixture(t);
  let hooks = 0;
  const hostile = () => {
    hooks++;
    throw Error('private sentinel');
  };
  for (const method of ['get', 'set', 'has'])
    Object.defineProperty(f.pins, method, { get: hostile });
  assert.deepEqual(readBootstrap(f.file, 4096, f.pins), { value: 1 });
  for (const pins of [null, {}, [], new Set(), new Proxy(new Map(), { get: hostile })])
    assert.throws(() => readBootstrap(f.file, 4096, pins));
  assert.equal(hooks, 0);
});

test('replacement during the descriptor read still rejects and closes the opened file', (t) => {
  const f = fixture(t);
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  let descriptor,
    closed = false;
  t.mock.method(fs, 'readSync', function (...args) {
    descriptor = args[0];
    const read = Reflect.apply(originalRead, fs, args);
    fs.renameSync(f.file, path.join(f.directory, 'original.json'));
    fs.writeFileSync(f.file, '{"value":1}');
    return read;
  });
  t.mock.method(fs, 'closeSync', function (fd) {
    if (fd === descriptor) closed = true;
    return Reflect.apply(originalClose, fs, [fd]);
  });
  assert.throws(() => readBootstrap(f.file, 4096, f.pins));
  assert.equal(closed, true);
});

test('read errors and short reads retain rejection and descriptor cleanup', async (t) => {
  for (const mode of ['error', 'short']) {
    await t.test(mode, (t) => {
      const f = fixture(t);
      const originalClose = fs.closeSync;
      let descriptor,
        closed = false;
      t.mock.method(fs, 'readSync', (fd) => {
        descriptor = fd;
        if (mode === 'error') throw Error('private sentinel');
        return 0;
      });
      t.mock.method(fs, 'closeSync', (fd) => {
        if (fd === descriptor) closed = true;
        return Reflect.apply(originalClose, fs, [fd]);
      });
      assert.throws(() => readBootstrap(f.file, 4096, f.pins));
      assert.equal(closed, true);
    });
  }
});
