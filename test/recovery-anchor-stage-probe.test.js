'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNativeAnchorStages,
  installAnchorStageProbe,
} = require('./helpers/recovery-anchor-stage-probe');
const phases = ['acquire', 'read', 'write', 'flush', 'readback'];
const report = (count = 5) => ({
  schemaVersion: 1,
  elapsedMs: 10,
  stages: phases.slice(0, count).map((stage) => ({ stage, elapsedMs: 1 })),
});
const json = (value) => JSON.stringify(value);
const safe = { message: 'recovery_anchor_probe_failed' };

test('native anchor stage reports admit only exact bounded successful read or compare sequences', () => {
  for (const count of [2, 5])
    assert.deepEqual(parseNativeAnchorStages(json(report(count))), report(count));
  assert.equal(parseNativeAnchorStages(json({ ...report(), elapsedMs: 10000 })).elapsedMs, 10000);
  const zero = {
    ...report(),
    elapsedMs: 0,
    stages: phases.map((stage) => ({ stage, elapsedMs: 0 })),
  };
  assert.deepEqual(parseNativeAnchorStages(json(zero)), zero);
});

test('malformed, duplicate, private, unknown, missing, extreme and inconsistent native fields fail closed', () => {
  for (const text of [
    null,
    '',
    'PRIVATE',
    'x'.repeat(1025),
    '[]',
    json(null),
    json({}),
    ' ' + json(report()),
    json(report()).replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1'),
    ...[
      { ...report(), private: 'PRIVATE' },
      { ...report(), schemaVersion: 2 },
      { ...report(), elapsedMs: -1 },
      { ...report(), elapsedMs: 1.5 },
      { ...report(), elapsedMs: 10001 },
      { ...report(), elapsedMs: 4 },
      { ...report(), stages: [] },
      { ...report(), stages: null },
      { ...report(), stages: phases.map((stage) => ({ stage, elapsedMs: '1' })) },
      { ...report(), stages: [...report().stages].reverse() },
      { ...report(), stages: report().stages.map((row) => ({ ...row, path: 'PRIVATE' })) },
      { ...report(), stages: report().stages.map((row) => ({ ...row, stage: 'PRIVATE' })) },
      {
        ...report(),
        stages: report().stages.map((row) => ({ ...row, elapsedMs: Number.MAX_SAFE_INTEGER })),
      },
      { ...report(), stages: report().stages.map((row) => ({ ...row, elapsedMs: null })) },
    ].map(json),
  ])
    assert.throws(() => parseNativeAnchorStages(text), safe);
});

function fixture(response, elapsed = 20) {
  const rows = [],
    calls = [];
  const options = {
    input: json({ operation: 'compare' }),
    timeout: 10000,
    maxBuffer: 131072,
    env: { SystemRoot: 'SYNTHETIC' },
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  let time = 0;
  const original = {
    createRecoveryAnchorRepository(input, dependencies) {
      calls.push(input);
      return dependencies.execute('synthetic.exe', ['--hpm-context-anchor-v1'], options);
    },
  };
  const load = (file) => {
    assert.ok(file.endsWith('/context-recovery-anchor.js'));
    return original;
  };
  installAnchorStageProbe(
    load,
    (...row) => rows.push(row),
    () => {
      const current = time;
      time += elapsed;
      return current;
    },
    (file, args, supplied) => {
      assert.equal(file, 'synthetic.exe');
      assert.deepEqual(args, ['--hpm-context-anchor-diagnostic-v1']);
      assert.equal(supplied, options);
      return typeof response === 'function' ? response() : response;
    }
  );
  return { original, rows, calls, options };
}

test('probe preserves original input, options and stdout while emitting only closed timing rows', () => {
  const f = fixture({ status: 0, signal: null, stdout: 'UNCHANGED_REPLY', stderr: json(report()) });
  const input = { private: 'PRIVATE' };
  assert.equal(f.original.createRecoveryAnchorRepository(input), 'UNCHANGED_REPLY');
  assert.equal(f.calls[0], input);
  assert.deepEqual(f.rows, [
    ...phases.map((p) => ['anchor_native_' + p, 1]),
    ['anchor_native_total', 10],
    ['anchor_native_dispatch', 20],
  ]);
  assert.doesNotMatch(json(f.rows), /PRIVATE|UNCHANGED|SYNTHETIC|exe|SystemRoot/);
  assert.throws(() => f.original.createRecoveryAnchorRepository(input, { execute() {} }), safe);
  const read = fixture({ status: 0, signal: null, stdout: 'READ_REPLY', stderr: json(report(2)) });
  read.options.input = json({ operation: 'read' });
  assert.equal(read.original.createRecoveryAnchorRepository({}), 'READ_REPLY');
  assert.equal(read.rows.length, 4);
});

test('child failure, timeout, malformed diagnostics, invalid duration and wrong operation emit no success rows', () => {
  const good = { status: 0, signal: null, stdout: 'PRIVATE_REPLY', stderr: json(report()) };
  for (const [response, elapsed] of [
    [{ ...good, status: 1 }, 20],
    [{ ...good, error: Error('PRIVATE') }, 20],
    [{ ...good, signal: 'SIGTERM' }, 20],
    [{ ...good, stderr: 'PRIVATE' }, 20],
    [{ ...good, stderr: json(report(2)) }, 20],
    [good, 9],
    [good, -1],
    [good, NaN],
    [
      () => {
        throw Error('PRIVATE_SPAWN');
      },
      20,
    ],
  ]) {
    const f = fixture(response, elapsed);
    assert.throws(() => f.original.createRecoveryAnchorRepository({}), safe);
    assert.deepEqual(f.rows, []);
  }
  for (const input of ['PRIVATE', json({ operation: 'unknown' }), json({ operation: 'read' })]) {
    const f = fixture(good);
    f.options.input = input;
    assert.throws(() => f.original.createRecoveryAnchorRepository({}), safe);
    assert.deepEqual(f.rows, []);
  }
});

test('executable hook arguments reject proxies and absent functions before importing modules', () => {
  for (const bad of [undefined, null, {}, new Proxy(() => {}, {})]) {
    assert.throws(() => installAnchorStageProbe(bad, () => {}), safe);
    assert.throws(() => installAnchorStageProbe(() => assert.fail(), bad), safe);
  }
});
