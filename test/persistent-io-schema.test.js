'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
test('actual PowerShell schema parser and recording lifecycle retain failures and reveal no payload values', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'fixtures/persistent-io-schema/probe.ps1'),
      path.resolve(__dirname, '..'),
      process.execPath,
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 131072 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /PRIVATE|TOKEN|PATH/);
  const receipts = [],
    boundaries = [];
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    if (line.startsWith('HPM_IO_SCHEMA='))
      receipts.push(JSON.parse(line.slice('HPM_IO_SCHEMA='.length)));
    else {
      assert.ok(line.startsWith('HPM_SCHEMA_PROCESS_BOUNDARY='));
      boundaries.push(JSON.parse(line.slice('HPM_SCHEMA_PROCESS_BOUNDARY='.length)));
    }
  }
  assert.deepEqual(
    boundaries.map((row) => row.mode),
    ['normal', 'assign', 'cleanup', 'held-pipe']
  );
  for (const row of boundaries) {
    assert.deepEqual(Object.keys(row).sort(), [
      'mode',
      'ownedChildAfterParentExit',
      'parentExitedAtStop',
      'passed',
      'realWindowsJob',
      'schemaVersion',
    ]);
    assert.equal(row.passed, true);
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.realWindowsJob, row.mode === 'held-pipe' && process.platform === 'win32');
  }
  const held = boundaries.at(-1);
  assert.equal(held.parentExitedAtStop, true);
  assert.equal(held.ownedChildAfterParentExit, process.platform === 'win32');
  assert.equal(receipts.length, 17);
  assert.equal(receipts.slice(0, 12).filter((row) => !row.failed).length, 1);
  assert.equal(receipts[5].originalTestsPassed, false);
  assert.equal(receipts[10].cleanupVerified, false);
  assert.equal(receipts[11].cleanupVerified, false);
  for (const row of receipts) {
    for (const key of [
      'eventSchemaVerified',
      'filterAttributionQualified',
      'fiveSecondQualified',
      'installedQualified',
      'realProviderQualified',
    ])
      assert.equal(row[key], false);
    assert.equal(row.realModelRequests, 0);
  }
  assert.equal(receipts[15].failed, true);
  assert.equal(receipts[15].cleanupVerified, true);
  assert.equal(receipts[16].failed, true);
  assert.equal(receipts[16].cleanupVerified, false);
  const metadata = receipts.filter((row) => row.schema.unsupportedPayloadEvents === 1);
  assert.equal(metadata.length, 3);
  assert.equal(metadata.filter((row) => row.failed === false).length, 1);
  assert.equal(metadata.filter((row) => row.tdhMetadata !== null).length, 2);
  const originalFailure = metadata.find((row) => row.originalTestsExitCode === 1);
  assert.equal(originalFailure.failed, true);
  assert.equal(originalFailure.originalTestsPassed, false);
  assert.equal(originalFailure.cleanupVerified, true);
  assert.equal(originalFailure.tdhMetadata.sampledMetadataOnly, true);
});
test('independent schema profile retains exactly one 32MiB memory collector and actual proved FilterIO keywords', () => {
  const profile = fs.readFileSync(
    path.join(__dirname, '../scripts/fixtures/persistent-io-schema.wprp'),
    'utf8'
  );
  assert.equal((profile.match(/<SystemCollector /g) || []).length, 1);
  assert.match(profile, /BufferSize Value="64"/);
  assert.match(profile, /Buffers Value="512"/);
  assert.match(profile, /LoggingMode="Memory"/);
  for (const name of [
    'FileIO',
    'FileIOInit',
    'Filename',
    'FilterIO',
    'FilterIOInit',
    'FilterIOFastIO',
    'FilterIOFailure',
  ])
    assert.ok(profile.includes(`Value="${name}"`));
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/windows-persistent-io-coverage.yml'),
    'utf8'
  );
  const job = workflow.slice(
    workflow.indexOf('  minifilter-schema-discovery:'),
    workflow.indexOf('  coverage-file-flush:')
  );
  assert.doesNotMatch(job, /needs:|upload-artifact|continue-on-error/);
  assert.match(job, /capture-persistent-io-schema\.ps1/);
  assert.ok(
    job.indexOf('capture-persistent-io-schema.ps1 --preflight') < job.indexOf('- run: npm ci')
  );
  assert.ok(job.includes('capture-persistent-io-schema.ps1 --preflight'));
  const recording = fs.readFileSync(
    path.join(__dirname, '../scripts/lib/persistent-io-schema-recording.psm1'),
    'utf8'
  );
  const launcher = fs.readFileSync(
    path.join(__dirname, '../scripts/lib/persistent-io-schema-tests.cjs'),
    'utf8'
  );
  for (const name of [
    'client-context-target',
    'context-recovery-codex-summary',
    'context-recovery-publication-interruption',
  ])
    assert.ok(launcher.includes(name));
  assert.doesNotMatch(recording, /test-name-pattern|ConvertFrom-HpmFileIoBinary/);
  assert.match(recording, /\$state\.named -eq 0 -and \$state\.unsupported -gt 0/);
  assert.match(recording, /\$receipt\.tdhMetadata=Invoke-HpmSchemaTdhMetadata/);
});

test('actual host uses real physical path validation and bounded git identity before any recording', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'fixtures/persistent-io-schema/host.ps1'),
      path.resolve(__dirname, '..'),
      process.execPath,
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 8192 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const rows = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      assert.ok(line.startsWith('HPM_IO_SCHEMA_PREFLIGHT='));
      return JSON.parse(line.slice('HPM_IO_SCHEMA_PREFLIGHT='.length));
    });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].passed, true);
  assert.equal(rows[0].hostCause, 'complete');
  assert.equal(rows[0].hostToolWitness.wprHardLink, true);
  const receipt = rows[1];
  assert.equal(receipt.passed, true);
  assert.equal(receipt.hostCause, 'complete');
  assert.equal(receipt.recordingStarted, false);
  assert.doesNotMatch(result.stdout, /hpm-schema-host|node\.bin|mock binary/);
});
