'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const sentinel = 'synthetic-private-input-must-not-be-logged';

function run(script) {
  const result = spawnSync(
    'C:/Program Files/PowerShell/7/pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      shell: false,
      windowsHide: true,
      timeout: 25000,
      maxBuffer: 8192,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', CI: '' },
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(sentinel), false);
  return result.stdout.trim().split(/\r?\n/);
}

test('failure diagnostics accept only fixed stage literals and never interpolate caught errors', () => {
  const files = [
    ['scripts/qualify-context-hosted.ps1', 'qualificationStage'],
    ['scripts/context-hosted/shared/hosted-network.ps1', 'networkStage'],
    ...['n08', 'n09'].flatMap((name) => [
      [`scripts/context-hosted/${name}/hosted-execution.ps1`, 'state.stage'],
      [`scripts/context-hosted/${name}/owned-job.ps1`, 'jobStage'],
    ]),
  ];
  for (const [file, variable] of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const writes = source.split(/\r?\n/).filter((line) => line.includes('Write-Information'));
    assert.ok(writes.length > 0, file);
    for (const line of writes) {
      assert.match(line, /-InformationAction Continue$/);
      assert.equal(line.includes('$_'), false);
      assert.equal(line.includes('Exception'), false);
      assert.match(
        line,
        /^\s*Write-Information (?:'hpm_network_failed_stage=restore'|\('hpm_[a-z0-9_]+=' \+ \$[a-zA-Z.]+\)) -InformationAction Continue$/
      );
    }
    const name = variable.replace('.', '\\.');
    const assignments = [...source.matchAll(new RegExp('\\$' + name + ' = ([^\\r\\n]+)', 'g'))];
    assert.ok(assignments.length >= 3, file);
    for (const [, value] of assignments) assert.match(value, /^'[a-z_]+'$/);
  }
});

test(
  'real qualification and network preflight failures emit safe stages without running native operations',
  {
    skip: process.platform !== 'win32',
    timeout: 30000,
  },
  () => {
    const qualify = path.join(root, 'scripts/qualify-context-hosted.ps1');
    const network = path.join(root, 'scripts/context-hosted/shared/hosted-network.ps1');
    const observed = run(`
    $ErrorActionPreference = 'Stop'
    try { & ${quote(qualify)} -Case n08 } catch { Write-Output $_.Exception.Message }
    . ${quote(network)}
    try {
      Invoke-HpmN08HostedNetwork -OwnedRoot ${quote(sentinel)} -BuildReceiptSha256 ('a' * 64) -RunOwnedScenario { throw ${quote(sentinel)} } -StopOwnedScenario { throw ${quote(sentinel)} }
    } catch { Write-Output $_.Exception.Message }
  `);
    assert.deepEqual(observed, [
      'hpm_qualification_failed_stage=environment',
      'context_hosted_qualification_failed',
      'hpm_network_failed_stage=environment',
      'n08_network_rejected',
    ]);
  }
);

for (const name of ['n08', 'n09']) {
  test(
    `${name} execution distinguishes review and library identity failures without leaking input`,
    {
      skip: process.platform !== 'win32',
      timeout: 30000,
    },
    () => {
      const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-safe-stages-'));
      try {
        const plan = {
          candidate: sentinel,
          manifestSha256: 'a'.repeat(64),
          controllerPins: {},
          loadedPins: {},
          negativeAddress: sentinel,
          jobSourcePins: {},
          libraryPins: {},
          [name === 'n08' ? 'sourcePins' : 'lifecyclePins']: {},
        };
        const bytes = JSON.stringify(plan);
        fs.writeFileSync(path.join(owned, `${name}-hosted-review-plan.json`), bytes);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const script = path.join(root, `scripts/context-hosted/${name}/hosted-execution.ps1`);
        const observed = run(`
        $ErrorActionPreference = 'Stop'
        . ${quote(script)}
        foreach ($digest in @(('0' * 64), ${quote(hash)})) {
          try { Invoke-Hpm${name.toUpperCase()}HostedExecution -OwnedRoot ${quote(owned)} -ReviewPlanSha256 $digest -BuildReceiptSha256 ('b' * 64) }
          catch { Write-Output $_.Exception.Message }
        }
      `);
        assert.deepEqual(observed, [
          `hpm_${name}_execution_failed_stage=review_plan`,
          `${name}_hosted_execution_rejected`,
          `hpm_${name}_execution_failed_stage=library_pins`,
          `${name}_hosted_execution_rejected`,
        ]);
      } finally {
        fs.rmSync(owned, { recursive: true, force: true });
      }
    }
  );
}
