'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseLegacyEnrollmentArguments: parse,
  executeLegacyEnrollmentCommand: execute,
} = require('../lib/proxy/context-recovery-enrollment-command');

const directory = path.resolve(__dirname, 'synthetic-legacy-store');
const fingerprint = 'a'.repeat(64);
const previewArgs = ['preview', '--directory', directory];
const enrollArgs = ['enroll', '--directory', directory, '--fingerprint', fingerprint];
const preview = { fingerprint, storeId: 'b'.repeat(32), scopeCount: 1, maxTime: 100 };
const failed = { exitCode: 1, stdout: '', stderr: 'context_recovery_enrollment_failed\n' };

test('offline command separates metadata preview from explicit exact-fingerprint enrollment', () => {
  assert.deepEqual(parse(previewArgs), { mode: 'preview', input: { directory } });
  assert.deepEqual(parse(enrollArgs), {
    mode: 'enroll',
    input: { directory, expectedFingerprint: fingerprint },
  });
  const calls = [];
  assert.deepEqual(
    execute(previewArgs, (input) => {
      calls.push(input);
      return preview;
    }),
    {
      exitCode: 0,
      stdout: JSON.stringify({ fingerprint, scopeCount: 1, maxTime: 100 }) + '\n',
      stderr: '',
    }
  );
  assert.deepEqual(
    execute(enrollArgs, (input) => {
      calls.push(input);
      return { enrolled: true };
    }),
    { exitCode: 0, stdout: '{"enrolled":true}\n', stderr: '' }
  );
  assert.deepEqual(calls, [{ directory }, { directory, expectedFingerprint: fingerprint }]);
  assert.ok(Object.isFrozen(calls[0]));
});

test('empty, illegal, extreme and ambiguous arguments fail before touching storage', () => {
  let calls = 0;
  const inputs = [
    undefined,
    null,
    {},
    '',
    [],
    new Array(3),
    new Array(1000000),
    ['preview'],
    ['enroll', '--directory', directory],
    ['preview', '--directory', ''],
    ['preview', '--directory', '.'],
    ['preview', '--directory', path.parse(directory).root],
    ['preview', '--directory', '\\\\server\\share'],
    ['preview', '--directory', directory + '\n'],
    ['preview', '--directory', directory + '\0'],
    ['preview', '--directory', 'x'.repeat(4097)],
    ['preview', '--directory', directory, '--fingerprint', fingerprint],
    ['enroll', '--directory', directory, '--force', fingerprint],
    ['enroll', '--directory', directory, '--fingerprint', 'A'.repeat(64)],
    ['enroll', '--directory', directory, '--fingerprint', fingerprint + '\n'],
    ['enroll', '--directory', directory, '--fingerprint', 'a'.repeat(63)],
    [
      'preview',
      '--directory',
      {
        toString() {
          throw Error('PRIVATE');
        },
      },
    ],
    Object.assign([...previewArgs], { extra: true }),
  ];
  for (const input of inputs) {
    assert.deepEqual(
      execute(input, () => {
        calls++;
        return preview;
      }),
      failed
    );
  }
  assert.equal(calls, 0);
});

test('getters, Proxy traps, async owners and unsafe result serialization never run', () => {
  let touched = 0;
  const hostile = new Proxy([], {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const getter = [...previewArgs];
  Object.defineProperty(getter, '2', {
    enumerable: true,
    get() {
      touched++;
      return directory;
    },
  });
  for (const args of [hostile, getter])
    assert.deepEqual(
      execute(args, () => preview),
      failed
    );
  const resultGetter = Object.defineProperty({ ...preview }, 'fingerprint', {
    enumerable: true,
    get() {
      touched++;
      return fingerprint;
    },
  });
  const resultProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        touched++;
        return null;
      },
    }
  );
  for (const result of [
    resultGetter,
    resultProxy,
    {
      ...preview,
      toJSON() {
        touched++;
      },
    },
  ]) {
    assert.deepEqual(
      execute(previewArgs, () => result),
      failed
    );
  }
  assert.deepEqual(
    execute(previewArgs, async () => {
      touched++;
      return preview;
    }),
    failed
  );
  assert.deepEqual(
    execute(
      previewArgs,
      new Proxy(() => {}, {
        apply() {
          touched++;
        },
      })
    ),
    failed
  );
  assert.equal(touched, 0);
});

test('owner failures and malformed receipts produce only the fixed safe error', () => {
  for (const result of [
    null,
    undefined,
    [],
    Promise.resolve(preview),
    { ...preview, fingerprint: 'PRIVATE' },
    { ...preview, storeId: 'PRIVATE' },
    { ...preview, scopeCount: -1 },
    { ...preview, scopeCount: 257 },
    { ...preview, maxTime: Number.MAX_SAFE_INTEGER + 1 },
    { ...preview, maxTime: -1 },
  ])
    assert.deepEqual(
      execute(previewArgs, () => result),
      failed
    );
  for (const result of [{ enrolled: false }, { enrolled: true, extra: 'PRIVATE' }, {}]) {
    assert.deepEqual(
      execute(enrollArgs, () => result),
      failed
    );
  }
  assert.deepEqual(
    execute(enrollArgs, () => {
      throw Error('PRIVATE key token path');
    }),
    failed
  );
  assert.deepEqual(execute(previewArgs, 'PRIVATE'), failed);
  const extreme = execute(previewArgs, () => ({
    ...preview,
    scopeCount: 256,
    maxTime: Number.MAX_SAFE_INTEGER,
  }));
  assert.equal(extreme.exitCode, 0);
  assert.equal(execute(previewArgs, () => ({ ...preview, scopeCount: 0, maxTime: 0 })).exitCode, 0);
});

test('actual CLI rejects missing arguments without opening storage or exposing argv', () => {
  const cli = path.resolve(__dirname, '../lib/proxy/context-recovery-enroll-cli.js');
  const result = spawnSync(process.execPath, [cli, 'PRIVATE'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, failed.stderr);
});
