'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { diagnoseStorageOpen } = require('../scripts/lib/context-recovery-open-diagnostic');

const directory = path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-unused-diagnostic');
const secret = 'PRIVATE_DIAGNOSTIC_SENTINEL';
function backend(mode) {
  const calls = [];
  return {
    calls,
    async open(options) {
      calls.push(options.directory);
      assert.deepEqual(Object.keys(options), ['directory', 'onStartup']);
      options.onStartup({ phase: 'worker_started', elapsedMs: 0 });
      if (mode === 'open') throw Error(secret);
      if (mode === 'event') options.onStartup({ phase: secret, elapsedMs: 0 });
      if (mode === 'getter')
        options.onStartup({
          get phase() {
            throw Error(secret);
          },
          elapsedMs: 0,
        });
      options.onStartup({ phase: 'engine_ready', elapsedMs: 1 });
      if (mode !== 'missing')
        options.onStartup({ phase: mode === 'failed' ? 'failed' : 'ready', elapsedMs: 1 });
      if (mode === 'duplicate') options.onStartup({ phase: 'ready', elapsedMs: 1 });
      return {
        async execute(request) {
          calls.push(request.operation);
          if (mode === 'inspect') throw Error(secret);
          return mode === 'nonempty' ? { records: 1, bytes: 32 } : { records: 0, bytes: 0 };
        },
        async close() {
          calls.push('close');
          if (mode === 'close') throw Error(secret);
        },
      };
    },
  };
}

test('diagnostic uses the same directory twice, closes before reopen and never supplies deadline overrides', async () => {
  const f = backend();
  const result = await diagnoseStorageOpen(directory, f.open);
  assert.equal(result.passed, true);
  assert.equal(result.completedOpens, 2);
  assert.equal(result.completedCloses, 2);
  assert.deepEqual(f.calls, [directory, 'inspect', 'close', directory, 'inspect', 'close']);
  assert.deepEqual(
    result.events.map((e) => e.phase),
    ['worker_started', 'engine_ready', 'ready', 'worker_started', 'engine_ready', 'ready']
  );
  assert.deepEqual(
    result.events.map((e) => e.attempt),
    [1, 1, 1, 2, 2, 2]
  );
});

test('diagnostic refuses failed opens, reads, close, invalid phases and executable events without retry or disclosure', async () => {
  for (const mode of [
    'open',
    'inspect',
    'close',
    'event',
    'getter',
    'nonempty',
    'missing',
    'failed',
    'duplicate',
  ]) {
    const f = backend(mode);
    const result = await diagnoseStorageOpen(directory, f.open);
    assert.equal(result.passed, false, mode);
    assert.equal(f.calls.filter((c) => c === directory).length, 1);
    assert.equal(f.calls.filter((c) => c === 'close').length, mode === 'open' ? 0 : 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('invalid directories and openers fail before storage acquisition', async () => {
  let calls = 0;
  for (const value of ['', 'relative', null, {}, 'x'.repeat(5000)]) {
    assert.equal(
      (
        await diagnoseStorageOpen(value, () => {
          calls++;
        })
      ).passed,
      false
    );
  }
  assert.equal(calls, 0);
  for (const value of [null, {}, 1])
    assert.equal((await diagnoseStorageOpen(directory, value)).passed, false);
});

test('CLI rejects arguments and reports unsupported platform without claiming a native open', () => {
  const cli = path.resolve(__dirname, '../scripts/diagnose-context-recovery-open.js');
  const invalid = spawnSync(process.execPath, [cli, secret], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes(secret), false);
  if (process.platform === 'win32') return;
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const [identity, blocked] = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(identity.storageResolvedToCheckout, true);
  assert.deepEqual(identity.progressExports, ['createStorageStartupProgress']);
  assert.match(identity.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(blocked, { event: 'blocked', reason: 'windows_required', attempted: false });
});
