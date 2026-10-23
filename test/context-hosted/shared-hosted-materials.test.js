'use strict';

// Filesystem-only regression source; no invocation of the network script.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { materialFixturePhase } = require('../helpers/material-fixture-progress');
test('network cleanup is guarded by confirmed exclusive creation', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../scripts/context-hosted/shared/hosted-network.ps1'),
    'utf8'
  );
  assert.match(source, /\$networkRootCreated = \$false/);
  assert.ok(
    source.indexOf('if (Test-Path -LiteralPath $networkRoot)') <
      source.indexOf('$networkRootCreated = $true')
  );
  assert.ok(
    source.indexOf('$networkRootLease.Verify($networkRoot)') <
      source.indexOf('$networkRootCreated = $true')
  );
  assert.match(
    source,
    /Remove-HpmN08CreatedMaterials \$networkRoot \$networkRootCreated \$networkRootLease \$materialLeases/
  );
});
test('network containment is retained without a successful owner stop acknowledgement', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../scripts/context-hosted/shared/hosted-network.ps1'),
    'utf8'
  );
  assert.match(source, /\$ownedScenarioStopped = \$false/);
  assert.match(
    source,
    /if \(\(& \$StopOwnedScenario\) -ceq \$true\) \{ \$ownedScenarioStopped = \$true \}/
  );
  assert.match(
    source,
    /if \(\$ownedScenarioStopped\) \{\s+if \(\$null -ne \$wfpLease\) \{ try \{ \$wfpLease\.Dispose\(\) \} catch \{ \$restoreFailed = \$true \} \}\s+if \(\$firewallCreated\)/
  );
  assert.match(source, /else \{ \$restoreFailed = \$true \}\s+foreach \(\$certificate/);
});
test(
  'collision and wrong identity preserve sentinels while owned material cleanup works',
  { skip: process.platform !== 'win32', timeout: 30000 },
  (t) => {
    const started = performance.now();
    const result = spawnSync(
      'C:/Program Files/PowerShell/7/pwsh.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(__dirname, '../../scripts/context-hosted/shared/hosted-materials.fixture.ps1'),
        '-Helper',
        path.join(__dirname, '../../scripts/context-hosted/shared/hosted-materials.ps1'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 8192 }
    );
    if (result.error || result.signal !== null || result.status !== 0)
      t.diagnostic(
        JSON.stringify({
          phase: 'material_fixture_failed',
          lastStage: materialFixturePhase(result.stderr),
          elapsedMs: Math.round(performance.now() - started),
        })
      );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(materialFixturePhase(result.stderr), 'cleanup_finished');
    assert.deepEqual(JSON.parse(result.stdout), {
      collisionPreserved: true,
      identityMismatchPreserved: true,
      ownedMaterialsRemoved: true,
    });
  }
);
