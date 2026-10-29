'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { prepareStorageDirectoryNative } = require('../lib/proxy/private-path-native');

const nativeExecutable = path.resolve(__dirname, '../runtime/native/hpm-context-recovery-key.exe');
const windows = { skip: process.platform !== 'win32' };
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hpm-native-directory-'));
  const directory = path.join(parent, 'store');
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, directory, writer: path.join(directory, '.writer.sqlite') };
}
function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}
function prove(value, result) {
  assert(result, 'Windows qualification requires the prepared native binary');
  assert.deepEqual(result.directory, identity(value.directory));
  assert.deepEqual(result.writer, identity(value.writer));
  assert(Object.isFrozen(result.directory));
  assert(Object.isFrozen(result.writer));
  assert.equal(fs.lstatSync(value.writer, { bigint: true }).nlink, 1n);
}

test(
  'actual Windows directory preparation binds the default binary and both new file identities',
  windows,
  (t) => {
    const value = fixture(t);
    prove(value, prepareStorageDirectoryNative(value.directory));
    assert.equal(fs.lstatSync(nativeExecutable, { bigint: true }).nlink, 1n);
    assert.equal(fs.statSync(value.writer).size, 0);
  }
);

test(
  'actual Windows directory preparation preserves existing writer identity and bytes',
  windows,
  (t) => {
    const value = fixture(t);
    fs.writeFileSync(value.writer, 'synthetic retained writer');
    const before = identity(value.writer);
    const result = prepareStorageDirectoryNative(value.directory);
    prove(value, result);
    assert.deepEqual(result.writer, before);
    assert.equal(fs.readFileSync(value.writer, 'utf8'), 'synthetic retained writer');
  }
);

test(
  'actual Windows pre-Unix identities agree exactly or fail closed on Node timestamp wrap',
  windows,
  (t) => {
    const value = fixture(t);
    fs.writeFileSync(value.writer, 'synthetic old creation time');
    const executable = path.join(
      process.env.SystemRoot || process.env.WINDIR,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    );
    const result = spawnSync(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[IO.File]::SetCreationTimeUtc($env:HPM_TEST_WRITER_TIME_TARGET,[DateTime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc).AddTicks(-1))',
      ],
      {
        windowsHide: true,
        timeout: 30000,
        encoding: 'utf8',
        env: {
          SystemRoot: process.env.SystemRoot || process.env.WINDIR,
          WINDIR: process.env.WINDIR || process.env.SystemRoot,
          TEMP: value.parent,
          TMP: value.parent,
          HOME: value.parent,
          USERPROFILE: value.parent,
          HPM_TEST_WRITER_TIME_TARGET: value.writer,
        },
      }
    );
    assert.equal(result.status, 0, 'Synthetic creation time fixture failed');
    assert.equal(result.signal, null);
    const observedStat = fs.lstatSync(value.writer, { bigint: true });
    const observed = observedStat.birthtimeNs;
    if (observed === -100n) {
      prove(value, prepareStorageDirectoryNative(value.directory));
    } else {
      // Windows Node22 may expose the negative second as uint32. The native
      // receipt retains exact FILETIME arithmetic; never wrap it to grant a
      // match with the lossy observation. Exercise the actual dispatched refusal.
      assert.equal(observed, 4294967295999999900n);
      let calls = 0;
      let nativeReply;
      assert.throws(
        () =>
          prepareStorageDirectoryNative(value.directory, {
            execute(...args) {
              calls++;
              nativeReply = execFileSync(...args);
              return nativeReply;
            },
          }),
        { code: 'private_path_unavailable', message: 'private_path_unavailable' }
      );
      assert.equal(calls, 1);
      // A native timeout/ACL failure cannot satisfy this mismatch regression.
      assert.equal(typeof nativeReply, 'string');
      const receipt = JSON.parse(nativeReply);
      assert.equal(JSON.stringify(receipt), nativeReply);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.writer.birthtimeNs, '-100');
      assert.equal(receipt.writer.dev, String(observedStat.dev));
      assert.equal(receipt.writer.ino, String(observedStat.ino));
    }
    assert.equal(fs.readFileSync(value.writer, 'utf8'), 'synthetic old creation time');
  }
);

test(
  'actual Windows native reply cannot bless a writer replaced after native handles close',
  windows,
  (t) => {
    const value = fixture(t);
    let calls = 0;
    assert.throws(
      () =>
        prepareStorageDirectoryNative(value.directory, {
          execute(executable, args, settings) {
            calls++;
            const reply = execFileSync(executable, args, settings);
            fs.renameSync(value.writer, path.join(value.parent, 'original-writer'));
            fs.writeFileSync(value.writer, 'synthetic replacement');
            return reply;
          },
        }),
      { code: 'private_path_unavailable', message: 'private_path_unavailable' }
    );
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(value.writer, 'utf8'), 'synthetic replacement');
  }
);
