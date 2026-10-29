'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles } = require('../../lib/test-discovery');
const { validateConfig } = require('../../lib/proxy/validator');

const root = path.resolve(__dirname, '../..');
const scriptFiles = [
  'scripts/lib/nsis-lifecycle.psm1',
  'scripts/lib/nsis-lifecycle-runner.psm1',
  'scripts/qualify-nsis-lifecycle.ps1',
  'test/fixtures/nsis-lifecycle-mocks.ps1',
];
// Parse every production entry point without executing installer or process control code.
for (const file of scriptFiles) {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$errors = $null; $tokens = $null; [void][Management.Automation.Language.Parser]::ParseFile($env:HPM_AST_PATH, [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
    ],
    { env: { ...process.env, HPM_AST_PATH: path.join(root, file) }, encoding: 'utf8' }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const mocks = spawnSync(
  'pwsh',
  ['-NoProfile', '-NonInteractive', '-File', 'test/fixtures/nsis-lifecycle-mocks.ps1'],
  { cwd: root, encoding: 'utf8' }
);
assert.ifError(mocks.error);
assert.equal(mocks.status, 0, mocks.stderr || mocks.stdout);
assert.match(mocks.stdout, /expectedFailureCases=37;/);
assert.ok(discoverTestFiles(root).includes('test/governance/nsis-lifecycle.test.js'));
const workflow = fs
  .readFileSync(path.join(root, '.github/workflows/windows-installer-lifecycle.yml'), 'utf8')
  .replaceAll('\r\n', '\n');
assert.match(workflow, /contents: read/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /workflow_call:/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /Assert-HpmLifecycleCommitPair/);
assert.doesNotMatch(workflow, /secrets\.|upload-artifact|gh release|contents: write/);
assert.doesNotMatch(workflow, /allowDowngrades/);
assert.match(workflow, /@\{ version = \$entry\[1\] \}/);
const reviewWorkflow = fs
  .readFileSync(path.join(root, '.github/workflows/windows-installer-lifecycle-review.yml'), 'utf8')
  .replaceAll('\r\n', '\n');
assert.match(reviewWorkflow, /push:\n {4}branches:\n {6}- acceptance\/windows-lifecycle-20261022/);
assert.match(reviewWorkflow, /\n {6}- acceptance\/windows-lifecycle\/\*\*\n/);
assert.match(reviewWorkflow, /github\.event\.created == true/);
assert.match(reviewWorkflow, /github\.event\.forced == false/);
assert.match(reviewWorkflow, /github\.event\.deleted == false/);
assert.match(reviewWorkflow, /github\.event\.before == '0{40}'/);
assert.match(reviewWorkflow, /github\.repository == 'cbhandsun\/https-proxy'/);
assert.match(reviewWorkflow, /contents: read/);
assert.match(reviewWorkflow, /uses: \.\/\.github\/workflows\/windows-installer-lifecycle.yml/);
assert.match(reviewWorkflow, /baseline_sha: 2295c452888449e9728b3ddcc2f80f31e9433e69/);
assert.doesNotMatch(
  reviewWorkflow,
  /secrets:|secrets\.|upload-artifact|gh release|contents: write|pull_request|workflow_dispatch/
);
const runner = fs.readFileSync(path.join(root, 'scripts/lib/nsis-lifecycle-runner.psm1'), 'utf8');
assert.match(runner, /Invoke-LifecycleProcess \$uninstaller @\('\/S', "_\?=\$installDir"\)/);
assert.match(runner, /\$failure = \$_/);
assert.match(runner, /\$cleanupFailure = \$_/);
assert.match(runner, /Lifecycle qualification failed:/);
assert.match(runner, /Lifecycle cleanup failed:/);
const offlineFixture = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/fixtures/nsis-lifecycle-offline-config.json'), 'utf8')
);
assert.equal(validateConfig(offlineFixture).valid, true);
assert.equal(offlineFixture.appSettings.autoStartProxy, false);
assert.equal(offlineFixture.appSettings.upstreamWarmupEnabled, false);
assert.deepEqual(offlineFixture.entryServers, []);
assert.deepEqual(offlineFixture.entryAuth.keys, []);
assert.deepEqual(offlineFixture.mcpHub.servers, []);
assert.ok(
  offlineFixture.profiles.every(
    (profile) => profile.apiKey === '' && new URL(profile.targetUrl).hostname === '127.0.0.1'
  )
);
// Expressions carrying external input belong in env/with, never in shell program text.
const shellBlocks = [...workflow.matchAll(/run: \|\n((?: {10}.*\n|\n)*)/g)];
assert.ok(shellBlocks.length >= 5, 'workflow shell blocks must be inspected');
for (const block of shellBlocks) {
  assert.doesNotMatch(block[1], /\$\{\{/);
}
