const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const { selectTestShard } = require('../lib/test-sharding');
const { createIsolatedTestEnv } = require('../lib/test-runtime');

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

for (const testFile of shard.tests) {
  const testRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-unit-runtime-'));
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
  if (result.status !== 0) {
    console.error(`[unit] failed: ${testFile}`);
    process.exit(result.status || 1);
  }
}

console.log(
  `[unit] ok: ${shard.tests.length}/${unitTests.length} test files (shard ${shard.index + 1}/${shard.count})`
);
