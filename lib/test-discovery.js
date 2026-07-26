'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeTestPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`);
  }
}

function discoverTestFiles(repoRoot, relativeTestDir = 'test') {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new TypeError('repoRoot must be a non-empty string');
  }
  if (typeof relativeTestDir !== 'string' || relativeTestDir.trim() === '') {
    throw new TypeError('relativeTestDir must be a non-empty string');
  }
  const root = path.resolve(repoRoot);
  const testRoot = path.resolve(root, relativeTestDir);
  const relativeRoot = path.relative(root, testRoot);
  if (
    relativeRoot === '' ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot)
  ) {
    throw new Error('test directory must stay inside the repository');
  }
  if (!fs.existsSync(testRoot) || !fs.statSync(testRoot).isDirectory()) {
    throw new Error(`test directory does not exist: ${relativeTestDir}`);
  }

  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`test directory must not contain symbolic links: ${fullPath}`);
      }
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        output.push(normalizeTestPath(path.relative(root, fullPath)));
      }
    }
  };
  visit(testRoot);
  return output.sort();
}

function selectUnitTestFiles(testFiles, options = {}) {
  validateStringArray(testFiles, 'testFiles');
  const excludedFiles = options.excludedFiles || [];
  const excludedPrefixes = options.excludedPrefixes || [];
  validateStringArray(excludedFiles, 'excludedFiles');
  validateStringArray(excludedPrefixes, 'excludedPrefixes');

  const uniqueTests = new Set(testFiles);
  if (uniqueTests.size !== testFiles.length) {
    throw new Error('testFiles must not contain duplicates');
  }
  const missingExcludedFiles = excludedFiles.filter((file) => !uniqueTests.has(file));
  if (missingExcludedFiles.length > 0) {
    throw new Error(`excluded test files do not exist: ${missingExcludedFiles.join(', ')}`);
  }

  const excludedFileSet = new Set(excludedFiles);
  return testFiles.filter(
    (file) =>
      !excludedFileSet.has(file) && !excludedPrefixes.some((prefix) => file.startsWith(prefix))
  );
}

module.exports = {
  discoverTestFiles,
  normalizeTestPath,
  selectUnitTestFiles,
};
