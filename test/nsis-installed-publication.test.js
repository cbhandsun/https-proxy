'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  parseInstalledPublicationTap,
  PUBLICATION_TITLES,
} = require('../scripts/lib/nsis-installed-publication-tap');
const {
  selectPublicationRuntime,
  publicationModule,
} = require('./helpers/publication-runtime.cjs');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tap = () =>
  [
    'TAP version 13',
    ...PUBLICATION_TITLES.map((title, index) => 'ok ' + (index + 1) + ' - ' + title),
    '1..30',
    '# tests 30',
    '# suites 0',
    '# pass 30',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '',
  ].join('\n');

test('installed interior verdict requires all thirty exact original cases and zero failure or skip for LF and CRLF', () => {
  for (const text of [tap(), tap().replaceAll('\n', '\r\n')])
    assert.deepEqual(parseInstalledPublicationTap(text), {
      tests: 30,
      passedTests: 30,
      failedTests: 0,
      skippedTests: 0,
    });
  for (const bad of [
    null,
    [],
    {},
    '',
    'x'.repeat(1048577),
    tap().replace('ok 1 -', 'not ok 1 -'),
    tap().replace('ok 1 -', 'ok 2 -'),
    tap().replace(PUBLICATION_TITLES[0], PUBLICATION_TITLES[1]),
    tap().replace(PUBLICATION_TITLES[0], 'PRIVATE_UNEXPECTED_CASE'),
    tap().replace('# pass 30', '# pass 29'),
    tap().replace('# fail 0', '# fail 1'),
    tap().replace('# skipped 0', '# skipped 1'),
    tap().replace('# cancelled 0', '# cancelled 1'),
    tap().replace('# todo 0', '# todo 1'),
    tap().replace('1..30', '1..29'),
    tap() + '# pass 30\n',
    tap() + '# tests 31\n',
    tap() + '# pass 29\n',
    tap() + '1..31\n',
    tap() + 'ok 0 - bad\n',
    tap().replace('ok 30 -', 'ok 30 - # SKIP '),
  ])
    assert.throws(
      () => parseInstalledPublicationTap(bad),
      /^Error: installed_publication_suite_failed$/
    );
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-publication-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'hpm-installed-clients', 'payload');
  const source = 'lib/proxy/server-shutdown.js';
  const entries = {
    [source]: 'module.exports={synthetic:true};',
    'runtime/node/node.exe': 'synthetic-node',
    'runtime/native/hpm-context-recovery-key.exe': 'synthetic-native',
    'package-lock.json': '{}',
  };
  for (const [relative, bytes] of Object.entries(entries)) {
    const file = path.join(install, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const manifest = {
    schemaVersion: 2,
    sourceSha256: { [source]: hash(entries[source]) },
    nodeSha256: hash(entries['runtime/node/node.exe']),
    contextRecoveryNativeSha256: hash(entries['runtime/native/hpm-context-recovery-key.exe']),
    packageLockSha256: hash('{}'),
  };
  const bytes = JSON.stringify(manifest);
  fs.writeFileSync(path.join(install, 'release-runtime-manifest.json'), bytes);
  const pin = hash(bytes);
  const runtime = {
    platform: 'win32',
    execPath: path.join(install, 'runtime/node/node.exe'),
    env: {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
      RUNNER_TEMP: root,
      HPM_INSTALLED_PUBLICATION_RUNTIME: install,
      HPM_INSTALLED_PUBLICATION_MANIFEST: pin,
    },
  };
  return { root, install, pin, runtime };
}

test('installed fixture selector attests every source, Node and native pin and never falls back on an invalid selection', (t) => {
  const f = fixture(t);
  assert.equal(selectPublicationRuntime(f.runtime).pin, f.pin);
  assert.equal(selectPublicationRuntime({ env: {} }), null);
  for (const change of [
    (r) => {
      r.platform = 'linux';
    },
    (r) => {
      r.env.CI = 'false';
    },
    (r) => {
      r.env.RUNNER_ENVIRONMENT = 'self-hosted';
    },
    (r) => {
      r.env.HPM_INSTALLED_PUBLICATION_RUNTIME = f.root;
    },
    (r) => {
      delete r.env.HPM_INSTALLED_PUBLICATION_MANIFEST;
    },
    (r) => {
      r.env.HPM_INSTALLED_PUBLICATION_MANIFEST = '';
    },
    (r) => {
      r.env.HPM_INSTALLED_PUBLICATION_MANIFEST = 'f'.repeat(64);
    },
    (r) => {
      r.execPath = process.execPath;
    },
  ]) {
    const runtime = { ...f.runtime, env: { ...f.runtime.env } };
    change(runtime);
    assert.throws(
      () => selectPublicationRuntime(runtime),
      /^Error: installed_publication_runtime_rejected$/
    );
  }
  for (const relative of [
    'lib/proxy/server-shutdown.js',
    'runtime/native/hpm-context-recovery-key.exe',
    'runtime/node/node.exe',
    'package-lock.json',
  ]) {
    const file = path.join(f.install, relative),
      before = fs.readFileSync(file);
    fs.writeFileSync(file, 'changed');
    assert.throws(
      () => selectPublicationRuntime(f.runtime),
      /^Error: installed_publication_runtime_rejected$/
    );
    fs.writeFileSync(file, before);
  }
  assert.equal(typeof publicationModule('server-shutdown').createProxyShutdown, 'function');
  for (const value of ['', null, '../../PRIVATE', 'context-recovery-key', 'server-shutdown.js'])
    assert.throws(
      () => publicationModule(value),
      /^Error: installed_publication_runtime_rejected$/
    );
});

function receipt() {
  return {
    schemaVersion: 1,
    scope: 'installed_payload_publication_interior',
    passed: true,
    manifestSha256: 'a'.repeat(64),
    tests: 30,
    passedTests: 30,
    failedTests: 0,
    skippedTests: 0,
    defaultWorkerQualified: true,
    daemonQualified: false,
    retention24hQualified: false,
    realModelRequests: 0,
  };
}
test('PowerShell receipt refuses duplicate fields, excess claims and missing original cases', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-publication-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const examples = [JSON.stringify(receipt())];
  for (const change of [
    (r) => {
      r.tests = 29;
    },
    (r) => {
      r.passedTests = 29;
    },
    (r) => {
      r.skippedTests = 1;
    },
    (r) => {
      r.failedTests = 1;
    },
    (r) => {
      r.daemonQualified = true;
    },
    (r) => {
      r.retention24hQualified = true;
    },
    (r) => {
      r.defaultWorkerQualified = false;
    },
    (r) => {
      r.realModelRequests = 1;
    },
    (r) => {
      r.extra = 'PRIVATE';
    },
    (r) => {
      delete r.scope;
    },
  ]) {
    const r = receipt();
    change(r);
    examples.push(JSON.stringify(r));
  }
  examples.push(JSON.stringify(receipt()).replace('"passed":true', '"passed":false,"passed":true'));
  const file = path.join(root, 'cases.json');
  fs.writeFileSync(file, JSON.stringify(examples));
  const module = path.resolve('scripts/lib/nsis-installed-publication.psm1').replaceAll("'", "''");
  const code = `$ErrorActionPreference='Stop';Import-Module '${module}' -Force
    $cases=Get-Content -Raw -LiteralPath '${file.replaceAll("'", "''")}'|ConvertFrom-Json
    for($i=0;$i -lt $cases.Count;$i++){$accepted=$false;try{$null=ConvertFrom-HpmInstalledPublicationReceipt $cases[$i] ('a'*64);$accepted=$true}catch{if($_.Exception.Message -cne 'installed_publication_receipt_rejected'){throw 'unsafe_error'}};if($accepted -ne ($i -eq 0)){throw 'receipt_gate_failed'}}
    [Console]::Out.WriteLine('publication_receipts_passed')`;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 8192,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'publication_receipts_passed');
});

test('installed interior workflow retains original suites and gates with separate qualification scope', () => {
  const workflow = fs.readFileSync(
    path.resolve('.github/workflows/windows-encrypted-draft-lifecycle.yml'),
    'utf8'
  );
  assert.ok(
    workflow.indexOf('Qualify installed publication COMMIT') >
      workflow.indexOf('Qualify installed Codex and Claude')
  );
  const driver = fs.readFileSync(
    path.resolve('scripts/lib/nsis-installed-publication.cjs'),
    'utf8'
  );
  for (const file of [
    'publication-runtime-required.cjs',
    'context-recovery-native-publication-interruption.test.js',
    'context-recovery-native-graceful-http.test.js',
  ])
    assert.ok(driver.includes(file));
  assert.ok(driver.includes("'--test-concurrency=1'"));
  assert.doesNotMatch(driver, /--test-name-pattern|--test-skip-pattern|NODE_OPTIONS|\.kill\(/);
});

test('installed scenario requires natural owned exit and never lets receipt or cleanup failure qualify', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-publication-scenario-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = path.resolve('scripts/lib/nsis-installed-publication.psm1').replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop';$env:GITHUB_WORKSPACE='${path.resolve('.').replaceAll("'", "''")}'
    $module=Import-Module '${module}' -Force -PassThru
    $mock=New-Module -ScriptBlock {
      function Set-HpmInstalledHttpDriverEnvironment {param($StartInfo,$CaseRoot)}
      function Invoke-HpmInstalledHttpDriverProcess {
        param($StartInfo,[switch]$RequireNaturalExit)
        if(-not $RequireNaturalExit -or $StartInfo.ArgumentList.Count -ne 1 -or -not $StartInfo.ArgumentList[0].EndsWith('nsis-installed-publication.cjs') -or $StartInfo.Environment['HPM_INSTALLED_PUBLICATION_MANIFEST'] -cne ('a'*64) -or $StartInfo.Environment['HPM_INSTALLED_PUBLICATION_RUNTIME'] -cne $script:payload){throw 'invocation_gate_failed'}
        if($script:mode -ceq 'cleanup_failed'){throw 'installed_daemon_http_process_failed:cause=deadline;cleanup=failed'}
        if($script:mode -ceq 'cleanup_confirmed'){throw 'installed_daemon_http_process_failed:cause=deadline;cleanup=confirmed'}
        if($script:mode -ceq 'receipt'){return '{}'}
        return $script:reply
      }
      Export-ModuleMember -Function Set-HpmInstalledHttpDriverEnvironment,Invoke-HpmInstalledHttpDriverProcess
    }
    & $module {param($m) $script:publicationProcessModule=$m} $mock
    foreach($mode in @('success','receipt','cleanup_failed','cleanup_confirmed')){
      $owned=Join-Path '${root.replaceAll("'", "''")}' $mode;New-Item -ItemType Directory -Path $owned|Out-Null
      $payload=Join-Path $owned 'payload';New-Item -ItemType Directory -Path $payload|Out-Null
      $material=[pscustomobject]@{ownedRoot=$owned;payload=$payload;node='synthetic-node';manifestSha256=('a'*64)}
      $state=@{treeEmpty=$true;receipt=$null}
      & $mock {param($m,$r,$p) $script:mode=$m;$script:reply=$r;$script:payload=$p} $mode '${JSON.stringify(receipt())}' $payload
      $accepted=$false
      try{$result=& $module {param($m,$s) Invoke-HpmInstalledPublicationScenario $m $s} $material $state;$accepted=$result.passed -ceq $true}catch{if($_.Exception.Message -cne 'installed_publication_rejected'){throw 'unsafe_error'}}
      if($accepted -ne ($mode -ceq 'success') -or $state.treeEmpty -ne ($mode -cne 'cleanup_failed')){throw 'qualification_gate_failed'}
    }
    [Console]::Out.WriteLine('publication_scenarios_passed')
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 8192,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'publication_scenarios_passed');
});
