const assert = require('assert');
const { selectTestShard, testShardExitStatus } = require('../lib/test-sharding');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tests = ['a', 'b', 'c', 'd', 'e'];

assert.deepStrictEqual(selectTestShard(tests), {
  count: 1,
  index: 0,
  tests,
});
assert.deepStrictEqual(selectTestShard(tests, { TEST_SHARD_COUNT: '2', TEST_SHARD_INDEX: '1' }), {
  count: 2,
  index: 1,
  tests: ['b', 'd'],
});
assert.throws(() => selectTestShard(tests, { TEST_SHARD_COUNT: '0' }), RangeError);
assert.throws(
  () => selectTestShard(tests, { TEST_SHARD_COUNT: '2', TEST_SHARD_INDEX: '2' }),
  RangeError
);
assert.throws(() => selectTestShard(tests, { TEST_SHARD_COUNT: 'Infinity' }), TypeError);
assert.throws(() => selectTestShard(tests, { TEST_SHARD_INDEX: '-1' }), RangeError);
assert.throws(() => selectTestShard(tests, { TEST_SHARD_COUNT: '6' }), RangeError);
assert.throws(() => selectTestShard(null), TypeError);

for (let count = 1; count <= tests.length; count++) {
  const selected = Array.from(
    { length: count },
    (_, index) =>
      selectTestShard(tests, {
        TEST_SHARD_COUNT: String(count),
        TEST_SHARD_INDEX: String(index),
      }).tests
  ).flat();
  assert.strictEqual(selected.length, tests.length);
  assert.strictEqual(new Set(selected).size, tests.length);
  assert.deepStrictEqual([...selected].sort(), [...tests].sort());
}

console.log('[test-sharding.test] ok');

test('only explicit normal zero exit qualifies a test shard as successful', () => {
  assert.strictEqual(testShardExitStatus(0, null), 0);
  for (const [code, signal] of [
    [7, null],
    [null, 'SIGTERM'],
    [null, null],
    [undefined, undefined],
    [0, 'SIGTERM'],
    [0, undefined],
    [0, ''],
    ['0', null],
    [false, null],
    [NaN, null],
    [Infinity, null],
    [-1, null],
    [Number.MAX_SAFE_INTEGER, null],
    [{ valueOf: () => 0 }, null],
  ])
    assert.strictEqual(testShardExitStatus(code, signal), 1);
});

function executeUnitRunner(outcomes) {
  const selected = outcomes.map((_, index) => 'test/fixture-' + index + '.test.js');
  const executed = [],
    removed = [],
    messages = [];
  const runtimeProcess = {
    env: {},
    execPath: process.execPath,
    exitCode: undefined,
    exit(code) {
      this.exitCode = code;
      throw stopped;
    },
  };
  const stopped = new Error('runner_stopped');
  const dependencies = {
    fs: {
      mkdtempSync: () => 'synthetic-runtime-' + executed.length,
      rmSync: (directory) => removed.push(directory),
    },
    os: { tmpdir: () => 'synthetic-temp' },
    path,
    child_process: {
      spawnSync(executable, [file]) {
        assert.strictEqual(executable, process.execPath);
        const index = executed.push(file) - 1;
        return outcomes[index];
      },
    },
    '../lib/test-discovery': {
      discoverTestFiles: () => selected,
      selectUnitTestFiles: (files) => files,
    },
    '../lib/test-sharding': { selectTestShard, testShardExitStatus },
    '../lib/test-runtime': { createIsolatedTestEnv: () => ({}) },
  };
  const filename = path.resolve(__dirname, '../scripts/run-unit-tests.js');
  try {
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      __dirname: path.dirname(filename),
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name));
        return dependencies[name];
      },
      process: runtimeProcess,
      console: {
        log: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
    });
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return { executed, removed, messages, exitCode: runtimeProcess.exitCode ?? 0, selected };
}

test('unit runner completes every selected file and cleanup after multiple child failures', () => {
  const outcome = executeUnitRunner([
    { status: 2, signal: null },
    { status: 0, signal: null },
    { status: null, signal: 'SIGTERM' },
    { status: 0, signal: null },
  ]);
  assert.deepStrictEqual(outcome.executed, outcome.selected);
  assert.strictEqual(outcome.removed.length, 4);
  assert.strictEqual(outcome.exitCode, 1);
  assert.ok(outcome.messages.some((message) => message.includes('failed: test/fixture-0.test.js')));
  assert.ok(outcome.messages.some((message) => message.includes('failed: test/fixture-2.test.js')));
  assert.ok(outcome.messages.some((message) => message.includes('completed: 4/4')));
  assert.ok(outcome.messages.some((message) => message.includes('failed: 2')));
  assert.ok(outcome.messages.every((message) => !message.includes('[unit] ok:')));
});

test('unit runner keeps empty and entirely successful shards green', () => {
  for (const outcomes of [
    [],
    [
      { status: 0, signal: null },
      { status: 0, signal: null },
    ],
  ]) {
    const outcome = executeUnitRunner(outcomes);
    assert.deepStrictEqual(outcome.executed, outcome.selected);
    assert.strictEqual(outcome.removed.length, outcomes.length);
    assert.strictEqual(outcome.exitCode, 0);
    assert.ok(outcome.messages.some((message) => message.includes('[unit] ok:')));
  }
});

test('unit runner preserves abnormal and spawn failures without printing error content', () => {
  for (const result of [
    { status: null, signal: null, error: new Error('synthetic-private-error') },
    { status: 0, signal: 'SIGTERM' },
    { status: undefined, signal: undefined },
    { status: NaN, signal: null },
  ]) {
    const outcome = executeUnitRunner([result, { status: 0, signal: null }]);
    assert.strictEqual(outcome.executed.length, 2);
    assert.strictEqual(outcome.removed.length, 2);
    assert.strictEqual(outcome.exitCode, 1);
    assert.ok(outcome.messages.every((message) => !message.includes('synthetic-private-error')));
  }
});

test(
  'actual signalled child close cannot produce a green shard result',
  { timeout: 15000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    assert.strictEqual(child.kill(), true);
    const [code, signal] = await closed;
    assert.strictEqual(testShardExitStatus(code, signal), 1);
  }
);
