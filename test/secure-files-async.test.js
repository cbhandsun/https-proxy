'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensurePrivateFileAsync, ensurePrivateFileSync } = require('../lib/proxy/secure-files');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-async-acl-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'private & file.txt');
  fs.writeFileSync(file, 'fixture');
  return { directory, file };
}
const windows = {
  platform: 'win32',
  currentUserSid: 'S-1-5-21-1000',
  environment: { SystemRoot: 'C:\\Windows', SAFE_FIXTURE: 'preserved' },
};

test('Async ACL uses the exact synchronous policy, separate arguments and shared successful cache', async (t) => {
  const { file } = fixture(t);
  const expected = [],
    actual = [];
  ensurePrivateFileSync(file, {
    ...windows,
    force: true,
    execFileSync(...args) {
      expected.push(args);
    },
  });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const secured = ensurePrivateFileAsync(file, {
    ...windows,
    force: true,
    async execFile(...args) {
      actual.push(args);
      await pending;
      return { stdout: '' };
    },
  });
  assert.equal(actual.length, 1);
  await new Promise(setImmediate);
  assert.equal(actual.length, 1, 'event loop runs while first ACL operation waits');
  release();
  assert.equal(await secured, path.resolve(file));
  assert.deepEqual(actual, expected);
  assert.equal(actual[0][1][0], file);
  assert.equal(actual[0][2].windowsHide, true);
  assert.equal(actual[0][2].env.SAFE_FIXTURE, 'preserved');
  assert.equal(
    ensurePrivateFileSync(file, {
      ...windows,
      execFileSync() {
        throw Error('cache_missed');
      },
    }),
    file
  );
  assert.equal(
    await ensurePrivateFileAsync(file, {
      ...windows,
      execFile() {
        throw Error('cache_missed');
      },
    }),
    file
  );
});

test('Async ACL failures never publish success and retry still enforces both operations', async (t) => {
  for (const failedAt of [1, 2]) {
    const { file } = fixture(t);
    let calls = 0;
    const failure = new Error('fixture_acl_denied');
    await assert.rejects(
      ensurePrivateFileAsync(file, {
        ...windows,
        async execFile() {
          if (++calls === failedAt) throw failure;
          return { stdout: '' };
        },
      }),
      (error) => error === failure
    );
    calls = 0;
    await ensurePrivateFileAsync(file, {
      ...windows,
      async execFile() {
        calls++;
        return { stdout: '' };
      },
    });
    assert.equal(calls, 2);
  }
});

test('Async file boundary rejects missing, empty and directory targets and retains POSIX private mode', async (t) => {
  const { directory, file } = fixture(t);
  for (const value of ['', null, 1, directory, path.join(directory, 'missing')])
    await assert.rejects(
      ensurePrivateFileAsync(value, {
        ...windows,
        execFile() {
          throw Error('must_not_execute');
        },
      })
    );
  const modes = [];
  assert.equal(
    await ensurePrivateFileAsync(file, {
      platform: 'linux',
      fsModule: {
        statSync: fs.statSync,
        chmodSync(...args) {
          modes.push(args);
        },
      },
    }),
    file
  );
  assert.deepEqual(modes, [[file, 0o600]]);
});

test('Async SID lookup rejects failures and malformed output before ACL execution', async (t) => {
  const { file } = fixture(t);
  const options = { platform: 'win32', environment: windows.environment };
  await assert.rejects(
    ensurePrivateFileAsync(file, {
      ...options,
      async execFile() {
        throw Error('fixture_lookup_failed');
      },
    }),
    /fixture_lookup_failed/
  );
  let calls = 0;
  await assert.rejects(
    ensurePrivateFileAsync(file, {
      ...options,
      async execFile() {
        calls++;
        return { stdout: 'invalid' };
      },
    }),
    /Unable to resolve/
  );
  assert.equal(calls, 1);
  const commands = [];
  await ensurePrivateFileAsync(file, {
    ...options,
    async execFile(command) {
      commands.push(path.win32.basename(command));
      return { stdout: 'fixture,S-1-5-21-1000' };
    },
  });
  assert.deepEqual(commands, ['whoami.exe', 'icacls.exe', 'icacls.exe']);
});

test('Failed forced refresh invalidates a previously secured file cache', async (t) => {
  const { file } = fixture(t);
  ensurePrivateFileSync(file, { ...windows, execFileSync() {} });
  let calls = 0;
  await assert.rejects(
    ensurePrivateFileAsync(file, {
      ...windows,
      force: true,
      async execFile() {
        if (++calls === 2) throw Error('fixture_refresh_denied');
        return { stdout: '' };
      },
    }),
    /fixture_refresh_denied/
  );
  calls = 0;
  ensurePrivateFileSync(file, {
    ...windows,
    execFileSync() {
      calls++;
    },
  });
  assert.equal(calls, 2);
});
