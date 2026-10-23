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

test(
  'egress substeps distinguish mocked failures without invoking native firewall commands',
  { skip: process.platform !== 'win32', timeout: 30000 },
  () => {
    const source = fs.readFileSync(
      path.join(root, 'scripts/context-hosted/shared/hosted-network.ps1'),
      'utf8'
    );
    const start = source.indexOf("        $networkStage = 'egress_containment'");
    const end = source.indexOf("        $networkStage = 'hosts_mapping'", start);
    assert.ok(start > 0 && end > start);
    const block = source.slice(start, end);
    const observed = run(`
      $ErrorActionPreference = 'Stop'
      $body = [scriptblock]::Create(${quote(block)})
      function Get-NetFirewallProfile {
        if ($mode -eq 'profiles') { throw ${quote(sentinel)} }
        [pscustomobject]@{ Name = 'Public'; Enabled = $false }
      }
      function Set-NetFirewallProfile {
        param($Name, $Enabled)
        if ($mode -eq 'enable') { throw ${quote(sentinel)} }
      }
      function Get-NetFirewallRule {
        param($Name, $ErrorAction)
        if ($ErrorAction -eq 'SilentlyContinue') {
          if ($mode -eq 'collision') { return [pscustomobject]@{ Name = $Name } }
          return
        }
        if ($mode -eq 'read') { throw ${quote(sentinel)} }
        [pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Outbound' }
      }
      function New-NetFirewallRule {
        param($Name, $DisplayName, $Direction, $Action, $Enabled, $Profile, $Program, $RemoteAddress)
        if ($mode -eq 'create') { throw ${quote(sentinel)} }
        if ($RemoteAddress.Count -ne 4 -or $RemoteAddress[0] -cne '0.0.0.0-127.0.0.0' -or
            $RemoteAddress[1] -cne '127.0.0.2-255.255.255.255' -or $RemoteAddress[2] -cne '::/1' -or $RemoteAddress[3] -cne '8000::/1' -or
            $Direction -cne 'Outbound' -or $Action -cne 'Block' -or $Program -cne $node) { throw 'fixture_contract_failed' }
      }
      function Get-NetFirewallApplicationFilter {
        if ($mode -eq 'application') { throw ${quote(sentinel)} }
        [pscustomobject]@{ Program = $(if ($mode -eq 'identity') { 'wrong' } else { $node }) }
      }
      foreach ($mode in @('profiles', 'enable', 'collision', 'create', 'read', 'application', 'identity', 'success')) {
        $nonce = 'synthetic'
        $node = ${quote(sentinel)}
        $firewallCreated = $false
        try {
          . $body
          if (-not $firewallCreated) { throw 'fixture_contract_failed' }
          Write-Output 'success'
        } catch { Write-Output $networkStage }
      }
    `);
    assert.deepEqual(observed, [
      'egress_profiles',
      'egress_enable',
      'egress_collision',
      'egress_rule_create',
      'egress_rule_read',
      'egress_application',
      'egress_identity',
      'success',
    ]);
  }
);

for (const name of ['n08', 'n09']) {
  test(`${name} closed callback can invoke the locally loaded owned Job function`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-closure-scope-'));
    const label = name.toUpperCase();
    try {
      const library = path.join(temporary, name);
      const shared = path.join(temporary, 'shared');
      const owned = path.join(temporary, 'owned');
      for (const directory of [library, shared, owned]) fs.mkdirSync(directory);
      const execution = path.join(library, 'hosted-execution.ps1');
      fs.copyFileSync(
        path.join(root, `scripts/context-hosted/${name}/hosted-execution.ps1`),
        execution
      );
      const network = path.join(shared, 'hosted-network.ps1');
      const materials = path.join(shared, 'hosted-materials.ps1');
      const job = path.join(library, 'owned-job.ps1');
      fs.writeFileSync(materials, '# synthetic library with no native operations\n');
      fs.writeFileSync(
        job,
        `
        function Invoke-Hpm${label}OwnedScenario {
          param($OwnedRoot, $Candidate, $PlanSha256, $SourcePins)
          if ($Candidate -cne 'synthetic-candidate' -or $PlanSha256 -cnotmatch '\\A[a-f0-9]{64}\\z') { throw 'fixture_contract_failed' }
          return [pscustomobject]@{ ownedTreeEmpty = $true }
        }
      `
      );
      fs.writeFileSync(
        network,
        `
        function Invoke-HpmN08HostedNetwork {
          param($OwnedRoot, $BuildReceiptSha256, $RunOwnedScenario, $StopOwnedScenario)
          $result = & $RunOwnedScenario ([pscustomobject]@{
            node = (Join-Path $OwnedRoot 'payload/runtime/node/node.exe')
            networkRoot = (Join-Path $OwnedRoot 'n08-hosted-network')
            manifestSha256 = ('a' * 64); caSha256 = ('b' * 64); leafSha256 = ('c' * 64)
          })
          if ($result.ownedTreeEmpty -ne $true -or (& $StopOwnedScenario) -cne $true) { throw 'fixture_contract_failed' }
          Write-Output 'local_job_invoked_and_closed'
        }
      `
      );
      const libraryPins = Object.fromEntries(
        [network, materials, job].map((file) => [
          file,
          createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        ])
      );
      const plan = {
        candidate: 'synthetic-candidate',
        manifestSha256: 'a'.repeat(64),
        controllerPins: {},
        loadedPins: {},
        negativeAddress: sentinel,
        jobSourcePins: {},
        libraryPins,
        [name === 'n08' ? 'sourcePins' : 'lifecyclePins']: {},
      };
      const bytes = JSON.stringify(plan);
      fs.writeFileSync(path.join(owned, `${name}-hosted-review-plan.json`), bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      assert.deepEqual(
        run(`
        $ErrorActionPreference = 'Stop'
        . ${quote(execution)}
        Invoke-Hpm${label}HostedExecution -OwnedRoot ${quote(owned)} -ReviewPlanSha256 ${quote(digest)} -BuildReceiptSha256 ('b' * 64)
      `),
        ['local_job_invoked_and_closed']
      );
    } finally {
      assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('hosted-closure-scope-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

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
