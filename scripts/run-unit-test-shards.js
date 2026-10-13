const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { testShardExitStatus } = require('../lib/test-sharding');

const repoRoot = path.resolve(__dirname, '..');
const runner = path.join(__dirname, 'run-unit-tests.js');
const DEFAULT_SHARD_COUNT = 4;

function runShard(index, count) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TEST_SHARD_COUNT: String(count),
        TEST_SHARD_INDEX: String(index),
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', (error) => {
      console.error(`[unit] shard ${index + 1}/${count} failed to start: ${error.message}`);
      resolve(1);
    });
    child.once('close', (code, signal) => resolve(testShardExitStatus(code, signal)));
  });
}

async function main() {
  if (process.env.TEST_SHARD_COUNT || process.env.TEST_SHARD_INDEX) {
    const count = process.env.TEST_SHARD_COUNT || '1';
    const index = process.env.TEST_SHARD_INDEX || '0';
    process.exitCode = await runShard(index, count);
    return;
  }

  const available = os.availableParallelism?.() || os.cpus().length || 1;
  const shardCount = Math.max(1, Math.min(DEFAULT_SHARD_COUNT, available));
  const exitCodes = await Promise.all(
    Array.from({ length: shardCount }, (_, index) => runShard(index, shardCount))
  );
  process.exitCode = exitCodes.some((code) => code !== 0) ? 1 : 0;
}

main().catch((error) => {
  console.error(`[unit] shard runner failed: ${error.message}`);
  process.exitCode = 1;
});
