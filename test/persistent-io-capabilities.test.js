'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('actual PowerShell read-only capability composition admits only discovered IDs and rejects command or schema failures', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'fixtures/persistent-io-capabilities/probe.ps1'),
      path.resolve(__dirname, '..'),
      process.execPath,
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 32768 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const { cases, processCases } = JSON.parse(result.stdout);
  assert.equal(cases.length, 15);
  for (const row of cases) {
    assert.equal(row.leaseClosed, !['missing', 'nonadmin'].includes(row.mode), row.mode);
    if (['success', 'missing', 'nonadmin', 'absent', 'no-keywords'].includes(row.mode)) {
      assert.equal(row.failure, null, row.mode);
      assert.equal(row.receipt.recordingStarted, false);
      assert.equal(row.receipt.metadataHashEncoding, 'utf8_decoded_text');
      assert.equal(row.receipt.eventSchemaVerified, false);
      assert.equal(row.receipt.fiveSecondQualified, false);
      assert.equal(row.receipt.installedQualified, false);
      assert.equal(row.receipt.realProviderQualified, false);
      assert.equal(row.receipt.realModelRequests, 0);
      assert.equal(
        row.receipt.minifilterProfileAvailable,
        ['success', 'no-keywords'].includes(row.mode)
      );
      assert.equal(
        row.calls,
        ['success', 'no-keywords'].includes(row.mode) ? 2 : row.mode === 'absent' ? 1 : 0
      );
      assert.doesNotMatch(
        JSON.stringify(row.receipt),
        /PRIVATE|UNRELATED|mock\.bin|hpm-capability-mock/
      );
    } else {
      assert.equal(row.receipt, null, row.mode);
      assert.equal(row.failure, 'persistent_io_capabilities_failed', row.mode);
    }
  }
  const profile = cases[0].receipt.minifilterProfiles[0];
  assert.equal(profile.id, 'MiniProbe');
  for (const key of [
    'filterIOKeywordPresent',
    'filterIOInitKeywordPresent',
    'filterIOFastIOKeywordPresent',
    'filterIOFailureKeywordPresent',
  ])
    assert.equal(profile[key], true);
  assert.match(profile.detailsSha256, /^[a-f0-9]{64}$/);
  const opaque = cases.find((row) => row.mode === 'no-keywords').receipt;
  assert.equal(opaque.metadataUnknown, true);
  assert.equal(opaque.minifilterProfiles[0].filterIOKeywordPresent, false);
  assert.equal(processCases.length, 18);
  for (const row of processCases) {
    assert.equal(row.cleanupVerified, true, row.mode);
    const success = [
      'success',
      'utf8-max',
      'utf8-bom',
      'utf16-bom',
      'utf16be-bom',
      'dual-max',
    ].includes(row.mode);
    assert.equal(
      row.value,
      success ? (['utf8-max', 'dual-max'].includes(row.mode) ? '<bounded>' : 'safe') : null,
      row.mode
    );
    assert.equal(row.failure, success ? null : 'persistent_io_capabilities_failed', row.mode);
    if (['utf8-max', 'dual-max'].includes(row.mode)) assert.equal(row.valueBytes, 16384);
  }
});

test('capability workflow is independent metadata-only and retains existing original trace profile', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/windows-persistent-io-coverage.yml'),
    'utf8'
  );
  const job = workflow.slice(workflow.indexOf('  wpr-read-only-capabilities:'));
  assert.match(job, /timeout-minutes: 3/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /run: \.\/scripts\/check-persistent-io-capabilities\.ps1/);
  assert.doesNotMatch(job, /needs:|npm|capture-persistent|upload-artifact|continue-on-error/);
  assert.match(workflow, /scripts\/lib\/persistent-io-capabilities\*\.psm1/);
  const profile = fs.readFileSync(
    path.join(__dirname, '../scripts/fixtures/persistent-file-io.wprp'),
    'utf8'
  );
  assert.match(profile, /BufferSize Value="64"/);
  assert.match(profile, /Buffers Value="512"/);
  assert.match(profile, /LoggingMode="Memory"/);
  assert.doesNotMatch(profile, /FilterIO|DiskIO/);
});

test('thin capability entry refuses external arguments before host or WPR access', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, '../scripts/check-persistent-io-capabilities.ps1'),
      'PRIVATE',
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.replaceAll('\r\n', '\n'), 'persistent_io_capabilities_failed\n');
});
