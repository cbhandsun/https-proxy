function readSafeInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function selectTestShard(tests, env = {}) {
  if (!Array.isArray(tests)) throw new TypeError('tests must be an array');
  const count = readSafeInteger(env, 'TEST_SHARD_COUNT', 1);
  const index = readSafeInteger(env, 'TEST_SHARD_INDEX', 0);
  if (count < 1 || index < 0 || index >= count) {
    throw new RangeError('expected 0 <= TEST_SHARD_INDEX < TEST_SHARD_COUNT');
  }
  if (tests.length > 0 && count > tests.length) {
    throw new RangeError('TEST_SHARD_COUNT cannot exceed the number of tests');
  }
  return {
    count,
    index,
    tests: tests.filter((_, testIndex) => testIndex % count === index),
  };
}

function testShardExitStatus(code, signal) {
  // Only an explicit normal exit qualifies. A signal yields a null exit code;
  // treating that falsy value as zero would manufacture a successful gate.
  return code === 0 && signal === null ? 0 : 1;
}

module.exports = { selectTestShard, testShardExitStatus };
