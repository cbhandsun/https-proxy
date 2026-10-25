'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPersistentIoSummary } = require('../scripts/lib/persistent-io-summary');
const { parseSummary } = require('../scripts/lib/coverage-io-capture');
const { OPERATION_TYPES } = require('../scripts/lib/persistent-io-operation-summary');
const filename = 'C:\\Temp\\hpm-wbipc-core-aB012z\\context\\checkpoint.sqlite';
const event = (type, key, timeMs, name = '') => ({ type, key, timeMs, name });
function fixture() {
  const summary = createPersistentIoSummary();
  summary.observe(event('name', '1', 0, filename));
  summary.observe(event('name', '2', 0, filename + '-journal'));
  summary.observe(event('flush', '100', 1, '1'));
  summary.observe(event('end', '100', 2, '0'));
  return summary;
}

test('non-flush observations retain duration and non-success classes without manufacturing flush evidence', () => {
  const summary = fixture();
  summary.observe(event('write', '10', 10, '2'));
  summary.observe(event('end', '10', 1210, '0'));
  for (const [key, status] of [
    ['11', '0xc0000022'],
    ['12', String(0xc0000043 - 0x100000000)],
  ]) {
    summary.observe(event('delete', key, 1300, '2'));
    summary.observe(event('end', key, 1400, status));
  }
  summary.observe(event('set-info', '13', 1500, '1'));
  summary.observe(event('end', '13', 1550, '0xc0000054'));
  summary.observe(event('read', '14', 1600, '1'));
  summary.observe(event('end', '14', 1700, '0'));
  summary.observe(event('cleanup', '15', 1800, '1'));
  summary.observe(event('end', '15', 1800, '0'));
  summary.observe(event('close', '16', 1900, '2'));
  summary.observe(event('read', '17', 1900, '1'));
  summary.observe(event('end', '17', 1910, '0x00000103'));
  const value = summary.snapshot();
  assert.equal(value.schemaVersion, 4);
  assert.equal(value.pairedFlushes, 1);
  assert.equal(value.ioOperations.write.journal.maxMs, 1200);
  assert.equal(value.ioOperations.write.journal.over1000Ms, 1);
  assert.equal(value.ioOperations.delete.journal.nonZeroStatus, 2);
  assert.equal(value.ioOperations.delete.journal.accessDenied, 1);
  assert.equal(value.ioOperations.delete.journal.sharingViolation, 1);
  assert.equal(value.ioOperations['set-info'].database.lockConflict, 1);
  assert.equal(value.ioOperations.read.database.nonZeroStatus, 1);
  assert.equal(value.ioOperations.read.database.accessDenied, 0);
  assert.equal(value.ioOperations.unfinished, 1);
  assert.equal(value.traceCompletenessVerified, false);
  assert.equal(value.fiveSecondQualified, false);
  assert.doesNotMatch(JSON.stringify(value), /Temp|aB012z|checkpoint|0xc000|0x10/);
  assert.deepEqual(parseSummary(JSON.stringify(value)), value);
  value.ioOperations.write.journal.count = 999;
  assert.equal(summary.snapshot().ioOperations.write.journal.count, 1);
});

test('IRP reuse by other operations or unrelated files invalidates an old flush instead of pairing its end', () => {
  for (const type of OPERATION_TYPES) {
    const summary = fixture();
    summary.observe(event('flush', '20', 10, '1'));
    summary.observe(event(type, '20', 20, type === 'create' ? 'journal' : '2'));
    summary.observe(event('end', '20', 30, '0'));
    const value = summary.snapshot();
    assert.equal(value.pairedFlushes, 1);
    assert.equal(value.collisions, 1);
    assert.equal(value.ioOperations[type].journal.count, 1);
    assert.throws(() => parseSummary(JSON.stringify(value)));
  }
  const unrelated = fixture();
  unrelated.observe(event('flush', '30', 10, '1'));
  unrelated.observe(event('invalidate', '30', 20));
  unrelated.observe(event('end', '30', 30, '0'));
  assert.equal(unrelated.snapshot().pairedFlushes, 1);
  assert.equal(unrelated.snapshot().collisions, 1);
  assert.throws(() => unrelated.observe(event('invalidate', '31', 40, 'PRIVATE')));
  const reused = fixture();
  reused.observe(event('write', '40', 10, '1'));
  reused.observe(event('flush', '40', 20, '2'));
  reused.observe(event('end', '40', 30, '0'));
  assert.equal(reused.snapshot().ioOperations.collisions, 1);
  assert.equal(reused.snapshot().ioOperations.write.database.count, 0);
});

test('normalized status histograms are bounded, ordered, exact and compatible with prior schema2 evidence', () => {
  const summary = fixture();
  for (const [index, status] of ['259', '-1073741790', '259', '-1'].entries()) {
    const key = String(index + 200);
    summary.observe(event('write', key, 10, '1'));
    summary.observe(event('end', key, 20, status));
  }
  const value = summary.snapshot();
  assert.deepEqual(value.ioOperations.write.database.statuses, [
    { code: 259, count: 2 },
    { code: 0xc0000022, count: 1 },
    { code: 0xffffffff, count: 1 },
  ]);
  assert.deepEqual(parseSummary(JSON.stringify(value)), value);
  const legacy = globalThis.structuredClone(value);
  legacy.schemaVersion = 2;
  delete legacy.ioOperations.create;
  for (const type of OPERATION_TYPES.filter((type) => type !== 'create'))
    for (const stats of Object.values(legacy.ioOperations[type])) delete stats.statuses;
  assert.deepEqual(parseSummary(JSON.stringify(legacy)), legacy);
  for (const bad of [
    [],
    null,
    [{ code: 'PRIVATE', count: 4 }],
    [{ code: 0, count: 4 }],
    [{ code: 0x100000000, count: 4 }],
    [{ code: 259, count: 0 }],
    [
      { code: 259, count: 1 },
      { code: 259, count: 3 },
    ],
    [{ code: 259, count: 4 }],
    Array.from({ length: 17 }, (_, index) => ({ code: index + 1, count: 1 })),
  ]) {
    const invalid = globalThis.structuredClone(value);
    invalid.ioOperations.write.database.statuses = bad;
    assert.throws(() => parseSummary(JSON.stringify(invalid)));
  }
  value.ioOperations.write.database.statuses[0].count = 999;
  assert.equal(summary.snapshot().ioOperations.write.database.statuses[0].count, 2);
  const bounded = fixture();
  for (let status = 1; status <= 16; status++) {
    bounded.observe(event('write', String(status + 200), 10, '1'));
    bounded.observe(event('end', String(status + 200), 20, String(status)));
  }
  assert.equal(bounded.snapshot().ioOperations.write.database.statuses.length, 16);
  bounded.observe(event('write', '999', 10, '1'));
  assert.throws(() => bounded.observe(event('end', '999', 20, '17')));
});

test('extended receipt refuses malformed and inconsistent operation metrics with the original bounds', () => {
  const summary = fixture();
  summary.observe(event('write', '10', 10, '1'));
  summary.observe(event('end', '10', 110, '0'));
  const good = summary.snapshot();
  for (const mutate of [
    (v) => {
      v.ioOperations.write.database.count = -1;
    },
    (v) => {
      v.ioOperations.write.database.count = 100001;
    },
    (v) => {
      v.ioOperations.write.database.maxMs = 0;
    },
    (v) => {
      v.ioOperations.write.database.accessDenied = 1;
    },
    (v) => {
      v.ioOperations.write.database.private = 'PRIVATE';
    },
    (v) => {
      v.ioOperations.unfinished = 8193;
    },
    (v) => {
      v.ioOperations.extra = {};
    },
    (v) => {
      v.ioOperations = [];
    },
    (v) => {
      v.schemaVersion = 1;
    },
    (v) => {
      v.scope = 'synthetic_sqlite_etw_flush_pairs';
    },
    (v) => {
      v.events = 2;
    },
  ]) {
    const value = globalThis.structuredClone(good);
    mutate(value);
    assert.throws(() => parseSummary(JSON.stringify(value)));
  }
  const backwards = fixture();
  backwards.observe(event('read', '10', 10, '1'));
  assert.throws(() => backwards.observe(event('end', '10', 9, '0')));
  const bounded = fixture();
  for (let index = 0; index < 8192; index++)
    bounded.observe(event('read', String(index + 1000), 0, '1'));
  assert.throws(() => bounded.observe(event('write', '99999', 0, '1')));
});

test('actual PowerShell decodes documented x64 operation layouts and invalidates reused unrelated IRPs', () => {
  const file = path
    .resolve(__dirname, '../scripts/lib/persistent-io-recording.psm1')
    .replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop'
    $module=Import-Module '${file}' -PassThru -Force
    & $module {
      foreach($op in @(65,66,67,68,69,70,71,74,75)) {
        foreach($version in @(2,3)) {
          if($op -in @(65,66)) {$length=if($version -eq 2){32}else{28};$irp=0;$key=if($version -eq 2){24}else{16}}
          elseif($op -in @(67,68)) {$length=if($version -eq 2){48}else{44};$irp=8;$key=if($version -eq 2){32}else{24}}
          else {$length=if($version -eq 2){44}else{40};$irp=0;$key=if($version -eq 2){24}else{16}}
          $bytes=[byte[]]::new($length);[BitConverter]::GetBytes([uint64]32).CopyTo($bytes,$irp);[BitConverter]::GetBytes([uint64]16).CopyTo($bytes,$key)
          $decoded=ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($bytes)) $op $version
          if($decoded.IrpPtr -cne '0x0000000000000020' -or $decoded.FileKey -cne '0x0000000000000010'){throw 'operation_layout_mismatch'}
          foreach($badVersion in @(0,1,4)) { $refused=$false;try {ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($bytes)) $op $badVersion}catch{$refused=$true};if(-not $refused){throw 'unknown_version_accepted'} }
          $refused=$false;try {ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString([byte[]]::new($length-1))) $op $version}catch{$refused=$true};if(-not $refused){throw 'bad_length_accepted'}
        }
      }
      foreach($op in @(67,68)) {
        $bytes=[byte[]]::new(48);[BitConverter]::GetBytes([uint64]32).CopyTo($bytes,8);[BitConverter]::GetBytes([uint64]16).CopyTo($bytes,24)
        $decoded=ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($bytes)) $op 3
        if($decoded.IrpPtr -cne '0x0000000000000020' -or $decoded.FileKey -cne '0x0000000000000010'){throw 'padded_operation_mismatch'}
      }
      foreach($op in @(72,77)) { foreach($version in @(2,3)) {
        $length=if($op -eq 64){if($version -eq 2){38}else{34}}else{if($version -eq 2){46}else{42}}
        $bytes=[byte[]]::new($length);[BitConverter]::GetBytes([uint64]32).CopyTo($bytes,0)
        $decoded=ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($bytes)) $op $version
        if($decoded.Count -ne 1 -or $decoded.IrpPtr -cne '0x0000000000000020'){throw 'invalidation_header_mismatch'}
        $refused=$false;try {ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($bytes)) $op 4}catch{$refused=$true};if(-not $refused){throw 'unknown_header_version_accepted'}
        $refused=$false;try {ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString([byte[]]::new($length-1))) $op $version}catch{$refused=$true};if(-not $refused){throw 'short_header_accepted'}
      } }
      function EventXml($items){'<Event><EventData>'+($items.GetEnumerator()|ForEach-Object{'<Data Name="'+$_.Key+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'})+'</EventData></Event>'}
      $state=@{names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);irps=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)}
      [void]$state.names.Add('0x0000000000000010')
      foreach($op in @(65,66,67,68,69,70,73)) {
        $record=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';FileKey='0x10'}) $op 10 $state | ConvertFrom-Json
        if($record.type -cnotin @('cleanup','close','read','write','set-info','delete','flush')){throw 'missing_operation'}
        $invalidated=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';FileKey='0x99'}) $op 20 $state | ConvertFrom-Json
        if($invalidated.type -cne 'invalidate' -or $invalidated.name -cne '' -or $state.irps.Count -ne 0){throw 'unrelated_irp_not_invalidated'}
        if(@(ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';NtStatus='0'}) 76 30 $state).Count){throw 'unrelated_end_exported'}
      }
      foreach($op in @(64,71,72,74,75,77)) {
        [void]$state.irps.Add('0x0000000000000020')
        $record=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';FileKey='0x10'}) $op 40 $state | ConvertFrom-Json
        if($record.type -cne 'invalidate' -or $state.irps.Count -ne 0){throw 'untracked_reuse_not_invalidated'}
      }
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('file-open observations retain filtered failure evidence without a prior name event', () => {
  const summary = fixture();
  summary.observe(event('read', '899', 1, '1'));
  summary.observe(event('end', '899', 2, '0'));
  summary.observe(event('create', '900', 10, 'journal'));
  summary.observe(event('end', '900', 35, '0xc0000043'));
  summary.observe(event('create', '901', 40, 'database'));
  summary.observe(event('end', '901', 1140, '0'));
  const value = summary.snapshot();
  assert.equal(value.schemaVersion, 4);
  assert.equal(value.ioOperations.create.journal.sharingViolation, 1);
  assert.equal(value.ioOperations.create.database.maxMs, 1100);
  assert.equal(value.pairedFlushes, 1);
  assert.deepEqual(parseSummary(JSON.stringify(value)), value);
  for (const name of ['', 'PRIVATE', filename, 'Database']) {
    assert.throws(() => fixture().observe(event('create', '902', 10, name)));
  }
  for (const schemaVersion of [2, 3]) {
    const legacy = globalThis.structuredClone(value);
    legacy.schemaVersion = schemaVersion;
    delete legacy.ioOperations.create;
    if (schemaVersion === 2)
      for (const type of Object.keys(legacy.ioOperations))
        if (!['collisions', 'unfinished'].includes(type))
          for (const stats of Object.values(legacy.ioOperations[type])) delete stats.statuses;
    // These two creates are absent from the legacy evidence, never inferred.
    assert.deepEqual(parseSummary(JSON.stringify(legacy)), legacy);
  }
  const downgrade = globalThis.structuredClone(value);
  downgrade.schemaVersion = 3;
  assert.throws(() => parseSummary(JSON.stringify(downgrade)));
});

test('actual PowerShell filters and pairs x64 create records without exporting their paths', () => {
  const file = path
    .resolve(__dirname, '../scripts/lib/persistent-io-recording.psm1')
    .replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop'
    $module=Import-Module '${file}' -PassThru -Force
    & $module {
      function EventXml($items){'<Event><EventData>'+($items.GetEnumerator()|ForEach-Object{'<Data Name="'+$_.Key+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'})+'</EventData></Event>'}
      function Fresh { @{names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);irps=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)} }
      $name='C:/Temp/hpm-wbipc-core-aB012z/context/checkpoint.sqlite'
      foreach($version in @(2,3)) {
        foreach($suffix in @('','-journal')) {
          $offset=if($version -eq 2){36}else{32}
          $path=$name+$suffix
          $text=[Text.Encoding]::Unicode.GetBytes($path+[char]0)
          $bytes=[byte[]]::new($offset+$text.Length)
          [BitConverter]::GetBytes([uint64]32).CopyTo($bytes,0);$text.CopyTo($bytes,$offset)
          $hex=[Convert]::ToHexString($bytes)
          $decoded=ConvertFrom-HpmFileIoBinary $hex 64 $version
          if($decoded.Count -ne 2 -or $decoded.IrpPtr -cne '0x0000000000000020' -or $decoded.OpenPath -cne $path){throw 'create_layout_mismatch'}
          $state=Fresh
          $xml='<Event><System><Version>'+ $version +'</Version></System><BinaryEventData>'+ $hex +'</BinaryEventData></Event>'
          $raw=ConvertTo-HpmPersistentIoRecord $xml 64 10 $state
          $record=$raw|ConvertFrom-Json
          $kind=if($suffix){'journal'}else{'database'}
          if($record.type -cne 'create' -or $record.name -cne $kind -or $raw.Contains('Temp') -or $state.names.Count -ne 0 -or $state.irps.Count -ne 1){throw 'create_filter_mismatch'}
          $end=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';NtStatus='3221225539'}) 76 35 $state|ConvertFrom-Json
          if($end.type -cne 'end' -or $end.name -cne '3221225539' -or $state.irps.Count -ne 0){throw 'create_end_mismatch'}
          foreach($bad in @([Convert]::ToHexString([byte[]]::new($offset)), $hex.Substring(0,$hex.Length-2), $hex.Substring(0,$hex.Length-4)+'0100')) {
            $refused=$false;try{ConvertFrom-HpmFileIoBinary $bad 64 $version}catch{$refused=$true};if(-not $refused){throw 'bad_create_accepted'}
          }
          $invalid=[byte[]]::new($offset+4);$invalid[$offset]=0;$invalid[$offset+1]=216
          $refused=$false;try{ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($invalid)) 64 $version}catch{$refused=$true};if(-not $refused){throw 'invalid_unicode_accepted'}
          $nul=[Text.Encoding]::Unicode.GetBytes($name+[char]0+'suffix'+[char]0);$bad=[byte[]]::new($offset+$nul.Length);$nul.CopyTo($bad,$offset)
          $refused=$false;try{ConvertFrom-HpmFileIoBinary ([Convert]::ToHexString($bad)) 64 $version}catch{$refused=$true};if(-not $refused){throw 'embedded_nul_accepted'}
          foreach($badVersion in @(0,1,4)) {$refused=$false;try{ConvertFrom-HpmFileIoBinary $hex 64 $badVersion}catch{$refused=$true};if(-not $refused){throw 'unknown_create_version_accepted'}}
        }
      }
      foreach($field in @('OpenPath','FileName')) {
        $state=Fresh;$fields=@{IrpPtr='0x20'};$fields[$field]=$name
        $record=ConvertTo-HpmPersistentIoRecord (EventXml $fields) 64 10 $state|ConvertFrom-Json
        if($record.name -cne 'database'){throw 'named_create_missing'}
      }
      $case=0
      foreach($path in @('', 'PRIVATE', ($name+'.backup'), ($name+'/extra'), ($name+[char]10), 'C:/Temp/other/context/checkpoint.sqlite')) {
        $case++;$state=Fresh;[void]$state.irps.Add('0x0000000000000020')
        $raw=ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';OpenPath=$path}) 64 10 $state
        $record=$raw|ConvertFrom-Json
        if($record.type -cne 'invalidate' -or $record.name -cne '' -or $state.irps.Count -ne 0){throw ('unrelated_create_not_invalidated_'+$case)}
        if(@(ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';NtStatus='0'}) 76 20 $state).Count){throw 'unrelated_create_end_exported'}
      }
      $state=Fresh;$refused=$false;try{ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';OpenPath=$name;FileName=$name}) 64 10 $state}catch{$refused=$true};if(-not $refused){throw 'ambiguous_create_accepted'}
      $state=Fresh;for($i=1;$i -le 8192;$i++){[void]$state.irps.Add([string]$i)}
      $refused=$false;try{ConvertTo-HpmPersistentIoRecord (EventXml @{IrpPtr='0x20';OpenPath=$name}) 64 10 $state}catch{$refused=$true};if(-not $refused){throw 'create_bound_missing'}
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
