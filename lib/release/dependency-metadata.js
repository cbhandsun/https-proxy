'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertSafeReleasePath, collectReleaseEntries, isPathInside } = require('./governance');

function pruneDependencyMetadata(repoRoot, releaseDirectory) {
  const releaseRoot = assertSafeReleasePath(repoRoot, releaseDirectory);
  const dependencyRoot = path.join(releaseRoot, 'node_modules');
  if (!fs.existsSync(dependencyRoot)) return 0;
  if (
    fs.lstatSync(dependencyRoot).isSymbolicLink() ||
    fs.realpathSync(dependencyRoot).toLowerCase() !== path.resolve(dependencyRoot).toLowerCase() ||
    !isPathInside(fs.realpathSync(repoRoot), fs.realpathSync(dependencyRoot))
  ) {
    throw new Error('Release dependency directory must be inside the repository without symlinks');
  }
  const entries = collectReleaseEntries(dependencyRoot);
  if (entries.files.some((entry) => entry.symbolicLink)) {
    throw new Error('Release dependencies must not contain symbolic links');
  }
  const candidates = entries.directories
    .filter((entry) => ['.github', '.claude'].includes(path.basename(entry.absolute).toLowerCase()))
    .sort((left, right) => right.absolute.length - left.absolute.length);
  for (const entry of candidates) {
    if (
      !isPathInside(dependencyRoot, entry.absolute) ||
      !isPathInside(fs.realpathSync(dependencyRoot), fs.realpathSync(entry.absolute))
    ) {
      throw new Error('Dependency metadata cleanup target is outside the staged dependencies');
    }
    fs.rmSync(entry.absolute, { recursive: true, force: true });
  }
  return candidates.length;
}

module.exports = { pruneDependencyMetadata };
