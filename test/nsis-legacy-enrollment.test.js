'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLegacyEnrollment } = require('../scripts/lib/nsis-legacy-enrollment');

function fixture() {
  const calls = [];
  const state = { nativeCalls: 0, anchorWrites: 0 };
  const fingerprint = 'a'.repeat(64);
  const options = {
    directory: 'synthetic-private-directory',
    inventory: () => [{ name: 'checkpoint.sqlite', sha256: 'b'.repeat(64), size: 100 }],
    evidence: () => ({ ...state }),
    command(args) {
      calls.push(args);
      state.nativeCalls++;
      if (args[0] === 'preview')
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ fingerprint, scopeCount: 1, maxTime: 100 }),
        };
      state.anchorWrites++;
      return { exitCode: 0, stderr: '', stdout: '{"enrolled":true}\n' };
    },
  };
  return { options, calls, state, fingerprint };
}

test('installed legacy enrollment requires native unwrap twice, one anchor commit and unchanged files', () => {
  const f = fixture();
  assert.equal(assertLegacyEnrollment(f.options), undefined);
  assert.deepEqual(f.calls, [
    ['preview', '--directory', f.options.directory],
    ['enroll', '--directory', f.options.directory, '--fingerprint', f.fingerprint],
  ]);
  assert.deepEqual(f.state, { nativeCalls: 2, anchorWrites: 1 });
});

test('failed and malformed preview never proceeds to enrollment', () => {
  for (const replacement of [
    { exitCode: 1, stderr: '', stdout: '' },
    { exitCode: 0, stderr: 'PRIVATE', stdout: '{}' },
    { exitCode: 0, stderr: '', stdout: 'x'.repeat(513) },
    { exitCode: 0, stderr: '', stdout: null },
    ...[
      'null',
      '{',
      '{}',
      '{"fingerprint":"PRIVATE","scopeCount":1,"maxTime":100}',
      JSON.stringify({ fingerprint: 'a'.repeat(64), scopeCount: 0, maxTime: 100 }),
      JSON.stringify({ fingerprint: 'a'.repeat(64), scopeCount: 1, maxTime: -1 }),
    ].map((stdout) => ({ exitCode: 0, stderr: '', stdout })),
  ]) {
    const f = fixture();
    f.options.command = () => replacement;
    assert.throws(() => assertLegacyEnrollment(f.options));
    assert.deepEqual(f.state, { nativeCalls: 0, anchorWrites: 0 });
  }
});

test('each native evidence and checkpoint preservation failure prevents qualification', () => {
  for (const phase of ['preview', 'enroll']) {
    for (const mutation of ['missing-native', 'wrong-anchor', 'changed-files', 'command-failed']) {
      const f = fixture();
      const command = f.options.command;
      const inventory = f.options.inventory;
      let changed = false;
      f.options.inventory = () => (changed ? [] : inventory());
      f.options.command = (args) => {
        const result = command(args);
        if (args[0] === phase) {
          if (mutation === 'missing-native') f.state.nativeCalls--;
          if (mutation === 'wrong-anchor') f.state.anchorWrites++;
          if (mutation === 'changed-files') changed = true;
          if (mutation === 'command-failed') return { ...result, exitCode: 1 };
        }
        return result;
      };
      assert.throws(() => assertLegacyEnrollment(f.options));
      assert.equal(f.calls.length, phase === 'preview' ? 1 : 2);
    }
  }
});

test('enrollment receipt must be the exact fixed success with no extra output', () => {
  for (const patch of [
    { stdout: '{"enrolled":false}\n' },
    { stdout: '{"enrolled":true}\nPRIVATE' },
    { stderr: 'PRIVATE' },
  ]) {
    const f = fixture();
    const command = f.options.command;
    f.options.command = (args) => {
      const result = command(args);
      return args[0] === 'enroll' ? { ...result, ...patch } : result;
    };
    assert.throws(() => assertLegacyEnrollment(f.options));
  }
});
