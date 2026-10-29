'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  coverageIoRecorderFailureDetail: detail,
  SUMMARY_CAUSES,
} = require('../scripts/lib/coverage-io-recorder-failure');
const cli = path.resolve(__dirname, '../scripts/summarize-persistent-io.cjs');

test('summary CLI exposes bounded refusal stages without input, file, pointer or exception text', () => {
  const name = JSON.stringify({
    type: 'name',
    key: '1',
    timeMs: 0,
    name: 'C:/Temp/hpm-wbipc-core-aB012z/context/checkpoint.sqlite',
  });
  const flush = (key, timeMs) => JSON.stringify({ type: 'flush', key, timeMs, name: '1' });
  const end = (key, timeMs) => JSON.stringify({ type: 'end', key, timeMs, name: '0' });
  const cases = [
    ['', 'no-flush'],
    ['PRIVATE', 'record-json'],
    ['{"PRIVATE":true} ', 'record-canonical'],
    ['{"PRIVATE":true}', 'record-observe'],
    ['x'.repeat(8193), 'record-bytes'],
    [Buffer.from([0xff]), 'input-encoding'],
    [Buffer.alloc(16 * 1024 * 1024 + 1, 120), 'input-bytes'],
    [[name, flush('2', 1), flush('2', 2), end('2', 3)].join('\n'), 'collisions'],
  ];
  for (const [input, cause] of cases) {
    const result = spawnSync(process.execPath, [cli], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'persistent_io_summary_failed\npersistent_io_summary_cause=' + cause + '\n'
    );
    assert.doesNotMatch(result.stderr, /PRIVATE|Temp|checkpoint|aB012z|0xff/);
    assert.equal(
      detail(result.stderr + 'persistent_io_diagnostic_failed:phase=decode-summary\n'),
      '; recorder_phase=decode-summary; summary_cause=' + cause
    );
  }
  const good = spawnSync(process.execPath, [cli], {
    input: [name, flush('2', 1), end('2', 3)].join('\n'),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  assert.equal(good.status, 0);
  assert.equal(good.stderr, '');
  assert.equal(JSON.parse(good.stdout).pairedFlushes, 1);
});

test('failure detail accepts only unique complete closed summary controls on the matching phase', () => {
  const phase = 'persistent_io_diagnostic_failed:phase=decode-summary\n';
  assert.equal(detail(phase), '; recorder_phase=decode-summary');
  for (const cause of SUMMARY_CAUSES) {
    const line = 'persistent_io_summary_cause=' + cause + '\n';
    assert.equal(detail(line + phase), '; recorder_phase=decode-summary; summary_cause=' + cause);
    assert.equal(detail(line + line + phase), '');
    assert.equal(detail(line + 'persistent_io_diagnostic_failed:phase=decode-record\n'), '');
  }
  for (const value of ['', 'PRIVATE', 'record-observe trailing', '0', 'record-json\rPRIVATE'])
    assert.equal(detail('persistent_io_summary_cause=' + value + '\n' + phase), '');
  assert.equal(detail(phase + 'persistent_io_summary_cause=record-json'), '');
});
