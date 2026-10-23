'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles } = require('../lib/test-discovery');

test('PowerShell orderly reopen parser rejects malformed receipts without starting product children', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'test/fixtures/nsis-runtime-boundary-mocks.ps1',
      '-ReceiptsOnly',
    ],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 8192 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(
    result.stdout,
    /runtimeExpectedFailures=\d+; safeChildProcesses=0; installerExecutions=0; networkRequests=0/
  );
});

test('PowerShell runtime boundaries validate receipts and bound actual safe child processes', () => {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', 'test/fixtures/nsis-runtime-boundary-mocks.ps1'],
    {
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 32768,
      env: { ...process.env, HPM_TEST_NODE: process.execPath },
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /runtimeExpectedFailures=\d+; safeChildProcesses=\d+; installerExecutions=0; networkRequests=0/
  );
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CHILD_SENTINEL/);
  assert.deepEqual(
    [...result.stdout.matchAll(/hpm_runtime_child_failed_stage=([a-z_]+)/g)].map(
      (match) => match[1]
    ),
    [
      'output_limit',
      'output_limit',
      ...Array(40).fill('child_exit'),
      'stdout_decode',
      'deadline',
      'deadline',
    ]
  );
  assert.deepEqual(
    [...result.stdout.matchAll(/hpm_runtime_child_exit_code=([a-z0-9]+)/g)].map(
      (match) => match[1]
    ),
    [
      'other',
      '64',
      '69',
      '72',
      '73',
      '84',
      'other',
      '86',
      '94',
      '95',
      '96',
      'other',
      '98',
      '99',
      '100',
      '101',
      '108',
      '109',
      '120',
      '121',
      '125',
      '126',
      '127',
      '128',
      '129',
      '130',
      '131',
      'other',
      '140',
      '161',
      '162',
      '173',
      '174',
      '184',
      '185',
      '190',
      '195',
      'other',
      '98',
      '98',
    ]
  );
  assert.deepEqual(
    [...result.stdout.matchAll(/hpm_runtime_child_primary_phase=([0-9]+)/g)].map(
      (match) => match[1]
    ),
    ['80']
  );
});

test('runtime boundary hook preserves encrypted receipt order before rollback', () => {
  const sequence = fs.readFileSync('scripts/lib/nsis-encrypted-lifecycle.psm1', 'utf8');
  assert.match(
    sequence,
    /RefuseLegacy\s+& \$Operations\.Seed 'anchored'\s+& \$Operations\.Read 'current' 'anchored' 'read'\s+& \$Operations\.Read 'current' 'anchored' 'resave'\s+& \$Operations\.CheckFixtures\s+& \$Operations\.RuntimeBoundaries\s+& \$Operations\.Install 'baseline'/
  );
  const runner = fs.readFileSync('scripts/lib/nsis-lifecycle-runner.psm1', 'utf8');
  assert.match(runner, /\$operations\.RuntimeBoundaries\s*=/);
  assert.match(runner, /Invoke-HpmInstalledRuntimeBoundary/);
  assert.match(
    runner,
    /foreach \(\$caseId in @\('defaults-migration', 'initialization-failure', 'reopen-clear'\)\)/
  );
  assert.match(runner, /Invoke-HpmInstalledDaemonHttpMatrix/);
  assert.ok(
    runner.indexOf('Invoke-HpmInstalledRuntimeBoundary $root') <
      runner.indexOf('$encryptedState.httpMatrix = Invoke-HpmInstalledDaemonHttpMatrix')
  );
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-runtime-boundary-powershell.test.js'
    )
  );
});
