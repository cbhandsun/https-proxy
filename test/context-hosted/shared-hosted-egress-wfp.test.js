'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test(
  'dynamic WFP policy layout, exact conditions and rollback use only a synthetic backend',
  { timeout: 30000 },
  () => {
    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        'test/fixtures/hosted-egress-wfp-mocks.ps1',
      ],
      {
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
    assert.match(result.stdout, /wfpSyntheticRejected=24; nativeWfpCalls=0; networkRequests=0/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PROGRAM_SENTINEL/);
    assert.match(result.stdout, /guardedPaths=10/);
  }
);
