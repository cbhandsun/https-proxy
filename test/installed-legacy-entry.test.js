'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
test('582 installed driver refuses an unreleased Job gate before opening any supplied runtime', (t) => {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-582-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const input of ['', '0', 'x']) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '../scripts/lib/installed-legacy-582-driver.cjs'),
        root,
        root,
        'a'.repeat(64),
      ],
      { input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'installed_legacy_582_failed\n');
    assert.deepEqual(fs.readdirSync(root), []);
  }
});
test('582 restore entry refuses a non-hosted invocation before npm, download or runtime execution', () => {
  const modulePath = path
    .join(__dirname, '../scripts/lib/legacy-runtime-restore.psm1')
    .replaceAll("'", "''");
  const code = `$ErrorActionPreference='Stop';Import-Module '${modulePath}' -Force;try{Restore-HpmLegacyRuntime;exit 2}catch{if($_.Exception.Message -cne 'legacy_runtime_restore_refused'){exit 3};'host_refused'}`;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 25000,
    maxBuffer: 1024,
    env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', RUNNER_OS: '', CI: '' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), 'host_refused');
});
