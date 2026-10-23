'use strict';
// Pure invocation boundary only. Actual descriptor/registry/native access is
// exercised by context-recovery-key.test.js on the disposable Windows runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { verifyIndependentAcl } = require('./helpers/independent-acl-readback.cjs');
const items = () =>
  ['directory', 'file', 'directory', 'file'].map((kind, i) => ({
    kind,
    path: 'C:\\synthetic\\原文' + i,
  }));
const base = { systemRoot: 'C:\\Windows', programFiles: 'C:\\Program Files' };
const rejected = /^Error: independent_acl_readback_failed$/;

test('independent ACL verification prefers installed PowerShell 7 and preserves the original bounded private invocation', () => {
  for (const available of [true, false]) {
    let calls = 0;
    assert.equal(
      verifyIndependentAcl(items(), {
        ...base,
        exists(executable) {
          assert.equal(executable, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
          return available;
        },
        execute(executable, args, options) {
          calls++;
          assert.equal(
            executable,
            available
              ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
              : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
          );
          assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
          assert.equal(
            args.some((value) => value.includes('原文')),
            false
          );
          assert.deepEqual(JSON.parse(options.input), items());
          assert.equal(options.timeout, 10000);
          assert.equal(options.maxBuffer, 1024);
          assert.equal(options.windowsHide, true);
          assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
          return 'verified';
        },
      }),
      'verified'
    );
    assert.equal(calls, 1);
  }
});

test('independent verifier never retries through another shell after a dispatched failure or accepts malformed output', () => {
  for (const output of [
    null,
    undefined,
    '',
    'verified\n',
    '{}',
    Buffer.from('verified'),
    'PRIVATE',
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        verifyIndependentAcl(items(), {
          ...base,
          exists: () => true,
          execute() {
            calls++;
            return output;
          },
        }),
      rejected
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.throws(
    () =>
      verifyIndependentAcl(items(), {
        ...base,
        exists: () => true,
        execute() {
          calls++;
          throw new Error('PRIVATE');
        },
      }),
    rejected
  );
  assert.equal(calls, 1);
});

test('independent verification rejects empty, sparse, malformed, excessive and executable targets before spawn', () => {
  let calls = 0,
    traps = 0;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  const accessor = {
    get path() {
      traps++;
      throw new Error('PRIVATE');
    },
    kind: 'file',
  };
  const sparse = items();
  delete sparse[1];
  sparse.extra = {};
  for (const input of [
    null,
    [],
    items().slice(1),
    [...items(), items()[0]],
    sparse,
    [proxy, ...items().slice(1)],
    [accessor, ...items().slice(1)],
    ...['relative', '\\\\host\\share', 'C:\\bad\npath', 'C:\\' + 'x'.repeat(4096)].map((path) => [
      { path, kind: 'file' },
      ...items().slice(1),
    ]),
    [{ path: 'C:\\safe', kind: 'unknown' }, ...items().slice(1)],
  ])
    assert.throws(
      () =>
        verifyIndependentAcl(input, {
          ...base,
          exists: () => true,
          execute() {
            calls++;
            return 'verified';
          },
        }),
      rejected
    );
  assert.equal(calls, 0);
  assert.equal(traps, 0);
});

test('independent verifier rejects explicitly invalid invocation dependencies', () => {
  let calls = 0;
  for (const key of ['execute', 'exists']) {
    for (const value of [null, undefined, false, {}, new Proxy(() => {}, {})]) {
      assert.throws(
        () =>
          verifyIndependentAcl(items(), {
            ...base,
            exists: () => true,
            execute() {
              calls++;
              return 'verified';
            },
            [key]: value,
          }),
        rejected
      );
    }
  }
  assert.equal(calls, 0);
});

test(
  'independent PowerShell verifier retains every original ACL refusal with fake descriptors only',
  { timeout: 45000 },
  () => {
    for (const mode of [
      'valid',
      'kind',
      'unprotected',
      'missing',
      'broad',
      'deny',
      'rights',
      'inherited',
      'flags',
    ]) {
      let calls = 0;
      let observed;
      const invoke = () =>
        verifyIndependentAcl(items(), {
          ...base,
          exists: () => true,
          execute(_executable, args, options) {
            calls++;
            const result = spawnSync(
              'pwsh',
              [
                '-NoProfile',
                '-NonInteractive',
                '-File',
                'test/fixtures/independent-acl-readback-mocks.ps1',
              ],
              {
                ...options,
                input: JSON.stringify({ script: args[3], items: JSON.parse(options.input), mode }),
              }
            );
            observed = result;
            if (result.status !== 0) throw new Error('synthetic_descriptor_refused');
            return result.stdout;
          },
        });
      if (mode === 'valid') assert.equal(invoke(), 'verified');
      else assert.throws(invoke, rejected);
      assert.equal(calls, 1);
      assert.ok(observed);
      assert.ifError(observed.error);
      assert.equal(observed.status, mode === 'valid' ? 0 : 1);
      assert.equal(observed.stderr, '');
    }
  }
);
