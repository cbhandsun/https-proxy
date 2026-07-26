'use strict';

const assert = require('assert');
const { validateArtifactManifest } = require('../lib/release/artifact-manifest');

const hash = 'a'.repeat(64);
const files = { 'setup.exe': { bytes: 42, sha256: hash } };
assert.deepStrictEqual(
  validateArtifactManifest([{ file: 'setup.exe', bytes: 42, sha256: hash }], files),
  []
);
assert.ok(validateArtifactManifest([], files)[0].includes('at least one'));
assert.ok(
  validateArtifactManifest([{ file: '../setup.exe', bytes: 42, sha256: hash }], files).some(
    (error) => error.includes('invalid')
  )
);
assert.ok(
  validateArtifactManifest([{ file: 'setup.exe', bytes: 41, sha256: hash }], files).some((error) =>
    error.includes('size mismatch')
  )
);
assert.ok(
  validateArtifactManifest(
    [{ file: 'setup.exe', bytes: 42, sha256: 'bad' }],
    files
  ).some((error) => error.includes('checksum mismatch'))
);

console.log('[release-artifact-manifest.test] ok');
