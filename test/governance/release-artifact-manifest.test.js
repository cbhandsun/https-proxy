'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateArtifactManifest } = require('../../lib/release/artifact-manifest');
const {
  collectPortableArchives,
  writePortableArtifactManifest,
} = require('../../scripts/write-portable-artifact-manifest');
const { validateArtifactDirectory } = require('../../scripts/verify-release-artifacts');

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
  validateArtifactManifest([{ file: 'setup.exe', bytes: 42, sha256: 'bad' }], files).some((error) =>
    error.includes('checksum mismatch')
  )
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-portable-manifest-'));
try {
  const portableRoot = path.join(tempRoot, 'dist', 'artifacts', 'portable');
  fs.mkdirSync(path.join(portableRoot, 'directory.zip'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'ignored.txt'), 'ignored');
  fs.writeFileSync(path.join(portableRoot, 'zeta.zip'), 'zeta');
  fs.writeFileSync(path.join(portableRoot, 'alpha.ZIP'), 'alpha');

  assert.deepStrictEqual(
    collectPortableArchives(portableRoot).map((filePath) => path.basename(filePath)),
    ['alpha.ZIP', 'zeta.zip']
  );
  const result = writePortableArtifactManifest(tempRoot);
  assert.deepStrictEqual(
    result.manifest.map((entry) => entry.file),
    ['alpha.ZIP', 'zeta.zip']
  );
  assert.strictEqual(
    validateArtifactDirectory(
      portableRoot,
      (fileName) => fileName.toLowerCase().endsWith('.zip'),
      'Portable',
      true
    ),
    2
  );

  fs.appendFileSync(path.join(portableRoot, 'zeta.zip'), 'tampered');
  assert.throws(
    () =>
      validateArtifactDirectory(
        portableRoot,
        (fileName) => fileName.toLowerCase().endsWith('.zip'),
        'Portable',
        true
      ),
    /size mismatch|checksum mismatch/
  );
  assert.strictEqual(
    validateArtifactDirectory(path.join(tempRoot, 'missing'), () => true, 'Optional', false),
    0
  );
  assert.throws(
    () => validateArtifactDirectory(path.join(tempRoot, 'missing'), () => true, 'Required', true),
    /manifest is missing/
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('[release-artifact-manifest.test] ok');
