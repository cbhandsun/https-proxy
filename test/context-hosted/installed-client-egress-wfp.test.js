'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test(
  'installed-client WFP factory guards only three fixed programs and keeps all API calls synthetic',
  { timeout: 30000 },
  () => {
    const script = `
    $ErrorActionPreference = 'Stop'
    $source = [IO.File]::ReadAllText((Join-Path (Get-Location) 'scripts/context-hosted/shared/hosted-egress-wfp.cs'))
    $fixture = [IO.File]::ReadAllText((Join-Path (Get-Location) 'test/fixtures/hosted-egress-wfp-mocks.cs'))
    Add-Type -TypeDefinition ($source + "\n" + ($fixture -replace '(?m)^using [^;]+;\\r?\\n', '')) -ErrorAction Stop
    [HpmHostedEgressFixture]::RunInstalledClients()
  `;
    const result = spawnSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 8192,
        windowsHide: true,
        env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', RUNNER_OS: '' },
      }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const windows = process.platform === 'win32';
    assert.match(
      result.stdout,
      new RegExp(
        'installedPrograms=' +
          (windows ? 3 : 0) +
          '; installedClientRejected=' +
          (windows ? 24 : 27) +
          '; syntheticLeases=3' +
          '; nativeWfpCalls=0; networkRequests=0; windowsGuardQualified=' +
          (windows ? 'True' : 'False')
      )
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /PRIVATE_PROGRAM_SENTINEL|synthetic inert file/
    );
  }
);
