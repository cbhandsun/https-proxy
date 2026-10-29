'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

test('actual compiled TDH metadata parser and fake native lifecycle fail closed without inspecting payload pointers', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'fixtures/persistent-io-schema/tdh.ps1'),
      path.resolve(__dirname, '..'),
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 16384 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /PRIVATE|metadataProvider|Field0|ProviderGuid|UserData/);
  const receipt = JSON.parse(result.stdout);
  assert.ok(receipt.managedChecks >= 95);
  assert.equal(receipt.contractRejections, 14);
  assert.equal(receipt.failureRejections, 12);
  assert.equal(receipt.nativeWindowsExecuted, false);
  assert.equal(receipt.sampledMetadataOnly, true);
  assert.equal(receipt.fieldTypesVerified, false);
  assert.equal(receipt.filterAttributionQualified, false);
  assert.equal(receipt.modelRequests, 0);
});

test('TDH is metadata-only, keeps original bounds and never uses the FileIO value decoder', () => {
  const directory = path.join(__dirname, '../scripts/lib');
  const native = fs.readFileSync(
    path.join(directory, 'persistent-io-schema-tdh-native.cs'),
    'utf8'
  );
  const reader = fs.readFileSync(
    path.join(directory, 'persistent-io-schema-tdh-reader.cs'),
    'utf8'
  );
  const process = fs.readFileSync(path.join(directory, 'persistent-io-schema-tdh.psm1'), 'utf8');
  const pins = fs.readFileSync(path.join(directory, 'persistent-io-schema-tdh-path.cs'), 'utf8');
  const recording = fs.readFileSync(
    path.join(directory, 'persistent-io-schema-recording.psm1'),
    'utf8'
  );
  const child = fs.readFileSync(path.join(directory, 'persistent-io-schema-tdh-child.ps1'), 'utf8');
  assert.match(pins, /Open\(path, 0x81, leaf \? 1u : 3u/);
  assert.match(pins, /value.Links != 1/);
  assert.match(pins, /value.SizeLow > 268435456/);
  assert.ok(
    recording.indexOf('$tracePins=New-HpmSchemaTracePins') <
      recording.indexOf("$phase='schema';Read-HpmSchemaEvents")
  );
  assert.ok(
    recording.indexOf('$tracePins.Verify()') >
      recording.indexOf('$receipt.tdhMetadata=Invoke-HpmSchemaTdhMetadata')
  );
  assert.ok(
    recording.indexOf('$tracePins.Dispose()') < recording.indexOf('try{Remove-HpmSchemaRoot')
  );
  assert.match(native, /TdhGetEventInformation/);
  assert.doesNotMatch(
    native + reader,
    /TdhGetProperty|TdhFormatProperty|TdhGetEventMapInformation|\.UserData|\.ExtendedData|ConvertFrom-HpmFileIoBinary/
  );
  assert.match(native, /DllImportSearchPath.System32/);
  assert.match(reader, /ProcessTraceMode = 0x10000000/);
  assert.match(reader, /Opcode < 96 \|\|/);
  assert.match(reader, /Opcode > 101/);
  assert.match(process, /30000 16384 \$job/);
  assert.ok(child.indexOf('ReadByte()') < child.indexOf('Add-Type -Path'));
  assert.doesNotMatch(
    process + child,
    /Get-WinEvent|StartTrace|Wpr|wpr\.exe|\.etl.*Hash|TraceSha256/
  );
});
