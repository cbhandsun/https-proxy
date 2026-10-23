'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  KEY_PREFIX,
  MAX_WRAPPED_CHARS,
  keyRequest,
  keyResponse,
} = require('../lib/proxy/context-recovery-key-contract');
const { protectWithCurrentUser } = require('../lib/proxy/context-recovery-key-dpapi');
const { createContextRecoveryKeyProtector } = require('../lib/proxy/context-recovery-key');
const { secureRecoveryStoragePath } = require('../lib/proxy/context-recovery-private-path');
const { securePrivatePathSync } = require('../lib/proxy/secure-files');
const { verifyIndependentAcl } = require('./helpers/independent-acl-readback.cjs');
const {
  installContextRecoveryNativeArtifact,
} = require('../scripts/prepare-context-recovery-native');

function artifactFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-install-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hpm-native-install-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const source = path.join(directory, 'build.exe');
  const destination = path.join(directory, 'installed.exe');
  fs.writeFileSync(source, 'synthetic-native-build');
  return { directory, source, destination };
}

test('native installation preserves identical executable identity and atomically updates changed bytes', (t) => {
  const f = artifactFixture(t);
  assert.equal(installContextRecoveryNativeArtifact(f.source, f.destination), f.destination);
  const first = fs.lstatSync(f.destination, { bigint: true });
  assert.equal(installContextRecoveryNativeArtifact(f.source, f.destination), f.destination);
  const second = fs.lstatSync(f.destination, { bigint: true });
  for (const key of ['dev', 'ino', 'birthtimeNs', 'mtimeNs']) assert.equal(second[key], first[key]);
  fs.writeFileSync(f.source, 'changed-synthetic-native');
  installContextRecoveryNativeArtifact(f.source, f.destination);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'changed-synthetic-native');
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['build.exe', 'installed.exe']);
});

test('native installation rejects malformed, empty, oversized and non-file artifacts without replacing a target', (t) => {
  const f = artifactFixture(t);
  fs.writeFileSync(f.destination, 'preserved');
  let accessed = false;
  const hostile = {
    toString() {
      accessed = true;
      return f.source;
    },
  };
  for (const source of [
    null,
    undefined,
    {},
    hostile,
    '',
    'relative.exe',
    f.source + '\n',
    f.directory,
  ])
    assert.throws(() => installContextRecoveryNativeArtifact(source, f.destination));
  for (const destination of [null, {}, '', 'relative.exe', f.destination + '\n', f.directory])
    assert.throws(() => installContextRecoveryNativeArtifact(f.source, destination));
  fs.writeFileSync(f.source, '');
  assert.throws(() => installContextRecoveryNativeArtifact(f.source, f.destination));
  fs.truncateSync(f.source, 16777217);
  assert.throws(() => installContextRecoveryNativeArtifact(f.source, f.destination));
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'preserved');
  assert.equal(accessed, false);
});

test('native installation copies Cargo-style linked sources but refuses linked targets and junction ancestors', (t) => {
  const f = artifactFixture(t);
  fs.writeFileSync(f.destination, 'preserved');
  const link = path.join(f.directory, 'linked.exe');
  fs.linkSync(f.source, link);
  installContextRecoveryNativeArtifact(link, f.destination);
  assert.equal(fs.lstatSync(f.destination).nlink, 1);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'synthetic-native-build');
  fs.unlinkSync(link);
  fs.writeFileSync(f.destination, 'preserved');
  fs.linkSync(f.destination, link);
  assert.throws(() => installContextRecoveryNativeArtifact(f.source, f.destination));
  fs.unlinkSync(link);
  const actual = path.join(f.directory, 'actual');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'build.exe'), 'synthetic');
  const linkedDirectory = path.join(f.directory, 'linked-directory');
  fs.symlinkSync(actual, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() =>
    installContextRecoveryNativeArtifact(path.join(linkedDirectory, 'build.exe'), f.destination)
  );
  assert.throws(() =>
    installContextRecoveryNativeArtifact(f.source, path.join(linkedDirectory, 'installed.exe'))
  );
  assert.equal(fs.existsSync(path.join(actual, 'installed.exe')), false);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'preserved');
});

test('failed native publication retains the previous executable and removes only its own staging file', (t) => {
  const f = artifactFixture(t);
  fs.writeFileSync(f.destination, 'preserved');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.destination) throw Error('synthetic-publication-failure');
    return rename(source, destination);
  });
  assert.throws(
    () => installContextRecoveryNativeArtifact(f.source, f.destination),
    /synthetic-publication-failure/
  );
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'preserved');
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['build.exe', 'installed.exe']);
});

test('native artifact identity substitution during comparison refuses before publication', (t) => {
  for (const selected of ['source', 'destination']) {
    const f = artifactFixture(t);
    fs.writeFileSync(f.destination, 'preserved');
    const read = fs.readSync;
    let calls = 0;
    let injected = false;
    t.mock.method(fs, 'readSync', (...args) => {
      calls++;
      if (calls === (selected === 'source' ? 1 : 3)) {
        injected = true;
        const file = f[selected];
        fs.renameSync(file, file + '.old');
        fs.writeFileSync(file, selected === 'source' ? 'synthetic-native-build' : 'preserved');
      }
      return read(...args);
    });
    assert.throws(() => installContextRecoveryNativeArtifact(f.source, f.destination));
    t.mock.restoreAll();
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'preserved');
    assert.equal(
      fs.readdirSync(f.directory).some((name) => name.endsWith('.staged')),
      false
    );
  }
});

test('storage native ACL dispatch is bounded, isolated and never retries a failed reply', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-private-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.txt');
  fs.writeFileSync(file, 'synthetic');
  const nativeExecutable = path.join(root, 'hpm-context-recovery-key.exe');
  fs.writeFileSync(nativeExecutable, 'synthetic executable boundary');
  const execute = (reply, fail = false) => {
    let calls = 0;
    const options = {
      platform: 'win32',
      nativeExecutable,
      execute(executable, args, invocation) {
        calls++;
        assert.equal(path.basename(executable), 'hpm-context-recovery-key.exe');
        assert.deepEqual(args, ['--hpm-context-private-path-v1']);
        assert.deepEqual(JSON.parse(invocation.input), { path: file, kind: 'file' });
        assert.deepEqual(Object.keys(invocation.env).sort(), ['SystemRoot', 'WINDIR']);
        assert.equal(invocation.timeout, 5000);
        assert.equal(invocation.maxBuffer, 128);
        assert.equal(invocation.windowsHide, true);
        assert.deepEqual(invocation.stdio, ['pipe', 'pipe', 'pipe']);
        if (fail) throw new Error('synthetic private');
        return reply;
      },
    };
    if (reply === '{"ok":true}' && !fail)
      assert.equal(secureRecoveryStoragePath(file, 'file', options), file);
    else
      assert.throws(
        () => secureRecoveryStoragePath(file, 'file', options),
        (error) =>
          error.code === 'context_recovery_storage_unavailable' &&
          !error.cause &&
          error.message === 'context_recovery_storage_unavailable'
      );
    assert.equal(calls, 1);
  };
  execute('{"ok":true}');
  for (const reply of [
    undefined,
    '',
    '{"ok":false}',
    '{"ok":true,"extra":"private"}',
    '{"ok":true,"ok":true}',
    Buffer.from('{"ok":true}'),
  ])
    execute(reply);
  execute('{"ok":true}', true);
});

test('storage private ACL rejects unsafe paths and executables before dispatch and keeps POSIX mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-private-path-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'synthetic');
  let calls = 0,
    accessed = false;
  const hostile = {
    toString() {
      accessed = true;
      throw Error('private');
    },
  };
  const options = {
    platform: 'win32',
    execute() {
      calls++;
      return '{"ok":true}';
    },
  };
  for (const [target, kind] of [
    [hostile, 'file'],
    ['', 'file'],
    ['relative', 'file'],
    [path.parse(root).root, 'directory'],
    [root, 'file'],
    [file, 'directory'],
    [file, 'invalid'],
    [path.join(root, 'missing'), 'file'],
    ['x'.repeat(4097), 'file'],
    [file + '\n', 'file'],
  ])
    assert.throws(() => secureRecoveryStoragePath(target, kind, options), {
      code: 'context_recovery_storage_unavailable',
    });
  for (const nativeExecutable of [
    null,
    hostile,
    'relative.exe',
    path.join(root, 'missing.exe'),
    file,
  ])
    assert.throws(() => secureRecoveryStoragePath(file, 'file', { ...options, nativeExecutable }), {
      code: 'context_recovery_storage_unavailable',
    });
  const alias = path.join(root, 'alias');
  fs.linkSync(file, alias);
  assert.throws(() => secureRecoveryStoragePath(file, 'file', options), {
    code: 'context_recovery_storage_unavailable',
  });
  fs.unlinkSync(alias);
  assert.equal(secureRecoveryStoragePath(file, 'file', { platform: 'linux' }), file);
  assert.equal(accessed, false);
  assert.equal(calls, 0);
});

test(
  'actual storage native ACL independently verifies protected access and rejects junction ancestors',
  { skip: process.platform !== 'win32', timeout: 30000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-private-path-live-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'private');
    fs.mkdirSync(directory);
    const file = path.join(directory, '原文.txt');
    fs.writeFileSync(file, 'synthetic');
    secureRecoveryStoragePath(directory, 'directory');
    secureRecoveryStoragePath(file, 'file');
    const generalDirectory = path.join(root, 'general-private');
    fs.mkdirSync(generalDirectory);
    const generalFile = path.join(generalDirectory, '配置.txt');
    fs.writeFileSync(generalFile, 'synthetic-general');
    securePrivatePathSync(generalDirectory, 'directory', { force: true });
    securePrivatePathSync(generalFile, 'file', { force: true });
    const result = verifyIndependentAcl([
      { path: directory, kind: 'directory' },
      { path: file, kind: 'file' },
      { path: generalDirectory, kind: 'directory' },
      { path: generalFile, kind: 'file' },
    ]);
    assert.equal(result, 'verified');
    assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic');
    assert.equal(fs.readFileSync(generalFile, 'utf8'), 'synthetic-general');
    const junction = path.join(root, 'junction');
    fs.symlinkSync(directory, junction, 'junction');
    let calls = 0;
    assert.throws(
      () =>
        secureRecoveryStoragePath(path.join(junction, '原文.txt'), 'file', {
          execute() {
            calls++;
            return '{"ok":true}';
          },
        }),
      { code: 'context_recovery_storage_unavailable' }
    );
    assert.equal(calls, 0);
    const executable = path.resolve(__dirname, '../runtime/native/hpm-context-recovery-key.exe');
    assert.throws(
      () =>
        execFileSync(executable, ['--hpm-context-private-path-v1'], {
          input: JSON.stringify({ path: path.join(junction, '原文.txt'), kind: 'file' }),
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        }),
      (error) => error.status === 1 && error.stdout === '{"ok":false}' && error.stderr === ''
    );
  }
);

const key = randomBytes(32).toString('base64');
const blob = randomBytes(128).toString('base64');
const wrapped = KEY_PREFIX + blob;

test('native build CLI rejects unknown and excess arguments without exposing input or starting a build', () => {
  for (const args of [['--secret-value'], ['--test', 'secret-value']]) {
    try {
      execFileSync(
        process.execPath,
        [path.resolve(__dirname, '../scripts/prepare-context-recovery-native.js'), ...args],
        { timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      assert.fail('invalid CLI accepted');
    } catch (error) {
      assert.equal(error.status, 1);
      assert.equal(String(error.stderr), 'context_recovery_native_build_failed\n');
      assert.equal(String(error.stdout), '');
    }
  }
});

test(
  'native helper rejects hard links and junction ancestors before executing code',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-boundary-'));
    let calls = 0;
    try {
      const file = path.join(root, 'helper.exe');
      fs.writeFileSync(file, 'synthetic');
      const link = path.join(root, 'hardlink.exe');
      fs.linkSync(file, link);
      const execute = () => {
        calls++;
        throw new Error('must not run');
      };
      assert.throws(
        () =>
          protectWithCurrentUser(
            { operation: 'protect', value: key },
            { nativeExecutable: file, execute }
          ),
        safeFailure
      );
      fs.unlinkSync(link);
      const junction = path.join(root, 'junction');
      fs.symlinkSync(root, junction, 'junction');
      assert.throws(
        () =>
          protectWithCurrentUser(
            { operation: 'protect', value: key },
            { nativeExecutable: path.join(junction, 'helper.exe'), execute }
          ),
        safeFailure
      );
      fs.unlinkSync(junction);
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'native recovery helper uses one bounded stdin request and never falls back after dispatch failure',
  { skip: process.platform !== 'win32' },
  () => {
    const executable = path.resolve(__dirname, '../runtime/native/hpm-context-recovery-key.exe');
    const calls = [];
    const options = {
      nativeExecutable: executable,
      execute(file, args, opts) {
        calls.push({ file, args, opts });
        return JSON.stringify({ ok: true, value: blob });
      },
    };
    assert.equal(protectWithCurrentUser({ operation: 'protect', value: key }, options), wrapped);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, executable);
    assert.deepEqual(calls[0].args, ['--hpm-context-key-v1']);
    assert.deepEqual(JSON.parse(calls[0].opts.input), { operation: 'protect', value: key });
    assert.equal(calls[0].opts.timeout, 10000);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.ok(!JSON.stringify([calls[0].args, calls[0].opts.env]).includes(key));
    let attempts = 0;
    assert.throws(
      () =>
        protectWithCurrentUser(
          { operation: 'protect', value: key },
          {
            nativeExecutable: executable,
            execute() {
              attempts++;
              throw new Error(key);
            },
          }
        ),
      safeFailure
    );
    assert.equal(attempts, 1);
  }
);

test('native helper path rejects invalid, missing and unsafe executable selectors before dispatch', () => {
  let calls = 0;
  for (const nativeExecutable of [
    '',
    42,
    {},
    [],
    'relative.exe',
    'x'.repeat(4097),
    'C:\\secret\n.exe',
    '\\\\server\\share\\key.exe',
    path.resolve(__dirname, 'missing-context-recovery-key.exe'),
  ]) {
    assert.throws(
      () =>
        protectWithCurrentUser(
          { operation: 'protect', value: key },
          {
            platform: 'win32',
            environment: { SystemRoot: 'C:\\Windows' },
            nativeExecutable,
            execute() {
              calls++;
            },
          }
        ),
      safeFailure
    );
  }
  assert.equal(calls, 0);
});

test(
  'actual native recovery helper interoperates with legacy DPAPI wrapping without key migration',
  { timeout: 30000, skip: process.platform !== 'win32' },
  (t) => {
    // Observe only fixed backend labels, timing and bounded failure categories.
    // Never include subprocess arguments, stdin, stdout, stderr or raw errors.
    const measuredExecute = (backend) => (executable, args, options) => {
      const started = performance.now();
      let outcome = 'completed';
      try {
        return execFileSync(executable, args, options);
      } catch (error) {
        outcome = ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM'].includes(error?.code)
          ? error.code
          : 'failed';
        throw error;
      } finally {
        t.diagnostic(
          'key_backend ' +
            JSON.stringify({ backend, outcome, elapsedMs: Math.floor(performance.now() - started) })
        );
      }
    };
    const nativeExecutable = path.resolve(
      __dirname,
      '../runtime/native/hpm-context-recovery-key.exe'
    );
    const fromNative = protectWithCurrentUser(
      { operation: 'protect', value: key },
      { nativeExecutable, execute: measuredExecute('native_protect') }
    );
    assert.equal(
      protectWithCurrentUser(
        { operation: 'unprotect', value: fromNative },
        { nativeExecutable: null, execute: measuredExecute('legacy_unprotect') }
      ),
      key
    );
    const fromLegacy = protectWithCurrentUser(
      { operation: 'protect', value: key },
      { nativeExecutable: null, execute: measuredExecute('legacy_protect') }
    );
    assert.equal(
      protectWithCurrentUser(
        { operation: 'unprotect', value: fromLegacy },
        { nativeExecutable, execute: measuredExecute('native_unprotect') }
      ),
      key
    );
    for (const input of [
      'null',
      '{}',
      '{"operation":"protect","value":"' + key + '","extra":true}',
      '{"operation":"protect","operation":"protect","value":"' + key + '"}',
    ]) {
      assert.throws(() =>
        execFileSync(nativeExecutable, ['--hpm-context-key-v1'], {
          input,
          timeout: 10000,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );
    }
  }
);
function safeFailure(error) {
  assert.equal(error.message, 'context_recovery_key_unavailable');
  assert.equal(error.code, 'context_recovery_key_unavailable');
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}

test('system key contract accepts only exact canonical bounded data', () => {
  assert.deepEqual(keyRequest({ operation: 'protect', value: key }), {
    operation: 'protect',
    value: key,
  });
  assert.deepEqual(keyRequest({ operation: 'unprotect', value: wrapped }), {
    operation: 'unprotect',
    value: wrapped,
  });
  assert.equal(keyResponse('protect', { ok: true, value: wrapped }), wrapped);
  assert.equal(keyResponse('unprotect', { ok: true, value: key }), key);
  const largest = KEY_PREFIX + Buffer.alloc((MAX_WRAPPED_CHARS / 4) * 3).toString('base64');
  assert.equal(keyRequest({ operation: 'unprotect', value: largest }).value, largest);
  for (const input of [
    null,
    undefined,
    [],
    '',
    {},
    { operation: 'delete', value: key },
    { operation: 'protect', value: key, extra: true },
    { operation: 'protect' },
  ]) {
    assert.throws(() => keyRequest(input), safeFailure);
  }
  for (const value of [
    null,
    {},
    '',
    ' ',
    key + '\n',
    key.replace(/=$/, ''),
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    'a'.repeat(20000),
    'A'.repeat(42) + 'B=',
  ]) {
    assert.throws(() => keyRequest({ operation: 'protect', value }), safeFailure);
  }
  for (const value of [
    null,
    key,
    KEY_PREFIX,
    KEY_PREFIX + key + '\n',
    KEY_PREFIX + 'A===',
    KEY_PREFIX + Buffer.alloc(31).toString('base64'),
    largest + 'AAAA',
  ]) {
    assert.throws(() => keyRequest({ operation: 'unprotect', value }), safeFailure);
  }
  for (const input of [
    null,
    [],
    {},
    { ok: false },
    { ok: 'true', value: key },
    { ok: true, value: key, secret: 'secret-value' },
  ]) {
    assert.throws(() => keyResponse('unprotect', input), safeFailure);
  }
  assert.throws(() => keyResponse('bad', { ok: true, value: key }), safeFailure);
});

test('system key contract rejects executable objects without invoking getters or coercion', () => {
  let executed = 0;
  const accessor = {
    operation: 'protect',
    get value() {
      executed++;
      return key;
    },
  };
  const coercion = {
    operation: 'protect',
    value: {
      toString() {
        executed++;
        return key;
      },
    },
  };
  const cycle = { operation: 'protect' };
  cycle.value = cycle;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('secret-value');
      },
    }
  );
  for (const input of [
    accessor,
    coercion,
    cycle,
    proxy,
    new Date(),
    Object.assign(Object.create({ inherited: true }), { operation: 'protect', value: key }),
  ]) {
    assert.throws(() => keyRequest(input), safeFailure);
    assert.throws(() => keyResponse('unprotect', input), safeFailure);
  }
  assert.equal(executed, 0);
});

test('DPAPI subprocess uses a fixed program, minimal environment and stdin-only key transport', () => {
  const calls = [];
  const environment = { SystemRoot: 'C:\\Windows', PATH: 'private-path', TOKEN: 'secret-value' };
  const execute = (file, args, options) => {
    calls.push({ file, args, options });
    const request = JSON.parse(options.input);
    return JSON.stringify({ ok: true, value: request.operation === 'protect' ? blob : key });
  };
  const options = { platform: 'win32', environment, execute, nativeExecutable: null };
  assert.equal(protectWithCurrentUser({ operation: 'protect', value: key }, options), wrapped);
  assert.equal(protectWithCurrentUser({ operation: 'unprotect', value: wrapped }, options), key);
  for (const call of calls) {
    assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(call.args.slice(0, 4), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    assert.equal(call.args.length, 5);
    assert.equal(call.args[4], calls[0].args[4]);
    assert.match(call.args[4], /ProtectedData.*Protect/);
    assert.match(call.args[4], /CurrentUser/);
    assert.match(call.args[4], /hpm\/context-recovery\/data-key\/v1/);
    assert.match(call.args[4], /Unprotect\(\$keyResult,\$keyEntropy,'CurrentUser'\)/);
    assert.match(call.args[4], /ToBase64String\(\$keyCheck\) -cne \$keyRequest.value/);
    for (const secret of [key, blob, 'secret-value', 'private-path'])
      assert.equal(
        JSON.stringify([call.file, call.args, call.options.env]).includes(secret),
        false
      );
    assert.deepEqual(call.options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
    assert.equal(call.options.timeout, 10000);
    assert.equal(call.options.maxBuffer, 20000);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.encoding, 'utf8');
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  }
  assert.deepEqual(JSON.parse(calls[0].options.input), { operation: 'protect', value: key });
  assert.deepEqual(JSON.parse(calls[1].options.input), { operation: 'unprotect', value: blob });
  assert.equal(
    protectWithCurrentUser(
      { operation: 'protect', value: key },
      {
        platform: 'win32',
        environment: { WINDIR: 'C:\\Windows' },
        nativeExecutable: null,
        execute,
      }
    ),
    wrapped
  );
});

test(
  'native key boundary rejects extra or duplicate JSON fields before returning protected material',
  { timeout: 30000, skip: process.platform !== 'win32' },
  () => {
    for (const input of [
      JSON.stringify({ operation: 'protect', value: key, extra: 'secret-value' }),
      '{"operation":"protect","operation":"protect","value":"' + key + '"}',
    ]) {
      let calls = 0;
      assert.throws(
        () =>
          protectWithCurrentUser(
            { operation: 'protect', value: key },
            {
              nativeExecutable: null,
              execute(file, args, options) {
                calls++;
                return execFileSync(file, args, { ...options, input });
              },
            }
          ),
        safeFailure
      );
      assert.equal(calls, 1);
    }
  }
);

test(
  'actual native protect self-check rejects a corrupted wrapping before success',
  { timeout: 30000, skip: process.platform !== 'win32' },
  () => {
    let calls = 0;
    assert.throws(
      () =>
        protectWithCurrentUser(
          { operation: 'protect', value: key },
          {
            nativeExecutable: null,
            execute(file, args, options) {
              calls++;
              const line =
                "$keyResult=[Security.Cryptography.ProtectedData]::Protect($keyBytes,$keyEntropy,'CurrentUser');";
              assert.equal(args[4].includes(line), true);
              const script = args[4].replace(
                line,
                line + '$keyResult[$keyResult.Length-1]=$keyResult[$keyResult.Length-1] -bxor 1;'
              );
              return execFileSync(file, [...args.slice(0, 4), script], options);
            },
          }
        ),
      safeFailure
    );
    assert.equal(calls, 1);
  }
);

test('DPAPI rejects unsupported environments and all native failures without fallback or disclosure', () => {
  let calls = 0;
  for (const [platform, environment] of [
    ['linux', { SystemRoot: 'C:\\Windows' }],
    ['darwin', {}],
    ['win32', {}],
    ['win32', { SystemRoot: 42 }],
    ['win32', { SystemRoot: 'relative' }],
    ['win32', { SystemRoot: 'C:\\Windows\nsecret' }],
  ]) {
    assert.throws(
      () =>
        protectWithCurrentUser(
          { operation: 'protect', value: key },
          {
            platform,
            environment,
            execute() {
              calls++;
            },
          }
        ),
      safeFailure
    );
  }
  assert.equal(calls, 0);
  for (const execute of [
    () => {
      throw Object.assign(new Error(key), { stderr: blob });
    },
    ...[
      null,
      Buffer.from('secret-value'),
      'not json',
      'x'.repeat(17001),
      '{"ok":false}',
      JSON.stringify({ ok: true, value: '' }),
      JSON.stringify({ ok: true, value: blob, extra: 'secret-value' }),
      JSON.stringify({ ok: true, value: 123 }),
    ].map((reply) => () => reply),
  ]) {
    assert.throws(
      () =>
        protectWithCurrentUser(
          { operation: 'protect', value: key },
          {
            platform: 'win32',
            environment: { SystemRoot: 'C:\\Windows' },
            execute,
          }
        ),
      safeFailure
    );
  }
  assert.throws(
    () =>
      protectWithCurrentUser(
        { operation: 'unprotect', value: wrapped },
        {
          platform: 'win32',
          environment: { SystemRoot: 'C:\\Windows' },
          execute: () => JSON.stringify({ ok: true, value: blob }),
        }
      ),
    safeFailure
  );
  assert.throws(() => protectWithCurrentUser(null), safeFailure);
});

function fakeWorkers() {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(file, options) {
      super();
      this.file = file;
      this.options = options;
      this.drains = 0;
      this.terminations = 0;
      this.stdout = { resume: () => this.drains++ };
      this.stderr = { resume: () => this.drains++ };
      workers.push(this);
    }
    postMessage(request) {
      this.request = request;
    }
    terminate() {
      this.terminations++;
      return Promise.resolve(1);
    }
  }
  return { workers, FakeWorker };
}

test('key protector resolves only after one valid reply and a clean exit', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  const protector = createContextRecoveryKeyProtector({ WorkerType: FakeWorker });
  let settled = false;
  const operation = protector.protect(key).then((value) => {
    settled = true;
    return value;
  });
  const worker = workers[0];
  assert.equal(worker.drains, 2);
  assert.match(worker.file, /context-recovery-key-worker\.js$/);
  assert.deepEqual(worker.options, { execArgv: [], stdout: true, stderr: true });
  assert.deepEqual(worker.request, { operation: 'protect', value: key });
  worker.emit('message', { ok: true, value: wrapped });
  await Promise.resolve();
  assert.equal(settled, false);
  worker.emit('exit', 0);
  assert.equal(await operation, wrapped);
  worker.emit('message', { ok: false });
  worker.emit('exit', 9);
  assert.equal(worker.terminations, 0);
  const restored = protector.unprotect(wrapped);
  workers[1].emit('message', { ok: true, value: key });
  workers[1].emit('exit', 0);
  assert.equal(await restored, key);
});

test('key protector rejects invalid startup, posts, messages, errors and exits safely', async () => {
  for (const options of [
    { WorkerType: null },
    { timeoutMs: 99 },
    { timeoutMs: 20001 },
    { timeoutMs: NaN },
  ])
    assert.throws(() => createContextRecoveryKeyProtector(options), safeFailure);
  for (const mode of [
    'startup',
    'post',
    'error',
    'emptyExit',
    'badExit',
    'badReply',
    'duplicate',
    'getter',
    'terminateThrow',
    'terminateReject',
  ]) {
    const { workers, FakeWorker } = fakeWorkers();
    class FailureWorker extends FakeWorker {
      constructor(...args) {
        if (mode === 'startup') throw new Error('secret-value');
        super(...args);
      }
      postMessage(request) {
        if (mode === 'post') throw new Error('secret-value');
        super.postMessage(request);
      }
      terminate() {
        if (mode === 'terminateThrow') throw new Error('secret-value');
        if (mode === 'terminateReject') return Promise.reject(new Error('secret-value'));
        return super.terminate();
      }
    }
    const protector = createContextRecoveryKeyProtector({ WorkerType: FailureWorker });
    const pending = assert.rejects(protector.protect(key), safeFailure);
    const worker = workers[0];
    if (mode === 'error') worker.emit('error', new Error('secret-value'));
    if (mode === 'emptyExit') worker.emit('exit', 0);
    if (mode === 'badExit') {
      worker.emit('message', { ok: true, value: wrapped });
      worker.emit('exit', 1);
    }
    if (['badReply', 'terminateThrow', 'terminateReject'].includes(mode))
      worker.emit('message', { ok: false });
    if (mode === 'getter')
      worker.emit('message', {
        ok: true,
        get value() {
          throw new Error('must not execute');
        },
      });
    if (mode === 'duplicate') {
      worker.emit('message', { ok: true, value: wrapped });
      worker.emit('message', { ok: true, value: wrapped });
      worker.emit('exit', 0);
    }
    await pending;
    if (worker) {
      worker.emit('message', { ok: true, value: wrapped });
      worker.emit('exit', 0);
    }
    await assert.rejects(protector.protect('secret-value'), safeFailure);
  }
});

test('key worker concurrency stays occupied until termination completes; timeout is bounded', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  let release;
  class PendingWorker extends FakeWorker {
    terminate() {
      return new Promise((resolve) => {
        release = resolve;
      });
    }
  }
  const protector = createContextRecoveryKeyProtector({ WorkerType: PendingWorker });
  const first = assert.rejects(protector.protect(key), safeFailure);
  const second = protector.unprotect(wrapped);
  await assert.rejects(protector.protect(key), safeFailure);
  assert.equal(workers.length, 2);
  workers[0].emit('message', { ok: false });
  await assert.rejects(protector.protect(key), safeFailure);
  release(1);
  await first;
  const third = protector.protect(key);
  workers[1].emit('message', { ok: true, value: key });
  workers[1].emit('exit', 0);
  workers[2].emit('message', { ok: true, value: wrapped });
  workers[2].emit('exit', 0);
  assert.equal(await second, key);
  assert.equal(await third, wrapped);
  const stalled = fakeWorkers();
  const limited = createContextRecoveryKeyProtector({
    WorkerType: stalled.FakeWorker,
    timeoutMs: 100,
  });
  await assert.rejects(limited.protect(key), safeFailure);
  assert.equal(stalled.workers[0].terminations, 1);
});

test('failed worker termination keeps capacity reserved until an exit is actually observed', async () => {
  for (const mode of ['throw', 'reject']) {
    const { workers, FakeWorker } = fakeWorkers();
    class UncertainWorker extends FakeWorker {
      terminate() {
        if (mode === 'throw') throw new Error('secret-value');
        return Promise.reject(new Error('secret-value'));
      }
    }
    const protector = createContextRecoveryKeyProtector({ WorkerType: UncertainWorker });
    const first = assert.rejects(protector.protect(key), safeFailure);
    const second = assert.rejects(protector.protect(key), safeFailure);
    workers[0].emit('message', { ok: false });
    workers[1].emit('error', new Error('secret-value'));
    await Promise.all([first, second]);
    await assert.rejects(protector.protect(key), safeFailure);
    assert.equal(workers.length, 2);
    workers[0].emit('exit', 1);
    const next = protector.protect(key);
    workers[2].emit('message', { ok: true, value: wrapped });
    workers[2].emit('exit', 0);
    assert.equal(await next, wrapped);
    workers[1].emit('exit', 1);
  }
});

test(
  'actual system worker roundtrip and tampered wrapped key qualification',
  { timeout: 60000 },
  async () => {
    const protector = createContextRecoveryKeyProtector();
    if (process.platform !== 'win32') {
      await assert.rejects(protector.protect(key), safeFailure);
      return;
    }
    const actual = await protector.protect(key);
    assert.equal(await protector.unprotect(actual), key);
    const bytes = Buffer.from(actual.slice(KEY_PREFIX.length), 'base64');
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(protector.unprotect(KEY_PREFIX + bytes.toString('base64')), safeFailure);
    await assert.rejects(protector.unprotect(wrapped), safeFailure);
    await assert.rejects(protector.unprotect('other-namespace:' + blob), safeFailure);
  }
);

test(
  'key worker isolates process preload while completing a real DPAPI round trip',
  { skip: process.platform !== 'win32', timeout: 60000 },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        path.join(__dirname, 'helpers/context-recovery-worker-preload.cjs'),
        path.join(__dirname, 'helpers/context-recovery-worker-entry.cjs'),
        'key',
      ],
      { input: '1', encoding: 'utf8', timeout: 55000, maxBuffer: 8192, windowsHide: true }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'isolated key child must exit successfully');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, closed: true });
    assert.doesNotMatch(result.stderr, /synthetic_worker_preload_replayed/);
  }
);
