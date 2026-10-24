'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pwsh = process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh';
function receipt() {
  return {
    schemaVersion: 1,
    scope: 'installed_native_cli_four_cases',
    passed: true,
    syntheticClientQualified: true,
    realProviderQualified: false,
    retention24hQualified: false,
    realModelRequests: 0,
    probesPassed: true,
    tlsVerified: true,
    nonLoopbackBlocked: true,
    listenerOwned: true,
    ownedTreeEmpty: true,
    syntheticSocketsClosed: true,
    cases: ['codex', 'claude'].flatMap((client) =>
      ['default', 'enhanced'].map((mode) => ({
        client,
        mode,
        compactions: 3,
        exactFinalAnswer: true,
        defaultZeroRecovery: mode === 'default',
        privateRead: mode === 'enhanced',
        publicGeneration: mode === 'enhanced',
      }))
    ),
  };
}

test('installed CLI preparation and orchestration execute original closed callbacks with mocked external processes', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-client-inputs-unit-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  const runner = path.join(temporary, 'runner');
  fs.mkdirSync(runner);
  const names = [
    ...[
      'nsis-client-inputs',
      'nsis-client-orchestration',
      'nsis-client-matrix-receipt',
      'nsis-installed-client-payload',
      'nsis-lifecycle',
      'nsis-runtime-boundary',
      'nsis-installed-daemon-http',
    ].map((name) => 'scripts/lib/' + name + '.psm1'),
    ...['hosted-materials', 'hosted-network'].map(
      (name) => 'scripts/context-hosted/shared/' + name + '.ps1'
    ),
    'tools/nsis-clients/package.json',
    'tools/nsis-clients/package-lock.json',
  ];
  for (const name of names) {
    const destination = path.join(workspace, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, name), destination);
  }
  fs.writeFileSync(
    path.join(workspace, 'scripts/lib/nsis-installed-client-matrix.cjs'),
    '// synthetic path sentinel; never executed\n'
  );
  const receiptFile = path.join(temporary, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify(receipt()));
  const result = spawnSync(
    pwsh,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(root, 'test/fixtures/context-hosted/installed-client-inputs.ps1'),
      '-Repository',
      workspace,
      '-FixtureRoot',
      runner,
      '-ReceiptFile',
      receiptFile,
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16384,
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        RUNNER_ENVIRONMENT: '',
        RUNNER_OS: '',
        CI: '',
        NODE_OPTIONS: 'synthetic-removal-sentinel',
      },
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('synthetic-removal-sentinel'), false);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 13);
  for (const row of rows) {
    if (['success', 'crlf'].includes(row.mode)) {
      assert.equal(row.error, null);
      assert.equal(row.receipt.matrix.syntheticClientQualified, true);
      assert.equal(row.receipt.matrix.realProviderQualified, false);
      assert.equal(row.receipt.uninstalled, true);
    } else assert.equal(row.error, 'nsis_installed_clients_failed', row.mode);
    if (['proof', 'proofhash', 'proofduplicate', 'lock'].includes(row.mode))
      assert.equal(row.npm, 0, row.mode);
    else assert.equal(row.npm, 1, row.mode);
    if (['proof', 'proofhash', 'proofduplicate', 'lock', 'npm', 'drift'].includes(row.mode))
      assert.equal(row.payload, 0, row.mode);
    else assert.equal(row.payload, 1, row.mode);
    if (row.mode === 'package') {
      assert.equal(row.leasesDisposed, 1);
      assert.equal(row.network, 0);
    }
    if (row.driver) {
      assert.equal(row.leasesDisposed, 2, row.mode);
      assert.equal(row.networkStopped, row.mode !== 'cleanup', row.mode);
      assert.equal(row.payloadStopped, row.mode !== 'cleanup', row.mode);
    }
  }
});

test('strict four-case receipt rejects duplicate fields, missing gates, wrong case order and excess output', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-client-receipt-unit-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const examples = [JSON.stringify(receipt())];
  for (const change of [
    (value) => {
      value.cases.reverse();
    },
    (value) => {
      value.cases[0].defaultZeroRecovery = false;
    },
    (value) => {
      value.cases[1].privateRead = false;
    },
    (value) => {
      value.retention24hQualified = true;
    },
    (value) => {
      value.realModelRequests = 1;
    },
    (value) => {
      value.ownedTreeEmpty = false;
    },
    (value) => {
      value.passed = 'true';
    },
    (value) => {
      value.extra = 'unsafe';
    },
  ]) {
    const value = receipt();
    change(value);
    examples.push(JSON.stringify(value));
  }
  examples.push(examples[0].replace('"passed":true', '"passed":true,"passed":true'));
  examples.push('x'.repeat(4097));
  const file = path.join(temporary, 'examples.json');
  fs.writeFileSync(file, JSON.stringify(examples));
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `
    $ErrorActionPreference = 'Stop'
    Import-Module ${quote(path.join(root, 'scripts/lib/nsis-client-matrix-receipt.psm1'))} -Force
    $examples = [IO.File]::ReadAllText(${quote(file)}) | ConvertFrom-Json
    $rows = @()
    foreach ($text in $examples) { try { $null = ConvertFrom-HpmInstalledClientMatrixReceipt $text; $rows += $true } catch { $rows += $false } }
    $rows | ConvertTo-Json -Compress
  `;
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    examples.map((_value, index) => index === 0)
  );
});

test('preparation rejects non-hosted invocation before reading proof or launching npm', () => {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `
    $ErrorActionPreference = 'Stop'
    $env:CI = ''; $env:GITHUB_ACTIONS = ''; $env:RUNNER_ENVIRONMENT = ''
    $module = Import-Module ${quote(path.join(root, 'scripts/lib/nsis-client-inputs.psm1'))} -Force -PassThru
    & $module {
      $script:touched = $false
      function script:Read-HpmClientPreparation { $script:touched = $true; throw 'fixture_invalid' }
      $code = $null
      try { $null = Initialize-HpmInstalledClientTools ('a' * 40) ('b' * 64) } catch { $code = $_.Exception.Message }
      @{ code = $code; touched = $script:touched } | ConvertTo-Json -Compress
    }
  `;
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    code: 'installed_client_preparation_rejected',
    touched: false,
  });
});

test('phase diagnostics disclose only fixed enums and preserve invalid or missing input as unobserved', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-client-phase-unit-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `
    $ErrorActionPreference = 'Stop'
    Import-Module ${quote(path.join(root, 'scripts/lib/nsis-client-matrix-receipt.psm1'))} -Force
    $owned = ${quote(temporary)}
    Write-HpmInstalledClientPhase $owned
    $file = Join-Path $owned 'matrix-phase.json'
    foreach ($text in @(
      '{"schemaVersion":1,"phase":"complete","failed":false}',
      '{"schemaVersion":1,"phase":"claude-enhanced-cli","failed":true}',
      '{"schemaVersion":1,"phase":"unknown-sensitive-sentinel","failed":true}',
      '{"schemaVersion":1,"phase":"complete","failed":false,"failed":false}',
      '{"schemaVersion":1,"phase":"complete","failed":"true"}',
      ('x' * 513)
    )) {
      [IO.File]::WriteAllText($file, $text)
      Write-HpmInstalledClientPhase $owned
    }
  `;
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('sensitive-sentinel'), false);
  assert.deepEqual(
    result.stdout.trim().split(/\r?\n/),
    [
      'unobserved',
      'complete',
      'claude-enhanced-cli',
      'unobserved',
      'unobserved',
      'unobserved',
      'unobserved',
    ].map((phase) => 'hpm_installed_client_phase=' + phase)
  );
});
