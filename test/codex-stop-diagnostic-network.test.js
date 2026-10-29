'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { NETWORK_SCRIPT } = require('../scripts/lib/codex-stop-diagnostic-network');
test('independent staging network composition executes original containment and cleanup with mocked native effects', (t) => {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'codex-stop-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'network.ps1');
  fs.writeFileSync(script, NETWORK_SCRIPT);
  const r = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve(__dirname, 'fixtures/codex-stop-diagnostic-network.ps1'),
      '-Script',
      script,
      '-Repository',
      path.resolve(__dirname, '..'),
      '-FixtureRoot',
      root,
    ],
    {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 16384,
      env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', CI: '' },
    }
  );
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 11);
  for (const row of rows) {
    assert.equal(row.failed, row.mode !== 'success', row.mode + ':' + row.stage);
    assert.equal(row.hostsRestored, row.mode !== 'foreign-host-change', row.mode);
    if (row.mode === 'stop') {
      assert.equal(row.rules, 3);
      assert.equal(row.wfpDisposed, 0);
      assert.equal(row.profileEnabled, true);
    } else if (row.mode === 'remove') {
      assert.equal(row.rules, 3);
      assert.equal(row.wfpDisposed, 3);
    } else {
      assert.equal(row.rules, 0);
      assert.equal(row.profileEnabled, false);
    }
  }
  const positive = rows.find((r) => r.mode === 'success');
  assert.equal(positive.wfpCreated, 3);
  assert.equal(positive.wfpDisposed, 3);
  assert.equal(positive.certRemoved, 2);
  assert.equal(positive.stopCalls, 1);
});

test('the unchanged hosted environment guard rejects before any native network effect', (t) => {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'codex-stop-refuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'network.ps1');
  fs.writeFileSync(script, NETWORK_SCRIPT);
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const code = `$ErrorActionPreference='Stop';. ${quote(script)};$called=0;function New-SelfSignedCertificate{$script:called++;throw 'native_forbidden'};try{Invoke-HpmCodexStopDiagnosticNetwork -OwnedRoot ${quote(root)} -CandidateRoot ${quote(path.resolve(__dirname, '..'))} -StagingReceiptSha256 ('a'*64) -RunOwnedScenario {throw 'forbidden'} -StopOwnedScenario {throw 'forbidden'} 6>$null;throw 'unexpected_success'}catch{if($_.Exception.Message -cne 'n08_network_rejected'){exit 1}};if($called -ne 0){exit 1};Write-Output 'guard_rejected'`;
  const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
    env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', CI: '' },
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'guard_rejected');
  assert.equal(r.stderr, '');
});

test('actual diagnostic workflow staging commands stop at the first failed exit without retries', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../.github/workflows/codex-stop-diagnostic.yml'),
    'utf8'
  );
  const section = source.slice(
    source.indexOf('      - name: Restore original locked dependencies')
  );
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'run: |');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  const code = `$ErrorActionPreference='Stop';$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json;function npm{$script:calls++;$global:LASTEXITCODE=if($script:calls -eq $script:failAt){1}else{0}};function node{$script:calls++;$global:LASTEXITCODE=if($script:calls -eq $script:failAt){1}else{0}};$rows=@(foreach($script:failAt in 0..5){$script:calls=0;$failed=$false;try{&([scriptblock]::Create($inputData.body))}catch{$failed=$true};@{failed=$failed;calls=$script:calls;failAt=$script:failAt}});$rows|ConvertTo-Json -Compress`;
  const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    input: JSON.stringify({ body: body.join('\n') }),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.calls, row.failAt || 5);
    assert.equal(row.failed, row.failAt !== 0);
  }
});

test('fast workflow is a read-only independent acceptance push with original CLI and process bounds', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../.github/workflows/codex-stop-diagnostic.yml'),
    'utf8'
  );
  const run = fs.readFileSync(
    path.resolve(__dirname, '../scripts/lib/codex-stop-diagnostic-run.psm1'),
    'utf8'
  );
  assert.match(workflow, /branches:\s*\n\s*- acceptance\/context-recovery\/\*\*/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /client: \[codex, claude\]/);
  assert.ok(workflow.includes("Invoke-HpmCodexStopDiagnostic -Client '${{ matrix.client }}'"));
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|needs:/);
  assert.match(workflow, /paths:/);
  for (const input of [
    'scripts/diagnose-codex-stop.js',
    'scripts/lib/codex-stop-diagnostic*',
    'scripts/diagnose-claude-context.js',
    'scripts/lib/claude-context-diagnostic*.js',
    'scripts/lib/staged-client-diagnostic-policy.js',
    'lib/proxy/**',
    'tools/nsis-clients/package-lock.json',
    'scripts/lib/nsis-installed-daemon-http*.psm1',
  ])
    assert.ok(workflow.includes('- ' + input));
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /node-version: 22\.22\.3/);
  assert.ok(workflow.includes('ref: ${{ github.sha }}'));
  assert.ok(!workflow.includes('npm run verify'));
  assert.ok(!workflow.includes('tauri.js build'));
  assert.ok(!workflow.includes('build-and-npm.json'));
  assert.match(run, /Invoke-HpmInstalledHttpDriverProcess \$s -RequireNaturalExit/);
  assert.match(
    fs.readFileSync(
      path.resolve(__dirname, '../scripts/lib/nsis-installed-daemon-http.psm1'),
      'utf8'
    ),
    /240000/
  );
  const driver = fs.readFileSync(
    path.resolve(__dirname, '../scripts/lib/codex-stop-diagnostic.js'),
    'utf8'
  );
  assert.match(driver, /runCase: runInstalledClientCase/);
  assert.match(driver, /mode: 'enhanced'/);
  const staging = fs.readFileSync(
    path.resolve(__dirname, '../scripts/lib/codex-stop-diagnostic-staging.js'),
    'utf8'
  );
  assert.match(staging, /checkoutCommit\(candidate\) !== env\.GITHUB_SHA/);
  assert.match(staging, /verifyInstallation\(staging, manifestSha256\)/);
  assert.match(staging, /nativeSha256: digest\(verified.native\)/);
  assert.match(staging, /nodeSha256: digest\(verified.node\)/);
});
