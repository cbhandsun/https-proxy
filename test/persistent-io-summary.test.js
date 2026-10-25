'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createPersistentIoSummary } = require('../scripts/lib/persistent-io-summary');
const filename = 'C:\\Temp\\hpm-wbipc-core-aB012z\\context\\checkpoint.sqlite';
const event = (type, key, timeMs, name = '') => ({ type, key, timeMs, name });
const invalid = { message: 'persistent_io_trace_invalid' };

test('ETW pairs bind file keys to owned synthetic names and distinguish database and journal flushes', () => {
  const summary = createPersistentIoSummary();
  summary.observe(event('name', '0x10', 0, filename));
  summary.observe(event('name', '17', 0, filename + '-journal'));
  summary.observe(event('flush', '32', 100, '16'));
  summary.observe(event('flush', '33', 200, '0x11'));
  summary.observe(event('end', '0x20', 1600, '0'));
  summary.observe(event('end', '0x21', 260, '0'));
  const result = summary.snapshot();
  assert.equal(result.pairedFlushes, 2);
  assert.deepEqual(result.database, { count: 1, maxMs: 1500, over100Ms: 1, over1000Ms: 1 });
  assert.deepEqual(result.journal, { count: 1, maxMs: 60, over100Ms: 0, over1000Ms: 0 });
  assert.equal(result.traceCompletenessVerified, false);
  assert.equal(result.fiveSecondQualified, false);
  assert.doesNotMatch(JSON.stringify(result), /Temp|aB012z|0x20|checkpoint/);
  result.database.count = 999;
  assert.equal(summary.snapshot().database.count, 1);
});

test('unrelated names, pointer reuse, lost pairs and failed flushes do not create success evidence', () => {
  const summary = createPersistentIoSummary();
  assert.equal(summary.snapshot().pairedFlushes, 0);
  summary.observe(event('name', '1', 0, filename));
  summary.observe(event('name', '1', 1, 'PRIVATE_OTHER_PATH'));
  summary.observe(event('flush', '2', 2, '1'));
  summary.observe(event('end', '2', 3, '0'));
  summary.observe(event('name', '1', 4, filename));
  summary.observe(event('flush', '2', 5, '1'));
  summary.observe(event('flush', '2', 6, '1'));
  summary.observe(event('end', '2', 7, '-1073741790'));
  summary.observe(event('flush', '3', 8, '1'));
  const result = summary.snapshot();
  assert.equal(result.pairedFlushes, 0);
  assert.equal(result.failedFlushes, 1);
  assert.equal(result.collisions, 1);
  assert.equal(result.unfinishedFlushes, 1);
  assert.equal(result.unmatchedEnds, 1);
});

test('unsafe event shapes, pointers, times and status fields fail without executing hooks', () => {
  let touched = 0;
  const accessor = Object.defineProperty({}, 'type', {
    enumerable: true,
    get() {
      touched++;
      return 'name';
    },
  });
  for (const input of [
    null,
    [],
    accessor,
    new Proxy(
      {},
      {
        ownKeys() {
          touched++;
          return [];
        },
      }
    ),
    event('bad', '1', 0),
    event('name', '0', 0),
    event('name', '18446744073709551616', 0),
    event('name', '0x1g', 0),
    event('name', '1', -1),
    event('name', '1', 0.5),
    event('name', '1', Infinity),
    event('name', '1', Number.MAX_SAFE_INTEGER + 1),
    event('name', '1', 0, 'x'.repeat(4097)),
    event('end', '1', 0, 'PRIVATE'),
    event('end', '1', 0, '4294967296'),
    event('end', '1', 0, '-2147483649'),
    { ...event('name', '1', 0), extra: true },
  ]) {
    assert.throws(() => createPersistentIoSummary().observe(input), invalid);
  }
  assert.equal(touched, 0);
  const summary = createPersistentIoSummary();
  summary.observe(event('name', '1', 0, filename));
  summary.observe(event('flush', '2', 10, '1'));
  assert.throws(() => summary.observe(event('end', '2', 9, '0')), invalid);
});

test('CLI emits only a finite summary and rejects malformed, duplicate, empty and oversized input', () => {
  const file = path.resolve(__dirname, '../scripts/summarize-persistent-io.cjs');
  const rows = [
    event('name', '1', 0, filename),
    event('flush', '2', 10, '1'),
    event('end', '2', 20, '0'),
  ];
  const input = rows.map(JSON.stringify).join('\n') + '\n';
  const good = spawnSync(process.execPath, [file], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).pairedFlushes, 1);
  for (const input of [
    '',
    'PRIVATE',
    '{"type":"name","type":"end"}',
    '\ufffd',
    'x'.repeat(16 * 1024 * 1024 + 1),
    Buffer.from([255]),
    '{"type":"end","type":"name","key":"1","timeMs":0,"name":' +
      JSON.stringify(filename) +
      '}\n' +
      rows.slice(1).map(JSON.stringify).join('\n'),
  ]) {
    const result = spawnSync(process.execPath, [file], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'persistent_io_summary_failed\n');
  }
});

test('bounded event and file inventories refuse excess instead of retaining an unbounded trace', () => {
  const files = createPersistentIoSummary();
  for (let index = 1; index <= 256; index++)
    files.observe(event('name', String(index), 0, filename));
  assert.throws(() => files.observe(event('name', '257', 0, filename)), invalid);
  const events = createPersistentIoSummary();
  for (let index = 0; index < 100000; index++) events.observe(event('end', '1', 0, '0x00000000'));
  assert.throws(() => events.observe(event('end', '1', 0, '0')), invalid);
  const pending = createPersistentIoSummary();
  pending.observe(event('name', '1', 0, filename));
  for (let index = 0; index < 8192; index++)
    pending.observe(event('flush', String(index + 2), 0, '1'));
  assert.equal(pending.snapshot().unfinishedFlushes, 8192);
  assert.throws(() => pending.observe(event('flush', '8194', 0, '1')), invalid);
});

test('recording entry refuses a nonhosted environment before inspecting or changing any trace', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(__dirname, '../scripts/diagnose-persistent-io.ps1'),
    ],
    {
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'persistent_io_diagnostic_failed:phase=host');
});

test('PowerShell decodes owned FileIo metadata, filters unrelated records and refuses XML entities', () => {
  const filename = path
    .join(__dirname, '../scripts/lib/persistent-io-recording.psm1')
    .replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop'
    $module=Import-Module '${filename}' -PassThru -Force
    & $module {
      $state=@{names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);irps=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);shapes=@{}}
      function EventXml($items){'<Event><EventData>'+($items.GetEnumerator()|ForEach-Object{'<Data Name="'+$_.Key+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'})+'</EventData></Event>'}
      $name=EventXml @{FileObject='0x10';FileName='C:\\Temp\\hpm-wbipc-core-aB012z\\context\\checkpoint.sqlite'}
      $a=ConvertTo-HpmPersistentIoRecord $name 32 0 $state | ConvertFrom-Json
      if($a.type -cne 'name'){throw 'owned_name_missing'}
      $b=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';FileKey='0x10'}) 73 10 $state | ConvertFrom-Json
      $c=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';NtStatus='0x00000000'}) 76 30 $state | ConvertFrom-Json
      if($b.type -cne 'flush' -or $c.type -cne 'end'){throw 'pair_missing'}
      $other=ConvertTo-HpmPersistentIoRecord (EventXml @{FileObject='0x30';FileName='PRIVATE_PATH'}) 32 40 $state
      if($null -ne $other){throw 'unrelated_path_emitted'}
      $clear=ConvertTo-HpmPersistentIoRecord (EventXml @{FileObject='0x10';FileName='PRIVATE_PATH'}) 32 50 $state | ConvertFrom-Json
      if($clear.name -cne '' -or $state.names.Count -ne 0){throw 'reused_key_retained'}
      foreach($bad in @('<!DOCTYPE x [<!ENTITY t "PRIVATE">]><Event>&t;</Event>', '<bad', ('x'*65537), '<Event><EventData><Data Name="FileObject">1</Data><Data Name="FileObject">2</Data></EventData></Event>')){
        $refused=$false;try{$null=ConvertTo-HpmPersistentIoRecord $bad 32 0 $state}catch{$refused=$true}
        if(-not $refused){throw 'invalid_xml_accepted'}
      }
      if($state.shapes['3'] -ne 3 -or $state.shapes['12'] -ne 1 -or $state.shapes['24'] -ne 1){throw 'shape_counts_invalid'}
      $encoded=$state.shapes|ConvertTo-Json -Compress
      if($encoded -match 'PRIVATE_PATH|0x10'){throw 'unsafe_shape_output'}
      'metadata_decode_passed'
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'bounded metadata decoder fixture failed');
  assert.equal(result.stdout.trim(), 'metadata_decode_passed');
  assert.equal(result.stderr, '');
});

test('recording profile fixes memory buffers and only file metadata providers without stack capture', () => {
  const profile = path
    .join(__dirname, '../scripts/fixtures/persistent-file-io.wprp')
    .replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop'
    [xml]$profile=Get-Content -LiteralPath '${profile}' -Raw
    $profiles=$profile.WindowsPerformanceRecorder.Profiles
    if([int]$profiles.SystemCollector.BufferSize.Value -ne 64 -or [int]$profiles.SystemCollector.Buffers.Value -ne 512){throw 'memory_profile_changed'}
    if($profiles.Profile.LoggingMode -cne 'Memory' -or $profiles.Profile.Name -cne 'HpmSqliteIO'){throw 'recording_mode_changed'}
    if((@($profiles.SystemProvider.Keywords.Keyword|ForEach-Object{$_.Value}) -join ',') -cne 'Filename,FileIO,FileIOInit'){throw 'provider_scope_changed'}
    if($null -ne $profile.SelectSingleNode('//Stacks') -or $null -ne $profile.SelectSingleNode('//EventProvider')){throw 'capture_scope_widened'}
    'bounded_profile_passed'
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'bounded_profile_passed');
  assert.equal(result.stderr, '');
});
