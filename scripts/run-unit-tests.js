const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const { selectTestShard, testShardExitStatus } = require('../lib/test-sharding');
const { createIsolatedTestEnv, resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');

const repoRoot = path.resolve(__dirname, '..');
const dedicatedTestFiles = [
  'test/env-tools.test.js',
  'test/entry-auth-integration.test.js',
  'test/headers-routing.test.js',
  'test/thinking-persistence.test.js',
  'test/tool-configs.test.js',
  // Real Git + third-party CLI integration runs serially through test:hooks,
  // also required by npm test, verify and the CI node-quality job.
  'test/lint-staged-security.test.js',
];
const unitTests = selectUnitTestFiles(discoverTestFiles(repoRoot), {
  excludedFiles: dedicatedTestFiles,
  excludedPrefixes: ['test/frontend/'],
});

let shard;
try {
  shard = selectTestShard(unitTests, process.env);
} catch (error) {
  console.error(`[unit] ${error.message}`);
  process.exit(1);
}

let failedFiles = 0;
for (const testFile of shard.tests) {
  const testRuntimeDir = fs.mkdtempSync(
    path.join(resolvePhysicalTestTempDirectory(), 'hpm-unit-runtime-')
  );
  let result;
  try {
    result = spawnSync(process.execPath, [testFile], {
      cwd: repoRoot,
      env: createIsolatedTestEnv(process.env, testRuntimeDir),
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(testRuntimeDir, { recursive: true, force: true });
  }
  if (testShardExitStatus(result.status, result.signal) !== 0) {
    console.error(`[unit] failed: ${testFile}`);
    failedFiles++;
  }
}

if (failedFiles) {
  console.error(
    `[unit] completed: ${shard.tests.length}/${unitTests.length} test files (shard ${shard.index + 1}/${shard.count}); failed: ${failedFiles}`
  );
  process.exitCode = 1;
} else {
  console.log(
    `[unit] ok: ${shard.tests.length}/${unitTests.length} test files (shard ${shard.index + 1}/${shard.count})`
  );
}
