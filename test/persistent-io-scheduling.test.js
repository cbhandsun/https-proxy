'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createPersistentIoScheduling,
  validatePersistentIoScheduling,
} = require('../scripts/lib/persistent-io-scheduling');
const { createPersistentIoSummary } = require('../scripts/lib/persistent-io-summary');
const { parseSummary } = require('../scripts/lib/coverage-io-capture');
const { normalizeCompactionData } = require('../lib/proxy/context-compaction-envelope');
const { discoverTestFiles } = require('../lib/test-discovery');

function fixture() {
  const value = createPersistentIoScheduling();
  value.observe('schedule-start', '1', 0, '');
  value.observe('schedule-bind', '2a', 1000, '');
  return value;
}
function interval(value, start, end, state, reason, key = '2a') {
  value.observe('schedule-out', key, start, state + ':' + reason);
  value.observe('schedule-in', key, end, '');
}

test('only explicitly bound thread lifetimes pair, with delay execution and ready time kept distinct', () => {
  const value = fixture();
  interval(value, 1000, 1200, 5, 4);
  interval(value, 1200, 1350, 5, 11);
  interval(value, 1350, 2400, 1, 32);
  interval(value, 2400, 2420, 5, 0);
  interval(value, 2420, 2420, 250, 255);
  const report = value.snapshot();
  assert.equal(report.intervals, 5);
  assert.deepEqual(report.delayExecution, {
    count: 2,
    totalMs: 350,
    maxMs: 200,
    over100Ms: 2,
    over1000Ms: 0,
  });
  assert.equal(report.ready.maxMs, 1050);
  assert.equal(report.otherWaiting.totalMs, 20);
  assert.equal(report.other.count, 1);
  assert.equal(report.traceCompletenessVerified, false);
  assert.equal(report.commitCorrelationQualified, false);
  assert.deepEqual(
    validatePersistentIoScheduling(report, 20),
    normalizeCompactionData(report, 8192)
  );
  assert.doesNotMatch(JSON.stringify(report), /2a|threadId|processId|PRIVATE|0x/);
  report.delayExecution.count = 999;
  report.delayExecutionWindows[0].elapsedMs = 999;
  assert.equal(value.snapshot().delayExecution.count, 2);
  assert.equal(value.snapshot().delayExecutionWindows[0].elapsedMs, 200);
});

test('retirement and ID reuse never join lifetimes; lost switch-outs remain explicit gaps', () => {
  const value = fixture();
  value.observe('schedule-out', '2a', 1000, '5:4');
  value.observe('schedule-retire', '2a', 1100, '');
  value.observe('schedule-bind', '2a', 1200, '');
  value.observe('schedule-in', '2a', 1300, '');
  value.observe('schedule-out', '2a', 1400, '5:4');
  value.observe('schedule-out', '2a', 1500, '1:0');
  value.observe('schedule-in', '2a', 1600, '');
  const report = value.snapshot();
  assert.equal(report.bindings, 2);
  assert.equal(report.retired, 1);
  assert.equal(report.gaps, 1);
  assert.equal(report.unfinished, 1);
  assert.equal(report.switchOuts, 3);
  assert.equal(report.intervals, 1);
  assert.equal(report.delayExecution.count, 0);
  assert.equal(report.ready.totalMs, 100);
  assert.deepEqual(
    validatePersistentIoScheduling(report, 20),
    normalizeCompactionData(report, 8192)
  );
});

test('top eight delay windows are bounded and sortable, not an invented complete request timeline', () => {
  const value = fixture();
  let time = 1000;
  for (let n = 0; n < 20; n++) {
    interval(value, time, time + n, 5, 4);
    time += n + 1;
  }
  assert.deepEqual(
    value.snapshot().delayExecutionWindows.map((row) => row.elapsedMs),
    [19, 18, 17, 16, 15, 14, 13, 12]
  );
  assert.deepEqual(
    validatePersistentIoScheduling(value.snapshot(), 100),
    normalizeCompactionData(value.snapshot(), 8192)
  );
});

test('invalid states, stale timing, unknown bindings and extreme identifiers cannot create intervals', () => {
  for (const args of [
    ['other', '2a', 1000, ''],
    ['schedule-out', '2a', 999, '5:4'],
    ['schedule-out', '2a', 1000, '256:4'],
    ['schedule-out', '2a', 1000, '5:256'],
    ['schedule-out', '2a', 1000, '05:4'],
    ['schedule-out', '2a', 1000, 'PRIVATE_VALUE'],
    ['schedule-in', '2b', 1000, ''],
    ['schedule-bind', '2a', 1000, ''],
    ['schedule-start', '1', 0, ''],
    ['schedule-bind', '100000000', 1000, ''],
    ['schedule-bind', '0', 1000, ''],
    ['schedule-bind', 'x', 1000, ''],
    ['schedule-in', '2a', NaN, ''],
    ['schedule-in', '2a', Infinity, ''],
  ])
    assert.throws(() => fixture().observe(...args), /^Error: persistent_io_scheduling_invalid$/);
  const held = fixture();
  held.observe('schedule-out', '2a', 1000, '5:4');
  assert.throws(() => held.observe('schedule-in', '2a', 601001, ''));
  const bounded = fixture();
  for (let key = 100; key < 355; key++)
    bounded.observe('schedule-bind', key.toString(16), 1000, '');
  assert.throws(() => bounded.observe('schedule-bind', 'ffff', 1000, ''));
});

test('schema five keeps original I/O gates and rejects forged scheduling counters, windows or qualification', () => {
  const summary = createPersistentIoSummary();
  const observe = (type, key, timeMs, name = '') => summary.observe({ type, key, timeMs, name });
  observe('schedule-start', '1', 0);
  observe('name', '1', 0, 'C:\\Temp\\hpm-wbipc-core-aB012z\\context\\checkpoint.sqlite');
  observe('flush', '2', 10, '1');
  observe('end', '2', 11, '0');
  observe('schedule-bind', '0x2a', 1000);
  observe('schedule-out', '0x2a', 1000, '5:4');
  observe('schedule-in', '0x2a', 1200);
  const report = summary.snapshot();
  assert.equal(report.schemaVersion, 5);
  assert.equal(report.ioOperations, null);
  assert.equal(report.pairedFlushes, 1);
  assert.deepEqual(parseSummary(JSON.stringify(report)), report);
  for (const change of [
    (x) => {
      x.ioScheduling.commitCorrelationQualified = true;
    },
    (x) => {
      x.ioScheduling.traceCompletenessVerified = true;
    },
    (x) => {
      x.ioScheduling.intervals++;
    },
    (x) => {
      x.ioScheduling.bindings = 0;
    },
    (x) => {
      x.ioScheduling.delayExecution.totalMs = 201;
    },
    (x) => {
      x.ioScheduling.delayExecution.over100Ms = 0;
    },
    (x) => {
      x.ioScheduling.delayExecutionWindows[0].finishedAtMs++;
    },
    (x) => {
      x.ioScheduling.threadId = 'PRIVATE_TID';
    },
    (x) => {
      x.fiveSecondQualified = true;
    },
    (x) => {
      x.schemaVersion = 4;
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(report));
    change(bad);
    assert.throws(() => parseSummary(JSON.stringify(bad)));
  }
  let traps = 0;
  const hostile = Object.defineProperty({}, 'schemaVersion', {
    enumerable: true,
    get() {
      traps++;
      return undefined;
    },
  });
  for (const bad of [hostile, new Proxy({}, {}), null, [], {}])
    assert.throws(() => validatePersistentIoScheduling(bad, 20));
  assert.equal(traps, 0);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/persistent-io-scheduling.test.js'
    )
  );
});

test('PowerShell public binary prefixes bind only SQLite flush issuers and retire thread IDs', () => {
  const module = path.resolve('scripts/lib/persistent-io-scheduling.psm1').replaceAll("'", "''");
  const binary = Buffer.alloc(24);
  binary.writeUInt32LE(99, 0);
  binary.writeUInt32LE(42, 4);
  binary[12] = 4;
  binary[14] = 5;
  const entered = Buffer.alloc(24);
  entered.writeUInt32LE(42, 0);
  entered.writeUInt32LE(99, 4);
  entered[14] = 1;
  const retired = Buffer.alloc(8);
  retired.writeUInt32LE(42, 4);
  const code = `
    $ErrorActionPreference='Stop';Import-Module '${module}' -Force
    $state=New-HpmIoSchedulingState
    $doc=[xml]'<Event><System><Execution ThreadID="42"/></System></Event>'
    $records=@(Add-HpmIoSchedulingBinding @{} $doc 1000 $state)
    $records+=ConvertTo-HpmThreadSchedulingRecord '<Event><System><Version>2</Version></System><BinaryEventData>${binary.toString('hex')}</BinaryEventData></Event>' 36 1000 $state
    $records+=ConvertTo-HpmThreadSchedulingRecord '<Event><System><Version>3</Version></System><ProcessingErrorData><EventPayload>${entered.toString('hex')}</EventPayload></ProcessingErrorData></Event>' 36 1200 $state
    $records+=ConvertTo-HpmThreadSchedulingRecord '<Event><System><Version>4</Version></System><EventData><Data>${retired.toString('hex')}</Data></EventData></Event>' 2 1300 $state
    if($state.bound.Count -ne 0){throw 'retirement_failed'}
    $records | ForEach-Object {[Console]::Out.WriteLine($_)}
    foreach($bad in @(@{Hex='00';Opcode=36;Version=2},@{Hex='${binary.toString('hex')}';Opcode=36;Version=6},@{Hex='${retired.toString('hex')}';Opcode=50;Version=2})){
      $rejected=$false;try{ConvertFrom-HpmThreadSchedulingBinary @bad|Out-Null}catch{if($_.Exception.Message -cne 'persistent_io_scheduling_refused'){throw 'unsafe_error'};$rejected=$true};if(-not $rejected){throw 'missing_rejection'}
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((row) => row.type),
    ['schedule-bind', 'schedule-out', 'schedule-in', 'schedule-retire']
  );
  const summary = createPersistentIoScheduling();
  summary.observe('schedule-start', '1', 0, '');
  for (const row of records)
    summary.observe(row.type, BigInt(row.key).toString(16), row.timeMs, row.name);
  assert.equal(summary.snapshot().delayExecution.maxMs, 200);
  assert.equal(summary.snapshot().retired, 1);
});

test('unmapped metadata abandons pending intervals and requires a new positive SQLite binding', () => {
  const value = fixture();
  value.observe('schedule-out', '2a', 1000, '5:4');
  value.observe('schedule-unmapped', '1', 1100, '');
  assert.throws(() => value.observe('schedule-in', '2a', 1200, ''));
  value.observe('schedule-bind', '2a', 1300, '');
  value.observe('schedule-in', '2a', 1400, '');
  interval(value, 1500, 1600, 5, 4);
  const report = value.snapshot();
  assert.equal(report.unmappedEpochs, 1);
  assert.equal(report.unfinished, 1);
  assert.equal(report.retired, 1);
  assert.equal(report.intervals, 1);
  assert.equal(report.delayExecution.totalMs, 100);
  assert.equal(Object.getPrototypeOf(validatePersistentIoScheduling(report, 20)), null);
  for (const n of [-1, NaN, Infinity, 21, '1']) {
    assert.throws(() => validatePersistentIoScheduling({ ...report, unmappedEpochs: n }, 20));
  }
});

test('native event scalar and binary properties never pair across unsupported metadata', () => {
  const module = path.resolve('scripts/lib/persistent-io-scheduling.psm1').replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop';Import-Module '${module}' -Force
    $state=New-HpmIoSchedulingState
    $doc=[xml]'<Event><System><Execution ThreadID="42"/></System></Event>'
    function Event($version,$values) { [pscustomobject]@{Version=$version;Properties=@($values|ForEach-Object{[pscustomobject]@{Value=$_}})} }
    Add-HpmIoSchedulingBinding @{} $doc 1000 $state
    $out=Event 2 @([uint32]99,[uint32]42,[byte]0,[byte]0,[byte]0,[byte]0,[byte]4,[byte]0,[byte]5)
    ConvertTo-HpmThreadSchedulingEvent $out 36 1000 $state
    $unsupported=Event 6 @([uint32]42)
    ConvertTo-HpmThreadSchedulingEvent $unsupported 36 1100 $state
    if($state.bound.Count -ne 0){throw 'binding_survived'}
    ConvertTo-HpmThreadSchedulingEvent $unsupported 36 1200 $state
    Add-HpmIoSchedulingBinding @{TTID='42'} $doc 1300 $state
    ConvertTo-HpmThreadSchedulingEvent $out 36 1300 $state
    $bytes=[byte[]]::new(24);[BitConverter]::GetBytes([uint32]42).CopyTo($bytes,0);[BitConverter]::GetBytes([uint32]99).CopyTo($bytes,4)
    $binary=[pscustomobject]@{Version=3;Properties=@([pscustomobject]@{Value=$bytes})}
    ConvertTo-HpmThreadSchedulingEvent $binary 36 1500 $state
    $end=Event 4 @([uint32]7,[uint32]42)
    ConvertTo-HpmThreadSchedulingEvent $end 2 1600 $state
    if($state.bound.Count -ne 0){throw 'retirement_failed'}
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((x) => x.type),
    [
      'schedule-bind',
      'schedule-out',
      'schedule-unmapped',
      'schedule-bind',
      'schedule-out',
      'schedule-in',
      'schedule-retire',
    ]
  );
  const summary = createPersistentIoScheduling();
  summary.observe('schedule-start', '1', 0, '');
  for (const row of records)
    summary.observe(row.type, BigInt(row.key).toString(16), row.timeMs, row.name);
  assert.equal(summary.snapshot().unmappedEpochs, 1);
  assert.equal(summary.snapshot().unfinished, 1);
  assert.equal(summary.snapshot().delayExecution.totalMs, 200);
  validatePersistentIoScheduling(summary.snapshot(), 20);
});

test('unmapped metadata retains only bounded scalar shape categories and rejects forged evidence', () => {
  const value = fixture();
  value.observe('schedule-unmapped', '1', 1100, 'v2:p0:tnone:escalar');
  const report = value.snapshot();
  assert.deepEqual(report.unmappedMetadata, [{ shape: 'v2:p0:tnone:escalar', count: 1 }]);
  validatePersistentIoScheduling(report, 10);
  const legacy = { ...report, schemaVersion: 1 };
  delete legacy.unmappedMetadata;
  validatePersistentIoScheduling(legacy, 10);
  for (const metadata of [
    [{ shape: 'PRIVATE', count: 1 }],
    [{ shape: 'v256:p0:tnone:escalar', count: 1 }],
    [{ shape: 'v2:p65:tnone:escalar', count: 1 }],
    [{ shape: 'v2:p0:tnone:escalar', count: 0 }],
    [],
    Array(17).fill({ shape: 'unknown', count: 1 }),
  ]) {
    assert.throws(() =>
      validatePersistentIoScheduling({ ...report, unmappedMetadata: metadata }, 10)
    );
  }
  for (const shape of ['PRIVATE', 'v256:p0:tnone:escalar', 'v2:p65:tnone:escalar']) {
    assert.throws(() => fixture().observe('schedule-unmapped', '1', 1100, shape));
  }
});

test('unsupported actual event metadata reports version and count without values or error text', () => {
  const module = path.resolve('scripts/lib/persistent-io-scheduling.psm1').replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop';Import-Module '${module}' -Force
    $state=New-HpmIoSchedulingState
    $doc=[xml]'<Event><System><Execution ThreadID="42"/></System></Event>'
    Add-HpmIoSchedulingBinding @{} $doc 1 $state|Out-Null
    ConvertTo-HpmThreadSchedulingEvent ([pscustomobject]@{Version=2;Properties=@()}) 36 2 $state
    Add-HpmIoSchedulingBinding @{} $doc 3 $state|Out-Null
    ConvertTo-HpmThreadSchedulingEvent ([pscustomobject]@{Version=2;Properties=@([pscustomobject]@{Value='PRIVATE_METADATA'})}) 36 4 $state
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((x) => x.name),
    ['v2:p0:tnone:escalar', 'v2:p1:tstring:epayload']
  );
  assert.doesNotMatch(result.stdout, /PRIVATE_METADATA|Exception|Error/);
});

test('observed Windows v5 uses the documented fixed prefixes and unknown v6 stays unmapped', () => {
  const module = path.resolve('scripts/lib/persistent-io-scheduling.psm1').replaceAll("'", "''");
  const leave = Buffer.alloc(32);
  leave.writeUInt32LE(99, 0);
  leave.writeUInt32LE(42, 4);
  leave[12] = 11;
  leave[14] = 5;
  const enter = Buffer.alloc(32);
  enter.writeUInt32LE(42, 0);
  enter.writeUInt32LE(99, 4);
  const code = `
    $ErrorActionPreference='Stop';Import-Module '${module}' -Force
    $state=New-HpmIoSchedulingState
    $doc=[xml]'<Event><System><Execution ThreadID="42"/></System></Event>'
    Add-HpmIoSchedulingBinding @{} $doc 1 $state
    ConvertTo-HpmThreadSchedulingRecord '<Event><System><Version>5</Version></System><BinaryEventData>${leave.toString('hex')}</BinaryEventData></Event>' 36 10 $state
    $event=[pscustomobject]@{Version=5;Properties=@([pscustomobject]@{Value=[Convert]::FromHexString('${enter.toString('hex')}')})}
    ConvertTo-HpmThreadSchedulingEvent $event 36 210 $state
    $end=[pscustomobject]@{Version=5;Properties=@([pscustomobject]@{Value=[uint32]9},[pscustomobject]@{Value=[uint32]42})}
    ConvertTo-HpmThreadSchedulingEvent $end 2 220 $state
    Add-HpmIoSchedulingBinding @{} $doc 230 $state
    $unknown=[pscustomobject]@{Version=6;Properties=@()}
    ConvertTo-HpmThreadSchedulingEvent $unknown 36 240 $state
    if($state.bound.Count -ne 0){throw 'unmapped_binding_survived'}
    foreach($hex in @('00',('00'*65))){
      $refused=$false;try{ConvertFrom-HpmThreadSchedulingBinary $hex 36 5|Out-Null}catch{$refused=$true};if(-not $refused){throw 'invalid_v5_prefix_accepted'}
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const summary = createPersistentIoScheduling();
  summary.observe('schedule-start', '1', 0, '');
  for (const row of rows)
    summary.observe(row.type, BigInt(row.key).toString(16), row.timeMs, row.name);
  const report = summary.snapshot();
  assert.equal(report.delayExecution.totalMs, 200);
  assert.equal(report.intervals, 1);
  assert.equal(report.retired, 2);
  assert.equal(report.unmappedEpochs, 1);
  assert.deepEqual(report.unmappedMetadata, [{ shape: 'v6:px:tnone:eversion', count: 1 }]);
  assert.equal(report.commitCorrelationQualified, false);
  validatePersistentIoScheduling(report, 20);
});

test('observed empty EventRecord properties decode only original bounded XML and never reinterpret invalid nonempty metadata', () => {
  const module = path.resolve('scripts/lib/persistent-io-scheduling.psm1').replaceAll("'", "''");
  const leave = Buffer.alloc(24);
  leave.writeUInt32LE(99, 0);
  leave.writeUInt32LE(42, 4);
  leave[12] = 4;
  leave[14] = 5;
  const enter = Buffer.alloc(24);
  enter.writeUInt32LE(42, 0);
  enter.writeUInt32LE(99, 4);
  const code = `
    $ErrorActionPreference='Stop';Import-Module '${module}' -Force;$script:unexpectedRender=0
    $state=New-HpmIoSchedulingState
    $doc=[xml]'<Event><System><Execution ThreadID="42"/></System></Event>'
    Add-HpmIoSchedulingBinding @{} $doc 1 $state
    $out=[pscustomobject]@{Version=5;Properties=@()}
    $out|Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><System><Version>5</Version></System><ProcessingErrorData><EventPayload>${leave.toString('hex')}</EventPayload></ProcessingErrorData></Event>' }
    ConvertTo-HpmThreadSchedulingEvent $out 36 10 $state
    $in=[pscustomobject]@{Version=5;Properties=@()}
    $in|Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><System><Version>5</Version></System><BinaryEventData>${enter.toString('hex')}</BinaryEventData></Event>' }
    ConvertTo-HpmThreadSchedulingEvent $in 36 210 $state
    $bad=[pscustomobject]@{Version=5;Properties=@([pscustomobject]@{Value='PRIVATE_VALUE'})}
    $bad|Add-Member -MemberType ScriptMethod -Name ToXml -Value {$script:unexpectedRender++;throw 'SHOULD_NOT_RENDER'}
    ConvertTo-HpmThreadSchedulingEvent $bad 36 220 $state
    Add-HpmIoSchedulingBinding @{} $doc 230 $state
    $unsupported=[pscustomobject]@{Version=6;Properties=@()}
    $unsupported|Add-Member -MemberType ScriptMethod -Name ToXml -Value {$script:unexpectedRender++;throw 'SHOULD_NOT_RENDER'}
    ConvertTo-HpmThreadSchedulingEvent $unsupported 36 240 $state
    Add-HpmIoSchedulingBinding @{} $doc 250 $state
    $malformed=[pscustomobject]@{Version=5;Properties=@()}
    $malformed|Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<!DOCTYPE Event [<!ENTITY x SYSTEM "file:///PRIVATE">]><Event><System><Version>5</Version></System><BinaryEventData>&x;</BinaryEventData></Event>' }
    ConvertTo-HpmThreadSchedulingEvent $malformed 36 260 $state
    Add-HpmIoSchedulingBinding @{} $doc 270 $state
    $mismatch=[pscustomobject]@{Version=5;Properties=@()}
    $mismatch|Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><System><Version>4</Version></System><BinaryEventData>${enter.toString('hex')}</BinaryEventData></Event>' }
    ConvertTo-HpmThreadSchedulingEvent $mismatch 36 280 $state
    if($script:unexpectedRender -ne 0){throw 'unexpected_render'}
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /PRIVATE|SHOULD_NOT_RENDER|Exception/);
  const rows = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const summary = createPersistentIoScheduling();
  summary.observe('schedule-start', '1', 0, '');
  for (const row of rows)
    summary.observe(row.type, BigInt(row.key).toString(16), row.timeMs, row.name);
  const report = summary.snapshot();
  assert.equal(report.delayExecution.totalMs, 200);
  assert.equal(report.intervals, 1);
  assert.equal(report.unmappedEpochs, 4);
  assert.equal(report.retired, 4);
  assert.deepEqual(report.unmappedMetadata, [
    { shape: 'v5:p0:tnone:epayload', count: 2 },
    { shape: 'v5:p1:tstring:epayload', count: 1 },
    { shape: 'v6:px:tnone:eversion', count: 1 },
  ]);
  validatePersistentIoScheduling(report, 20);
});

test('observed empty v3 lifecycle XML retires selected thread bindings before ID reuse', () => {
  const module = path.resolve('scripts/lib/persistent-io-scheduling.psm1').replaceAll("'", "''");
  const thread = Buffer.alloc(8);
  thread.writeUInt32LE(9, 0);
  thread.writeUInt32LE(42, 4);
  const leave = Buffer.alloc(24);
  leave.writeUInt32LE(99, 0);
  leave.writeUInt32LE(42, 4);
  leave[12] = 11;
  leave[14] = 5;
  const enter = Buffer.alloc(24);
  enter.writeUInt32LE(42, 0);
  enter.writeUInt32LE(99, 4);
  const code = `
    $ErrorActionPreference='Stop';Import-Module '${module}' -Force
    $state=New-HpmIoSchedulingState;$doc=[xml]'<Event><System><Execution ThreadID="42"/></System></Event>'
    $out=[pscustomobject]@{Version=5;Properties=@([pscustomobject]@{Value=[Convert]::FromHexString('${leave.toString('hex')}')})}
    $in=[pscustomobject]@{Version=5;Properties=@([pscustomobject]@{Value=[Convert]::FromHexString('${enter.toString('hex')}')})}
    $lifecycle=[pscustomobject]@{Version=3;Properties=@()}
    $lifecycle|Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><System><Version>3</Version></System><ProcessingErrorData><EventPayload>${thread.toString('hex')}</EventPayload></ProcessingErrorData></Event>' }
    Add-HpmIoSchedulingBinding @{} $doc 1 $state
    ConvertTo-HpmThreadSchedulingEvent $out 36 10 $state
    ConvertTo-HpmThreadSchedulingEvent $lifecycle 1 20 $state
    if($state.bound.Count -ne 0){throw 'stale_binding'}
    Add-HpmIoSchedulingBinding @{} $doc 30 $state
    ConvertTo-HpmThreadSchedulingEvent $out 36 40 $state
    ConvertTo-HpmThreadSchedulingEvent $in 36 240 $state
    ConvertTo-HpmThreadSchedulingEvent $lifecycle 2 250 $state
    if($state.bound.Count -ne 0){throw 'retirement_failed'}
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const summary = createPersistentIoScheduling();
  summary.observe('schedule-start', '1', 0, '');
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const row = JSON.parse(line);
    summary.observe(row.type, BigInt(row.key).toString(16), row.timeMs, row.name);
  }
  const report = summary.snapshot();
  assert.equal(report.bindings, 2);
  assert.equal(report.retired, 2);
  assert.equal(report.unfinished, 1);
  assert.equal(report.intervals, 1);
  assert.equal(report.delayExecution.totalMs, 200);
  assert.equal(report.unmappedEpochs, 0);
  validatePersistentIoScheduling(report, 20);
});
