'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ensurePrivateFileSync, renamePrivateFileSync } = require('../lib/proxy/secure-files');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-private-rename-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, '.source & fixture.tmp');
  const target = path.join(directory, 'target.txt');
  fs.writeFileSync(source, 'new fixture');
  fs.writeFileSync(target, 'old fixture');
  return { directory, source, target };
}
function windows(calls, extra = {}) {
  return {
    platform: 'win32',
    currentUserSid: 'S-1-5-21-1000',
    execFileSync(...args) {
      calls.push(args);
    },
    ...extra,
  };
}

test('Same-directory private rename preserves secured identity without repeating ACL subprocesses', (t) => {
  const { source, target } = fixture(t);
  const calls = [],
    options = windows(calls);
  ensurePrivateFileSync(source, options);
  assert.equal(calls.length, 2);
  assert.equal(renamePrivateFileSync(source, target, options), target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new fixture');
  assert.equal(fs.existsSync(source), false);
  ensurePrivateFileSync(target, options);
  assert.equal(calls.length, 2);
  fs.writeFileSync(source, 'replacement');
  ensurePrivateFileSync(source, options);
  assert.equal(calls.length, 4, 'old temporary path must not retain success for a new file');
});

test('Unprotected sources are secured before promotion; ACL or rename failure preserves the old target', (t) => {
  for (const failure of ['acl', 'rename']) {
    const { source, target } = fixture(t);
    const calls = [];
    const options = windows(calls, {
      execFileSync() {
        if (failure === 'acl') throw Error('fixture_acl_denied');
      },
      fsModule: {
        statSync: fs.statSync,
        renameSync() {
          throw Error('fixture_rename_failed');
        },
      },
    });
    assert.throws(() => renamePrivateFileSync(source, target, options), /fixture_/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old fixture');
    assert.equal(fs.readFileSync(source, 'utf8'), 'new fixture');
  }
  const { source, target } = fixture(t);
  const calls = [];
  renamePrivateFileSync(source, target, windows(calls));
  assert.equal(calls.length, 2);
});

test('Changed or unsafe file identity falls back to full protection and does not silently retain a stale cache', (t) => {
  for (const change of ['inode', 'device', 'birthtime', 'unsafe', 'zero', 'unknown']) {
    const { source, target } = fixture(t);
    const calls = [];
    let renamed = false;
    const fsModule = {
      renameSync(from, to) {
        assert.equal(from, source);
        assert.equal(to, target);
        renamed = true;
      },
      statSync(file, options) {
        const stat = fs.statSync(source, options);
        if (renamed && file === target) {
          if (change === 'inode') stat.ino += typeof stat.ino === 'bigint' ? 1n : 1;
          if (change === 'device') stat.dev += typeof stat.dev === 'bigint' ? 1n : 1;
          if (change === 'birthtime') stat.birthtimeNs = (stat.birthtimeNs ?? 0n) + 1n;
        }
        if (change === 'unsafe') stat.ino = Number.MAX_SAFE_INTEGER + 1;
        if (change === 'zero') stat.ino = 0;
        if (change === 'unknown') stat.birthtimeNs = undefined;
        return stat;
      },
    };
    renamePrivateFileSync(source, target, windows(calls, { fsModule }));
    assert.equal(calls.length, 4, change);
  }
});

test('Private rename rejects empty, invalid, missing and cross-directory paths before side effects', (t) => {
  const { directory, source, target } = fixture(t);
  const calls = [],
    options = windows(calls);
  for (const value of [null, 1, '', path.join(directory, 'missing'), directory])
    assert.throws(() => renamePrivateFileSync(value, target, options));
  for (const value of [
    null,
    1,
    '',
    'invalid\0path',
    'a'.repeat(32768),
    path.join(directory, 'nested', 'target'),
  ])
    assert.throws(() => renamePrivateFileSync(source, value, options));
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old fixture');
});

test('A fallback ACL failure after promotion is reported and cannot create a target success cache', (t) => {
  const { source, target } = fixture(t);
  let renamed = false,
    denied = true,
    calls = 0;
  const options = windows([], {
    fsModule: {
      renameSync(from, to) {
        assert.equal(from, source);
        assert.equal(to, target);
        renamed = true;
      },
      statSync(file, options) {
        const stat = fs.statSync(source, options);
        if (renamed && file === target) stat.ino += typeof stat.ino === 'bigint' ? 1n : 1;
        return stat;
      },
    },
    execFileSync() {
      calls++;
      if (renamed && denied) throw Error('fixture_target_acl_failed');
    },
  });
  assert.throws(() => renamePrivateFileSync(source, target, options), /fixture_target_acl_failed/);
  denied = false;
  calls = 0;
  ensurePrivateFileSync(target, options);
  assert.equal(calls, 2);
});

test('Windows security cache distinguishes adjacent 64-bit file identities beyond Number precision', (t) => {
  const { source } = fixture(t);
  let identity = 9007199254740992n;
  const calls = [],
    options = windows(calls, {
      fsModule: {
        statSync(file, mode) {
          const stat = fs.statSync(file, mode);
          stat.ino = mode?.bigint ? identity : Number(identity);
          return stat;
        },
      },
    });
  ensurePrivateFileSync(source, options);
  assert.equal(calls.length, 2);
  identity++;
  ensurePrivateFileSync(source, options);
  assert.equal(calls.length, 4);
});

test('Windows temporary rename locks retry within 30ms; permanent and non-Windows errors retain the original failure', (t) => {
  for (const code of ['EPERM', 'EBUSY']) {
    const { source, target } = fixture(t);
    let attempts = 0;
    const waits = [],
      calls = [];
    renamePrivateFileSync(
      source,
      target,
      windows(calls, {
        waitForRetry(ms) {
          waits.push(ms);
        },
        fsModule: {
          statSync: fs.statSync,
          renameSync(from, to) {
            if (++attempts < 3) throw Object.assign(Error('fixture_temporary_lock'), { code });
            fs.renameSync(from, to);
          },
        },
      })
    );
    assert.deepEqual(waits, [10, 20]);
    assert.equal(attempts, 3);
    assert.equal(calls.length, 2);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new fixture');
  }
  for (const [platform, code, expected] of [
    ['win32', 'EPERM', 3],
    ['win32', 'EBUSY', 3],
    ['win32', 'EIO', 1],
    ['linux', 'EPERM', 1],
  ]) {
    const { source, target } = fixture(t);
    let attempts = 0;
    const error = Object.assign(Error('fixture_permanent_failure'), { code });
    assert.throws(
      () =>
        renamePrivateFileSync(
          source,
          target,
          windows([], {
            platform,
            waitForRetry() {},
            fsModule: {
              statSync: fs.statSync,
              chmodSync() {},
              renameSync() {
                attempts++;
                throw error;
              },
            },
          })
        ),
      (value) => value === error
    );
    assert.equal(attempts, expected);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old fixture');
  }
});

test('POSIX private rename keeps mode 0600 and enforces target protection after promotion', (t) => {
  const { source, target } = fixture(t);
  const chmod = [];
  renamePrivateFileSync(source, target, {
    platform: 'linux',
    fsModule: {
      statSync: fs.statSync,
      renameSync: fs.renameSync,
      chmodSync(file, mode) {
        chmod.push([file, mode]);
      },
    },
  });
  assert.deepEqual(chmod, [
    [source, 0o600],
    [target, 0o600],
  ]);
});
