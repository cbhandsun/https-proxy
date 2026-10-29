'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('actual compiled primitive TDH raw reader and fake API retain clock, scalar and lifecycle boundaries', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'fixtures/persistent-filterio-native.ps1'),
      path.resolve(__dirname, '..'),
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 8192 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /PRIVATE|checkpoint|0x|fixtureTag/);
  const receipt = JSON.parse(result.stdout);
  assert.ok(receipt.checks >= 75);
  assert.equal(receipt.nativeWindowsExecuted, false);
  assert.equal(receipt.filterAttributionQualified, false);
  assert.equal(receipt.realModelRequests, 0);
});

test('native scalar consumer keeps metadata reader independent and reads only named primitive properties', () => {
  const read = (name) =>
    fs.readFileSync(
      path.join(__dirname, '../scripts/lib/persistent-filterio-' + name + '.cs'),
      'utf8'
    );
  const native = read('native'),
    properties = read('native-properties'),
    reader = read('raw-reader');
  assert.match(native, /TdhGetPropertySize/);
  assert.match(native, /TdhGetProperty"/);
  assert.match(native, /DllImportSearchPath.System32/);
  assert.match(reader, /ProcessTraceMode=0x10001000/);
  assert.match(reader, /ReservedFlags!=1/);
  assert.match(reader, /MaximumOutput=8388608/);
  assert.match(reader, /ElapsedMilliseconds>=30000/);
  assert.match(properties, /ArrayIndex=UInt32.MaxValue/);
  const profile = fs.readFileSync(
    path.join(__dirname, '../scripts/fixtures/persistent-io-schema.wprp'),
    'utf8'
  );
  assert.match(profile, /CustomKeyword Value="0x2"/);
  assert.doesNotMatch(profile, /ProcessThread/);
  assert.doesNotMatch(
    native + properties + reader,
    /\.UserData|\.ExtendedData|ReadProcessMemory|PtrToStringUni|TdhFormatProperty/
  );
});
