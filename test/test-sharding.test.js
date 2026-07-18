const assert = require('assert');
const { selectTestShard } = require('../lib/test-sharding');

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

console.log('[test-sharding.test] ok');
