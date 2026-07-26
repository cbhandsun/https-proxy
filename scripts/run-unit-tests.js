const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectTestShard } = require('../lib/test-sharding');
const { createIsolatedTestEnv } = require('../lib/test-runtime');

const repoRoot = path.resolve(__dirname, '..');
const testDir = path.join(repoRoot, 'test');

const nonUnitTests = new Set([
  'test/env-tools.test.js',
  'test/entry-auth-integration.test.js',
  'test/frontend/app-audit.test.js',
  'test/frontend/app-bridge.test.js',
  'test/frontend/app-cli.test.js',
  'test/frontend/app-diagnostics.test.js',
  'test/frontend/app-ux.test.js',
  'test/frontend/dependencies.test.js',
  'test/frontend/domain-boundaries.test.js',
  'test/frontend/frontend-build-governance.test.js',
  'test/frontend/runtime.test.js',
  'test/headers-routing.test.js',
  'test/thinking-persistence.test.js',
  'test/tool-configs.test.js',
]);

const unitTests = [
  'test/adapter.test.js',
  'test/gemini-adapter.test.js',
  'test/secret-crypto.test.js',
  'test/exception-handlers.test.js',
  'test/logger.test.js',
  'test/config-watcher.test.js',
  'test/governance/eslint-config.test.js',
  'test/runtime-migration.test.js',
  'test/governance/release-governance.test.js',
  'test/governance/release-artifact-manifest.test.js',
  'test/governance/tauri-release-wiring.test.js',
  'test/governance/installer-process-cleanup.test.js',
  'test/conversation-audit-utils.test.js',
  'test/governance/coverage-metrics.test.js',
  'test/governance/ci-governance.test.js',
  'test/cli-session-routing.test.js',
  'test/upstream-request.test.js',
  'test/upstream-retry.test.js',
  'test/test-sharding.test.js',
  'test/test-runtime.test.js',
  'test/proxy-transport.test.js',
  'test/core-request-handler.test.js',
  'test/server-lifecycle.test.js',
  'test/runtime-support.test.js',
  'test/request-observability.test.js',
  'test/runtime-config-controller.test.js',
  'test/claude-self-test-target.test.js',
  'test/route-index.test.js',
  'test/route-gemini-utils.test.js',
  'test/route-response-helpers.test.js',
  'test/responses-gemini-code-assist.test.js',
  'test/route-error-utils.test.js',
  'test/errors.test.js',
  'test/google-official.test.js',
  'test/http-client.test.js',
  'test/http-utils.test.js',
  'test/request-utils.test.js',
  'test/profile-auth.test.js',
  'test/entry-servers.test.js',
  'test/entry-auth.test.js',
  'test/local-handlers.test.js',
  'test/cert.test.js',
  'test/cert-management.test.js',
  'test/gateway-ca-trust.test.js',
  'test/claude-desktop.test.js',
  'test/management-utils.test.js',
  'test/management-auth.test.js',
  'test/management-router.test.js',
  'test/diagnostics.test.js',
  'test/models.test.js',
  'test/model-list-auth.test.js',
  'test/rate-limits.test.js',
  'test/responses-state.test.js',
  'test/responses-protocol.test.js',
  'test/routing.test.js',
  'test/safe-routing-pattern.test.js',
  'test/protocol-openai.test.js',
  'test/sse-buffer.test.js',
  'test/stream-claude.test.js',
  'test/tool-loop-guard.test.js',
  'test/tools.test.js',
  'test/metrics.test.js',
  'test/governance/module-graph.test.js',
  'test/config-protocol-version.test.js',
  'test/validator.test.js',
  'test/extension-utils.test.js',
  'test/extension-sanitize.test.js',
  'test/usage.test.js',
  'test/audit.test.js',
  'test/management-config.test.js',
  'test/management-diagnostics.test.js',
  'test/management-mcp.test.js',
  'test/management-profile.test.js',
  'test/management-models.test.js',
  'test/builtin-model-routes.test.js',
  'test/management-latency.test.js',
  'test/management-credentials.test.js',
  'test/management-rate-limits.test.js',
  'test/management-claude-desktop.test.js',
  'test/management-core.test.js',
  'test/mcp-hub.test.js',
  'test/trae-debug-center.test.js',
  'test/trae-bridge-protocol.test.js',
  'test/trae-bridge-streams.test.js',
  'test/trae-bridge-utils.test.js',
  'test/trae-status-handlers.test.js',
];

function normalizeTestPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function collectTestFiles(dir, output) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, output);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      output.push(normalizeTestPath(path.relative(repoRoot, fullPath)));
    }
  }
}

function assertUnitTestList() {
  const seen = new Set();
  for (const testFile of unitTests) {
    if (seen.has(testFile)) {
      console.error(`[unit] duplicate test entry: ${testFile}`);
      process.exit(1);
    }
    seen.add(testFile);
    if (!fs.existsSync(path.join(repoRoot, testFile))) {
      console.error(`[unit] missing test file: ${testFile}`);
      process.exit(1);
    }
  }

  const allTests = [];
  collectTestFiles(testDir, allTests);
  const allowedNonUnit = Array.from(nonUnitTests);
  for (const testFile of allowedNonUnit) {
    if (!fs.existsSync(path.join(repoRoot, testFile))) {
      console.error(`[unit] missing non-unit test file: ${testFile}`);
      process.exit(1);
    }
  }

  const covered = new Set([...unitTests, ...allowedNonUnit]);
  const unclassified = allTests.filter((testFile) => !covered.has(testFile));
  if (unclassified.length > 0) {
    console.error('[unit] unclassified test files:');
    for (const testFile of unclassified) console.error(`  - ${testFile}`);
    console.error('[unit] add each file to unitTests or nonUnitTests in scripts/run-unit-tests.js');
    process.exit(1);
  }
}

assertUnitTestList();

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
