'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hasExplicitPath = (source, file) => source.split(/\r?\n/).includes('      - ' + file);

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
      'context-recovery-storage.js',
      'context-recovery-storage-failure.js',
      'context-recovery-storage-serial.js',
      'context-recovery-storage-idle.js',
    ])
      assert.ok(paths.has('lib/proxy/' + file), 'missing production diagnostic trigger: ' + file);
    // Native and source-only compatibility backends are executed by these
    // exact workloads too. Their changes must not silently omit timing or I/O.
    for (const file of [
      'native/context-recovery-key/**',
      'scripts/prepare-context-recovery-native.js',
      'lib/proxy/context-recovery-key-dpapi.js',
      'lib/proxy/context-recovery-key-contract.js',
    ])
      assert.ok(paths.has(file), 'missing native/key diagnostic trigger: ' + file);
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
      assert.ok(hasExplicitPath(source, file), file);
  });
}

test('explicit workflow trigger matching treats LF and CRLF identically without accepting missing or partial paths', () => {
  const file = 'scripts/lib/persistent-io-scheduling.js';
  for (const newline of ['\n', '\r\n']) {
    assert.equal(hasExplicitPath('    paths:' + newline + '      - ' + file + newline, file), true);
    for (const line of ['      - ' + file + '.old', '      - other.js', '    # - ' + file])
      assert.equal(hasExplicitPath(line + newline, file), false);
  }
});
