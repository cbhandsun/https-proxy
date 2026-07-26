'use strict';

const assert = require('node:assert/strict');
const {
  expectedReleaseTag,
  validateReleaseVersion,
} = require('../../scripts/validate-release-version');

assert.equal(expectedReleaseTag('1.2.3'), 'v1.2.3');
assert.throws(() => expectedReleaseTag(''), /non-empty/);
assert.deepEqual(
  validateReleaseVersion({ tagName: 'v1.2.3', packageVersion: '1.2.3', tauriVersion: '1.2.3' }),
  []
);
assert.deepEqual(
  validateReleaseVersion({ tagName: 'v1.2.4', packageVersion: '1.2.3', tauriVersion: '1.2.2' }),
  ['package and Tauri versions differ: 1.2.3 != 1.2.2', 'release tag must equal v1.2.3, got v1.2.4']
);

console.log('[release-version.test] ok');
