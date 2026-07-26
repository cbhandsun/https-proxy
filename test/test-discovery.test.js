'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  discoverTestFiles,
  normalizeTestPath,
  selectUnitTestFiles,
} = require('../lib/test-discovery');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-discovery-'));

function write(relativePath) {
  const target = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
}

try {
  write('test/zeta.test.js');
  write('test/frontend/view.test.js');
  write('test/nested/alpha.test.js');
  write('test/nested/helper.js');

  const discovered = discoverTestFiles(tempRoot);
  assert.deepStrictEqual(discovered, [
    'test/frontend/view.test.js',
    'test/nested/alpha.test.js',
    'test/zeta.test.js',
  ]);
  assert.deepStrictEqual(
    selectUnitTestFiles(discovered, {
      excludedFiles: ['test/zeta.test.js'],
      excludedPrefixes: ['test/frontend/'],
    }),
    ['test/nested/alpha.test.js']
  );
  assert.strictEqual(
    normalizeTestPath(path.join('test', 'nested', 'alpha.test.js')),
    'test/nested/alpha.test.js'
  );

  assert.throws(() => discoverTestFiles('', 'test'), /repoRoot/);
  assert.throws(() => discoverTestFiles(tempRoot, ''), /relativeTestDir/);
  assert.throws(() => discoverTestFiles(tempRoot, '..'), /must stay inside/);
  assert.throws(() => discoverTestFiles(tempRoot, 'missing'), /does not exist/);
  assert.throws(() => selectUnitTestFiles(null), /testFiles/);
  assert.throws(() => selectUnitTestFiles(['a', 'a']), /duplicates/);
  assert.throws(
    () => selectUnitTestFiles(discovered, { excludedFiles: ['test/missing.test.js'] }),
    /do not exist/
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('[test-discovery.test] ok');
