'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveReleaseLayout } = require('../lib/release/layout');

const CLEAN_MODE_FLAGS = [
  'artifactsOnly',
  'cargoOnly',
  'coverageOnly',
  'frontendOnly',
  'stagingOnly',
];

function resolveCleanCandidates(repoRoot, options = {}) {
  const layout = resolveReleaseLayout(repoRoot);
  const tauriRoot = path.join(repoRoot, 'src-tauri');
  const selectedModes = CLEAN_MODE_FLAGS.filter((name) => options[name]);
  if (selectedModes.length > 1) {
    throw new Error(`Clean modes cannot be combined: ${selectedModes.join(', ')}`);
  }
  if (options.frontendOnly) {
    return [path.join(repoRoot, 'tauri-ui', 'dist'), path.join(repoRoot, 'dist', 'tauri-ui')];
  }
  if (options.stagingOnly) return [layout.stagingRoot];
  if (options.artifactsOnly) return [layout.artifactsRoot];
  if (options.coverageOnly) return [path.join(repoRoot, 'coverage')];

  const candidates = options.cargoOnly
    ? []
    : [layout.stagingRoot, layout.artifactsRoot, path.join(repoRoot, 'tauri-ui', 'dist')];

  if (fs.existsSync(tauriRoot)) {
    for (const entry of fs.readdirSync(tauriRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name.startsWith('target-'))) {
        candidates.push(path.join(tauriRoot, entry.name));
      }
    }
  }

  const nestedTauriRoot = path.join(tauriRoot, 'src-tauri');
  if (fs.existsSync(nestedTauriRoot)) {
    const containsCargoTarget = fs
      .readdirSync(nestedTauriRoot, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() && (entry.name === 'target' || entry.name.startsWith('target-'))
      );
    if (containsCargoTarget) candidates.push(nestedTauriRoot);
  }

  return candidates;
}

function assertCleanCandidate(repoRoot, candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(repoRoot, resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to clean path outside workspace: ${resolved}`);
  }
  return { relative, resolved };
}

function cleanGeneratedArtifacts(repoRoot, options = {}) {
  const failures = [];
  for (const candidate of resolveCleanCandidates(repoRoot, options)) {
    const { relative, resolved } = assertCleanCandidate(repoRoot, candidate);
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      console.log(`[release-clean] removed ${relative}`);
    } catch (error) {
      failures.push({ relative, error });
      console.error(`[release-clean] unable to remove ${relative}: ${error.code || error.message}`);
    }
  }
  return failures;
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const failures = cleanGeneratedArtifacts(repoRoot, {
    cargoOnly: process.argv.includes('--cargo-only'),
    frontendOnly: process.argv.includes('--frontend-only'),
    stagingOnly: process.argv.includes('--staging-only'),
    artifactsOnly: process.argv.includes('--artifacts-only'),
    coverageOnly: process.argv.includes('--coverage-only'),
  });
  if (failures.length > 0) {
    console.error(
      `[release-clean] ${failures.length} path(s) remain, usually because a built executable is running`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  assertCleanCandidate,
  cleanGeneratedArtifacts,
  resolveCleanCandidates,
};
