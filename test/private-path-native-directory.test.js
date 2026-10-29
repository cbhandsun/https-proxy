'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { prepareStorageDirectoryNative } = require('../lib/proxy/private-path-native');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hpm-native-dir-'));
  const directory = path.join(parent, 'storage');
  const executable = path.join(parent, 'helper.exe');
  fs.mkdirSync(directory);
  fs.writeFileSync(executable, 'fixture');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, directory, executable, writer: path.join(directory, '.writer.sqlite') };
}
function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return Object.fromEntries(['dev', 'ino', 'birthtimeNs'].map((key) => [key, String(stat[key])]));
}
function receipt(value) {
  return { ok: true, directory: identity(value.directory), writer: identity(value.writer) };
}
function options(value, execute) {
  return { platform: 'win32', nativeExecutable: value.executable, execute };
}

test('native directory preparation authenticates both identities in one bounded process', (t) => {
  const value = fixture(t);
  let calls = 0;
  const result = prepareStorageDirectoryNative(
    value.directory,
    options(value, (executable, args, settings) => {
      calls++;
      assert.equal(executable, value.executable);
      assert.deepEqual(args, ['--hpm-context-storage-directory-v1']);
      assert.deepEqual(JSON.parse(settings.input), { path: value.directory, kind: 'directory' });
      assert.equal(settings.timeout, 5000);
      assert.equal(settings.maxBuffer, 512);
      assert.equal(settings.windowsHide, true);
      assert.deepEqual(settings.stdio, ['pipe', 'pipe', 'pipe']);
      assert.deepEqual(Object.keys(settings.env).sort(), ['SystemRoot', 'WINDIR']);
      fs.writeFileSync(value.writer, 'retained writer');
      return JSON.stringify(receipt(value));
    })
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.writer, fsIdentity(value.writer));
  assert.deepEqual(result.directory, fsIdentity(value.directory));
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.writer));
  assert.equal(fs.readFileSync(value.writer, 'utf8'), 'retained writer');
});

function fsIdentity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

test('directory preparation rejects empty, invalid, duplicate, extra and extreme native receipts', (t) => {
  const value = fixture(t);
  fs.writeFileSync(value.writer, 'unchanged');
  const good = receipt(value);
  const replies = [
    '',
    'null',
    '[]',
    '{}',
    '{"ok":false}',
    JSON.stringify({ ...good, extra: true }),
    JSON.stringify(good) + '\n',
    JSON.stringify(good).replace('"ok":true', '"ok":true,"ok":true'),
    JSON.stringify({ ...good, writer: { ...good.writer, ino: '01' } }),
    JSON.stringify({ ...good, writer: { ...good.writer, dev: '-1' } }),
    JSON.stringify({ ...good, writer: { ...good.writer, ino: '18446744073709551616' } }),
    JSON.stringify({ ...good, writer: { ...good.writer, birthtimeNs: '-0' } }),
    JSON.stringify({ ...good, writer: { ...good.writer, birthtimeNs: '1e9' } }),
    JSON.stringify({ ...good, directory: { ...good.directory, extra: 'fixture' } }),
    ' '.repeat(513),
  ];
  for (const reply of replies) {
    assert.throws(
      () =>
        prepareStorageDirectoryNative(
          value.directory,
          options(value, () => reply)
        ),
      { code: 'private_path_unavailable' }
    );
  }
  assert.equal(fs.readFileSync(value.writer, 'utf8'), 'unchanged');
});

test('neither an unverified writer nor a substituted directory can inherit the native receipt', (t) => {
  for (const target of ['writer', 'directory']) {
    const value = fixture(t);
    fs.writeFileSync(value.writer, 'original');
    assert.throws(
      () =>
        prepareStorageDirectoryNative(
          value.directory,
          options(value, () => {
            const reply = JSON.stringify(receipt(value));
            if (target === 'writer') {
              fs.renameSync(value.writer, path.join(value.parent, 'retained-writer'));
              fs.writeFileSync(value.writer, 'replacement');
            } else {
              fs.renameSync(value.directory, path.join(value.parent, 'retained-directory'));
              fs.mkdirSync(value.directory);
              fs.writeFileSync(value.writer, 'replacement');
            }
            return reply;
          })
        ),
      { code: 'private_path_unavailable' }
    );
  }
});

test('oversized and multiply linked writer objects are refused without removing them', (t) => {
  for (const kind of ['oversized', 'linked']) {
    const value = fixture(t);
    fs.writeFileSync(value.writer, kind === 'oversized' ? Buffer.alloc(1048577) : 'retained');
    if (kind === 'linked') fs.linkSync(value.writer, path.join(value.parent, 'linked-writer'));
    assert.throws(
      () =>
        prepareStorageDirectoryNative(
          value.directory,
          options(value, () => JSON.stringify(receipt(value)))
        ),
      { code: 'private_path_unavailable' }
    );
    assert(fs.existsSync(value.writer));
  }
});

test('dispatched failures never retry or expose native diagnostics', (t) => {
  const value = fixture(t);
  let calls = 0;
  assert.throws(
    () =>
      prepareStorageDirectoryNative(
        value.directory,
        options(value, () => {
          calls++;
          throw Error('fixture-private-native-detail');
        })
      ),
    (error) => error.code === 'private_path_unavailable' && !error.message.includes('fixture')
  );
  assert.equal(calls, 1);
});

test('a directory ABA substitution cannot borrow an authenticated writer from another directory', (t) => {
  const value = fixture(t);
  assert.throws(
    () =>
      prepareStorageDirectoryNative(
        value.directory,
        options(value, () => {
          const original = path.join(value.parent, 'original-directory');
          const other = path.join(value.parent, 'other-directory');
          fs.renameSync(value.directory, original);
          fs.mkdirSync(value.directory);
          fs.writeFileSync(value.writer, 'writer');
          const reply = JSON.stringify(receipt(value));
          fs.renameSync(value.directory, other);
          fs.renameSync(original, value.directory);
          fs.renameSync(path.join(other, '.writer.sqlite'), value.writer);
          return reply;
        })
      ),
    { code: 'private_path_unavailable' }
  );
});

test('only absence of the default native binary permits compatibility dispatch', (t) => {
  const value = fixture(t);
  assert.equal(prepareStorageDirectoryNative(value.directory, { platform: 'linux' }), null);
  assert.throws(
    () =>
      prepareStorageDirectoryNative(value.directory, {
        platform: 'win32',
        nativeExecutable: path.join(value.parent, 'missing.exe'),
      }),
    { code: 'private_path_unavailable' }
  );
  const original = fs.lstatSync;
  const expected = path.resolve(__dirname, '../runtime/native/hpm-context-recovery-key.exe');
  fs.lstatSync = function (file, ...args) {
    if (file === expected) throw Object.assign(Error('fixture'), { code: 'ENOENT' });
    return Reflect.apply(original, this, [file, ...args]);
  };
  try {
    assert.equal(prepareStorageDirectoryNative(value.directory, { platform: 'win32' }), null);
  } finally {
    fs.lstatSync = original;
  }
});

test('malformed path inputs never invoke the native operation or evaluate input hooks', (t) => {
  const value = fixture(t);
  let hooks = 0;
  const hostile = {
    get path() {
      hooks++;
      throw Error('fixture');
    },
  };
  for (const input of [null, undefined, '', 'relative', '\0', 'x'.repeat(4097), hostile]) {
    assert.throws(
      () =>
        prepareStorageDirectoryNative(
          input,
          options(value, () => {
            hooks++;
          })
        ),
      { code: 'private_path_unavailable' }
    );
  }
  assert.equal(hooks, 0);
});
