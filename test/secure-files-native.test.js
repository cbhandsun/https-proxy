'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const childProcess = require('node:child_process');
const { PassThrough } = require('node:stream');
const {
  securePrivatePathNative,
  securePrivatePathNativeAsync,
} = require('../lib/proxy/private-path-native');

function asyncFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-async-acl-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hpm-native-async-acl-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const file = path.join(directory, 'owned & private.txt');
  const nativeExecutable = path.join(directory, 'synthetic.exe');
  fs.writeFileSync(file, 'owned fixture');
  fs.writeFileSync(nativeExecutable, 'owned executable boundary');
  return { directory, file, nativeExecutable };
}

const safeAsyncFailure = (error) => {
  assert.equal(error.code, 'private_path_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  return true;
};

test('native ACL uses one target observation per boundary and revalidates each dispatch', async (t) => {
  const { file, nativeExecutable } = asyncFixture(t);
  const lstat = fs.lstatSync;
  let observations = 0;
  t.mock.method(fs, 'lstatSync', function (target, ...args) {
    if (target === file) observations++;
    return lstat.call(this, target, ...args);
  });
  const options = {
    platform: 'win32',
    nativeExecutable,
    execute: () => '{"ok":true}',
  };
  assert.equal(securePrivatePathNative(file, 'file', options), true);
  assert.equal(observations, 2, 'one target identity before and after native dispatch');
  observations = 0;
  assert.equal(await securePrivatePathNativeAsync(file, 'file', options), true);
  assert.equal(observations, 2, 'async dispatch retains both target boundaries');
  fs.linkSync(file, path.join(path.dirname(file), 'later-hardlink'));
  let dispatched = false;
  const denied = {
    ...options,
    execute() {
      dispatched = true;
      return '{"ok":true}';
    },
  };
  assert.throws(() => securePrivatePathNative(file, 'file', denied), safeAsyncFailure);
  await assert.rejects(securePrivatePathNativeAsync(file, 'file', denied), safeAsyncFailure);
  assert.equal(dispatched, false, 'no target validation cache crosses calls');
});

test('async native executor bounds the child, sends stdin and sanitizes callback and pipe errors', async (t) => {
  const { file, nativeExecutable } = asyncFixture(t);
  let outcome = 'success';
  let kills = 0;
  t.mock.method(childProcess, 'execFile', (_command, args, options, callback) => {
    assert.deepEqual(args, ['--hpm-context-private-path-v1']);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 128);
    assert.equal(options.windowsHide, true);
    const stdin = new PassThrough();
    const chunks = [];
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('finish', () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { path: file, kind: 'file' });
      setImmediate(() => {
        if (outcome === 'pipe') stdin.emit('error', Error('PRIVATE_PIPE'));
        callback(
          outcome === 'failure' ? Error('PRIVATE_CALLBACK') : null,
          '{"ok":true}',
          outcome === 'stderr' ? 'PRIVATE_STDERR' : ''
        );
      });
    });
    return {
      stdin,
      kill() {
        kills++;
      },
    };
  });
  const modulePath = require.resolve('../lib/proxy/private-path-native');
  const saved = require.cache[modulePath];
  let native;
  try {
    delete require.cache[modulePath];
    native = require(modulePath);
  } finally {
    require.cache[modulePath] = saved;
  }
  for (const value of ['success', 'failure', 'stderr', 'pipe']) {
    outcome = value;
    const pending = native.securePrivatePathNativeAsync(file, 'file', {
      platform: 'win32',
      nativeExecutable,
    });
    if (value === 'success') assert.equal(await pending, true);
    else await assert.rejects(pending, safeAsyncFailure);
  }
  assert.equal(kills, 1);
});

test('async native fallback is restricted to an absent default helper', async (t) => {
  const { file } = asyncFixture(t);
  const lstat = fs.lstatSync;
  let invalid = false;
  t.mock.method(fs, 'lstatSync', (target, options) => {
    if (String(target).endsWith('hpm-context-recovery-key.exe')) {
      if (invalid) return { isSymbolicLink: () => true };
      throw Object.assign(Error('PRIVATE_MISSING'), { code: 'ENOENT' });
    }
    return lstat(target, options);
  });
  const options = {
    platform: 'win32',
    execute() {
      throw Error('must_not_dispatch');
    },
  };
  assert.equal(await securePrivatePathNativeAsync(file, 'file', options), false);
  invalid = true;
  await assert.rejects(securePrivatePathNativeAsync(file, 'file', options), safeAsyncFailure);
});

test('async native ACL waits for bounded stdin protocol and verifies target identity', async (t) => {
  const { file, nativeExecutable } = asyncFixture(t);
  let release;
  let calls = 0;
  let settled = false;
  const pending = securePrivatePathNativeAsync(file, 'file', {
    platform: 'win32',
    nativeExecutable,
    execute(command, args, options) {
      calls++;
      assert.equal(command, nativeExecutable);
      assert.deepEqual(args, ['--hpm-context-private-path-v1']);
      assert.deepEqual(JSON.parse(options.input), { path: file, kind: 'file' });
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 128);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.PATH, undefined);
      assert.deepEqual(Object.keys(options.env).sort(), ['SystemRoot', 'WINDIR']);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  void pending.then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(calls, 1);
  release('{"ok":true}');
  assert.equal(await pending, true);
});

test('async native ACL rejects malformed, missing, extreme and linked input before dispatch', async (t) => {
  const { directory, file, nativeExecutable } = asyncFixture(t);
  let calls = 0;
  const options = {
    platform: 'win32',
    nativeExecutable,
    execute() {
      calls++;
    },
  };
  for (const value of [
    '',
    null,
    42,
    'relative',
    file + '\n',
    'x'.repeat(4097),
    path.parse(file).root,
    directory,
    path.join(directory, 'missing'),
  ])
    await assert.rejects(securePrivatePathNativeAsync(value, 'file', options), safeAsyncFailure);
  await assert.rejects(securePrivatePathNativeAsync(file, 'unknown', options), safeAsyncFailure);
  for (const executable of ['', null, file, path.join(directory, 'absent.exe')])
    await assert.rejects(
      securePrivatePathNativeAsync(file, 'file', { ...options, nativeExecutable: executable }),
      safeAsyncFailure
    );
  const link = path.join(directory, 'hardlink');
  fs.linkSync(file, link);
  await assert.rejects(securePrivatePathNativeAsync(file, 'file', options), safeAsyncFailure);
  assert.equal(calls, 0);
});

test('async native dispatch failures and replacement cannot grant success or expose native replies', async (t) => {
  const { file, nativeExecutable } = asyncFixture(t);
  for (const execute of [
    async () => {
      throw Error('PRIVATE_NATIVE_FAILURE');
    },
    async () => '',
    async () => '{"ok":true,"extra":"PRIVATE_REPLY"}',
    async () => ({ stdout: '{"ok":true}' }),
    async () => {
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, 'replacement');
      return '{"ok":true}';
    },
  ])
    await assert.rejects(
      securePrivatePathNativeAsync(file, 'file', { platform: 'win32', nativeExecutable, execute }),
      safeAsyncFailure
    );
  assert.equal(
    await securePrivatePathNativeAsync(file, 'file', {
      platform: 'linux',
      execute() {
        throw Error('must_not_execute');
      },
    }),
    false
  );
});

test('default async file security uses native owner, shares cache and invalidates failed refresh', async (t) => {
  const { file } = asyncFixture(t);
  const native = require('../lib/proxy/private-path-native');
  const { ensurePrivateFileAsync, ensurePrivateFileSync } = require('../lib/proxy/secure-files');
  let calls = 0;
  let deny = false;
  t.mock.method(native, 'securePrivatePathNativeAsync', async (target, kind) => {
    assert.equal(target, file);
    assert.equal(kind, 'file');
    calls++;
    if (deny)
      throw Object.assign(Error('private_path_unavailable'), { code: 'private_path_unavailable' });
    return true;
  });
  assert.equal(await ensurePrivateFileAsync(file, { platform: 'win32' }), file);
  assert.equal(await ensurePrivateFileAsync(file, { platform: 'win32' }), file);
  assert.equal(
    ensurePrivateFileSync(file, {
      platform: 'win32',
      execFileSync() {
        throw Error('cache_missed');
      },
    }),
    file
  );
  assert.equal(calls, 1);
  deny = true;
  await assert.rejects(
    ensurePrivateFileAsync(file, { platform: 'win32', force: true }),
    safeAsyncFailure
  );
  assert.equal(calls, 2);
  deny = false;
  assert.equal(await ensurePrivateFileAsync(file, { platform: 'win32' }), file);
  assert.equal(calls, 3);
});

test(
  'actual local native helper secures an owned file asynchronously',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { file } = asyncFixture(t);
    assert.equal(await securePrivatePathNativeAsync(file, 'file'), true);
  }
);

test('native ACL rejects replaced targets and contains dispatch errors without success', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-acl-identity-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-native-acl-identity-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'synthetic.txt');
  const nativeExecutable = path.join(directory, 'synthetic.exe');
  fs.writeFileSync(file, 'synthetic');
  fs.writeFileSync(nativeExecutable, 'synthetic executable boundary');
  let calls = 0;
  const options = { platform: 'win32', nativeExecutable };
  const safe = (error) => {
    assert.equal(error.code, 'private_path_unavailable');
    assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined);
    return true;
  };
  for (const execute of [
    () => {
      throw Error('PRIVATE_DISPATCH_FAILURE');
    },
    () => '{"ok":true,"extra":"PRIVATE_REPLY"}',
    () => {
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, 'replacement');
      return '{"ok":true}';
    },
  ]) {
    assert.throws(
      () =>
        securePrivatePathNative(file, 'file', {
          ...options,
          execute() {
            calls++;
            return execute();
          },
        }),
      safe
    );
  }
  assert.equal(calls, 3);
});

test(
  'missing default native binary alone permits legacy dispatch; invalid binary fails before dispatch',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-acl-fallback-'));
    const file = path.join(directory, 'synthetic.txt');
    fs.writeFileSync(file, 'synthetic');
    try {
      const source = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const cp = require('node:child_process');
      const lstat = fs.lstatSync;
      let invalid = false;
      fs.lstatSync = (file, options) => {
        if (String(file).endsWith('hpm-context-recovery-key.exe')) {
          if (invalid) return { isSymbolicLink: () => true };
          throw Object.assign(Error('PRIVATE_MISSING'), { code: 'ENOENT' });
        }
        return lstat(file, options);
      };
      const calls = [];
      cp.execFileSync = (command) => {
        calls.push(path.basename(command));
        return command.endsWith('whoami.exe') ? 'S-1-5-21-1000' : '';
      };
      const { securePrivatePathSync } = require('./lib/proxy/secure-files');
      const file = ${JSON.stringify(file)};
      securePrivatePathSync(file, 'file');
      assert.deepEqual(calls, ['whoami.exe', 'icacls.exe', 'icacls.exe']);
      const { secureRecoveryStoragePath } = require('./lib/proxy/context-recovery-private-path');
      secureRecoveryStoragePath(file, 'file', {
        execute(command, args, options) {
          assert.equal(options.timeout, 5000);
          assert.equal(options.maxBuffer, 16384);
          assert.equal(options.windowsHide, true);
          assert.deepEqual(Object.keys(options.env).sort(), ['SystemRoot', 'WINDIR']);
          return cp.execFileSync(command, args, options);
        },
      });
      assert.deepEqual(calls.slice(3), ['icacls.exe', 'icacls.exe']);
      invalid = true;
      assert.throws(() => securePrivatePathSync(file, 'file', { force: true }), {
        code: 'private_path_unavailable', message: 'private_path_unavailable',
      });
      assert.equal(calls.length, 5);
      assert.throws(() => secureRecoveryStoragePath(file, 'file'), {
        code: 'context_recovery_storage_unavailable', message: 'context_recovery_storage_unavailable',
      });
      assert.equal(calls.length, 5);
      process.stdout.write('fallback_boundary_verified');
    `;
      const child = spawnSync(process.execPath, ['-e', source], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'fallback_boundary_verified');
      assert.equal(child.stderr, '');
    } finally {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('hpm-native-acl-fallback-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  'default Windows private paths use one native ACL request and keep inode cache and force semantics',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-acl-entry-'));
    const file = path.join(directory, 'synthetic.txt');
    fs.writeFileSync(file, 'synthetic');
    try {
      const source = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const cp = require('node:child_process');
      const calls = [];
      let fail = false;
      cp.execFileSync = (command, args, options) => {
        calls.push({ command: path.basename(command), args, options });
        if (fail) throw Error('PRIVATE_NATIVE_FAILURE');
        return command.endsWith('whoami.exe') ? 'S-1-5-21-1000' : '{"ok":true}';
      };
      const { securePrivatePathSync, resetSecurePathCache } = require('./lib/proxy/secure-files');
      const file = ${JSON.stringify(file)};
      securePrivatePathSync(file, 'file');
      securePrivatePathSync(file, 'file');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'hpm-context-recovery-key.exe');
      assert.deepEqual(calls[0].args, ['--hpm-context-private-path-v1']);
      assert.deepEqual(JSON.parse(calls[0].options.input), { path: file, kind: 'file' });
      assert.equal(calls[0].options.timeout, 5000);
      assert.equal(calls[0].options.windowsHide, true);
      assert.equal(calls[0].options.env.PATH, undefined);
      securePrivatePathSync(file, 'file', { force: true });
      assert.equal(calls.length, 2);
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, 'replacement');
      securePrivatePathSync(file, 'file');
      assert.equal(calls.length, 3);
      fail = true;
      assert.throws(() => securePrivatePathSync(file, 'file', { force: true }), {
        code: 'private_path_unavailable', message: 'private_path_unavailable',
      });
      assert.equal(calls.length, 4, 'no legacy retry after native dispatch failure');
      fail = false;
      securePrivatePathSync(file, 'file');
      assert.equal(calls.length, 5, 'failure must not publish cache success');
      resetSecurePathCache();
      securePrivatePathSync(path.dirname(file), 'directory');
      assert.equal(calls.length, 6);
      assert.equal(JSON.parse(calls[5].options.input).kind, 'directory');
      process.stdout.write('native_entry_verified');
    `;
      const child = spawnSync(process.execPath, ['-e', source], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'native_entry_verified');
      assert.equal(child.stderr.includes('PRIVATE_NATIVE_FAILURE'), false);
    } finally {
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('hpm-native-acl-entry-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
);
