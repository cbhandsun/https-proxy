'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A transport-only change previously ran timing but silently omitted both
// physical I/O diagnostics. All three must observe the same source identity.
for (const workflow of [
  'windows-persistent-recovery-timing.yml',
  'windows-persistent-io-diagnostic.yml',
  'windows-persistent-io-coverage.yml',
]) {
  test(`${workflow} observes the actual async owner transport and scheduling inputs`, () => {
    const source = fs
      .readFileSync(path.resolve(__dirname, '../../.github/workflows', workflow), 'utf8')
      .replace(/\r\n/g, '\n');
    const block = source.match(/^ {4}paths:\n((?: {6}- [^\n]+\n)+)/m);
    assert.ok(block, 'the branch-scoped push filter must remain explicit');
    const paths = new Set(
      block[1]
        .trim()
        .split('\n')
        .map((row) => row.trim().slice(2))
    );
    for (const file of [
      'context-recovery-storage-owner.js',
      'context-recovery-anchor.js',
      'context-recovery-anchor-channel.js',
      'context-recovery-anchor-protocol.js',
      'context-recovery-storage-worker.js',
      'context-recovery-storage-serial.js',
      'context-recovery-storage-idle.js',
    ])
      assert.ok(paths.has('lib/proxy/' + file), 'missing production diagnostic trigger: ' + file);
    assert.ok(source.includes('acceptance/context-recovery/**'));
    assert.ok(source.includes('workflow_dispatch:'));
  });
}

for (const workflow of [
  'windows-persistent-io-diagnostic.yml',
  'windows-persistent-io-coverage.yml',
]) {
  test(`${workflow} observes its closed scheduling decoder and regression`, () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows', workflow),
      'utf8'
    );
    for (const file of [
      'scripts/lib/persistent-io-scheduling.js',
      'scripts/lib/persistent-io-scheduling.psm1',
      'test/persistent-io-scheduling.test.js',
    ])
      assert.ok(source.includes('      - ' + file + '\n'), file);
  });
}
