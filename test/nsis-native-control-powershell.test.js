'use strict';
const { structuredClone } = globalThis;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PHASES } = require('../scripts/lib/nsis-native-control-probe');

test('PowerShell failure diagnostics accept every closed JS phase and reject unknown private content', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    ...PHASES.map((phase) => ({ schemaVersion: 1, phase })),
    { schemaVersion: 1, phase: 'PRIVATE' },
    { schemaVersion: 1, phase: 'x'.repeat(257) },
    { schemaVersion: 1, phase: 'start-1-child_exited', extra: 'PRIVATE' },
    { schemaVersion: 2, phase: 'start-1' },
  ];
  const file = path.join(root, 'examples.json');
  fs.writeFileSync(file, JSON.stringify(cases));
  const script = path.join(root, 'check.ps1');
  fs.writeFileSync(
    script,
    `param($Repository,$Root,$Examples,$Count)
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $Repository 'scripts/lib/nsis-native-control.psm1') -Force -PassThru
$cases=[IO.File]::ReadAllText($Examples)|ConvertFrom-Json
$index=0
foreach($case in $cases){
 [IO.File]::WriteAllText((Join-Path $Root 'native-control-phase.json'),($case|ConvertTo-Json -Compress))
 $capture=[IO.StringWriter]::new();$previous=[Console]::Error
 try{[Console]::SetError($capture);& $module {param($r) Write-HpmNativeControlFailurePhase $r} $Root}finally{[Console]::SetError($previous)}
 $expected=if($index -lt [int]$Count){$case.phase}else{'phase_invalid'}
 if($capture.ToString().TrimEnd() -cne ('NSIS_NATIVE_CONTROL_PHASE='+$expected)){throw 'phase_contract_failed'}
 $index++
}
[Console]::Out.WriteLine('nativePhaseCases='+$index+'; modelRequests=0')
`
  );
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      script,
      path.resolve('.'),
      root,
      file,
      String(PHASES.length),
    ],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 4096 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, new RegExp('nativePhaseCases=' + cases.length + '; modelRequests=0'));
});
test('PowerShell native receipt keeps exact scope and rejects forged qualifications, duplicates and metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = {
    schemaVersion: 1,
    scope: 'installed_native_idle_stop_storage_reopen',
    passed: true,
    normalStops: 2,
    originalExpiryPreserved: true,
    storageReopenVerified: true,
    idleGracefulStopVerified: true,
    restartRetention: false,
    clientQualified: false,
    retention24hQualified: false,
    modelRequests: 0,
    sourceCommit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64),
    applicationSha256: 'c'.repeat(64),
  };
  const examples = [JSON.stringify(good)];
  for (const alter of [
    (v) => {
      v.scope = 'full_acceptance';
    },
    (v) => {
      v.normalStops = 1;
    },
    (v) => {
      v.modelRequests = 1;
    },
    (v) => {
      v.restartRetention = true;
    },
    (v) => {
      v.clientQualified = true;
    },
    (v) => {
      v.retention24hQualified = true;
    },
    (v) => {
      v.passed = false;
    },
    (v) => {
      v.storageReopenVerified = false;
    },
    (v) => {
      v.idleGracefulStopVerified = false;
    },
    (v) => {
      v.originalExpiryPreserved = false;
    },
    (v) => {
      v.sourceCommit = 'd'.repeat(40);
    },
    (v) => {
      v.manifestSha256 = 'e'.repeat(64);
    },
    (v) => {
      v.applicationSha256 = 'f'.repeat(64);
    },
    (v) => {
      v.private = 'must not print';
    },
  ]) {
    const v = structuredClone(good);
    alter(v);
    examples.push(JSON.stringify(v));
  }
  examples.push(
    '',
    'null',
    '[]',
    '{}',
    JSON.stringify(good).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    'x'.repeat(4097)
  );
  const file = path.join(root, 'examples.json');
  fs.writeFileSync(file, JSON.stringify(examples));
  const script = path.join(root, 'check.ps1');
  fs.writeFileSync(
    script,
    `
param($Repository,$Examples)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $Repository 'scripts/lib/nsis-native-control.psm1') -Force
$cases=[IO.File]::ReadAllText($Examples)|ConvertFrom-Json
$index=0;$refused=0
foreach($text in $cases){
 $failure=$null
 try{$receipt=ConvertFrom-HpmNativeControlReceipt $text ('b'*64) ('a'*40) ('c'*64)}catch{$failure=$_.Exception.Message}
 if($index++ -eq 0){if($failure -or $receipt.restartRetention -or -not $receipt.idleGracefulStopVerified){throw 'positive_failed'}}
 elseif($failure -cne 'native_control_receipt_rejected'){throw 'negative_failed'}else{$refused++}
}
Write-Output ('nativeReceiptRefusals='+$refused+'; nativeExecutions=0; modelRequests=0')
`
  );
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, path.resolve('.'), file],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 4096 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /nativeReceiptRefusals=20; nativeExecutions=0; modelRequests=0/);
});
