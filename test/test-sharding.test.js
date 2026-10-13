const assert = require('assert');
const { selectTestShard, testShardExitStatus } = require('../lib/test-sharding');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

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
