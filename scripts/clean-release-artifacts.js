'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const tauriRoot = path.join(repoRoot, 'src-tauri');
const cargoOnly = process.argv.includes('--cargo-only');
const candidates = cargoOnly ? [] : [path.join(repoRoot, 'dist')];

for (const entry of fs.readdirSync(tauriRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && (entry.name === 'target' || entry.name.startsWith('target-'))) {
    candidates.push(path.join(tauriRoot, entry.name));
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

const failures = [];
for (const candidate of candidates) {
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
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    console.log(`[release-clean] removed ${relative}`);
  } catch (error) {
    failures.push({ relative, error });
    console.error(`[release-clean] unable to remove ${relative}: ${error.code || error.message}`);
  }
}

if (failures.length > 0) {
  console.error(
    `[release-clean] ${failures.length} path(s) remain, usually because a built executable is running`
  );
  process.exitCode = 1;
}
