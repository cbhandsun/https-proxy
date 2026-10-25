'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { discoverTestFiles } = require('../lib/test-discovery');
const manifest = require('../scripts/release-proxy-sources.json');

const root = path.resolve(__dirname, '..');

test('release inventory retains recovery helpers and dynamically loaded Worker resources', () => {
  for (const relative of [
    'lib/proxy/context-recovery-anchor-admission.js',
    'lib/proxy/context-recovery-anchor-contract.js',
    'lib/proxy/context-recovery-anchor-enrollment.js',
    'lib/proxy/context-recovery-anchor-legacy-owner.js',
    'lib/proxy/context-recovery-anchor-wire.js',
    'lib/proxy/context-recovery-anchor.js',
    'lib/proxy/context-recovery-budget-reader.js',
    'lib/proxy/context-recovery-key.js',
    'lib/proxy/context-recovery-key-worker.js',
    'lib/proxy/context-recovery-reauthorization.js',
    'lib/proxy/context-recovery-storage-worker.js',
  ]) {
    assert.equal(manifest.filter((entry) => entry === relative).length, 1, relative);
    assert.equal(fs.lstatSync(path.join(root, relative)).isFile(), true, relative);
  }
});

test('recovery release regression remains in unified test discovery', () => {
  const files = discoverTestFiles(root);
  for (const file of [
    'test/context-recovery-release-inventory.test.js',
    'test/context-recovery-anchor-clock.test.js',
    'test/context-recovery-anchor-wire.test.js',
  ])
    assert.ok(files.includes(file), file);
});
