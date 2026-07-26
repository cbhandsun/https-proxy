'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';

function runCargo(args, cwd) {
  const result = spawnSync('cargo', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function packageKeysFromCargoTree(output) {
  const keys = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/([A-Za-z0-9_-]+) v([^\s]+)(?: \(|$)/);
    if (match) keys.add(`${match[1]}@${match[2]}`);
  }
  return keys;
}

function warningEntries(report) {
  if (!report || typeof report !== 'object') return [];
  return Object.entries(report.warnings || {}).flatMap(([kind, entries]) =>
    Array.isArray(entries)
      ? entries
          .filter((entry) => entry && entry.package && entry.package.name && entry.package.version)
          .map((entry) => ({
            kind,
            id: entry.advisory && entry.advisory.id ? entry.advisory.id : 'unknown',
            packageKey: `${entry.package.name}@${entry.package.version}`,
          }))
      : []
  );
}

function relevantWarnings(report, windowsPackages) {
  return warningEntries(report).filter((warning) => windowsPackages.has(warning.packageKey));
}

function blockingWarnings(report, windowsPackages) {
  return relevantWarnings(report, windowsPackages).filter(
    (warning) => warning.kind === 'unsound' || warning.kind === 'yanked'
  );
}

function checkWindowsRustAudit(repoRoot) {
  const manifestPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
  const lockfilePath = path.join(repoRoot, 'src-tauri', 'Cargo.lock');
  const tree = runCargo(
    ['tree', '--manifest-path', manifestPath, '--target', WINDOWS_TARGET, '--prefix', 'none'],
    repoRoot
  );
  if (tree.status !== 0) {
    throw new Error(`cargo tree failed: ${tree.stderr || tree.stdout || `exit ${tree.status}`}`);
  }
  const audit = runCargo(['audit', '--file', lockfilePath, '--json'], repoRoot);
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch (error) {
    throw new Error(`cargo audit did not return JSON: ${error.message}`, { cause: error });
  }
  const vulnerabilities = Array.isArray(report.vulnerabilities && report.vulnerabilities.list)
    ? report.vulnerabilities.list
    : [];
  if (vulnerabilities.length > 0) {
    throw new Error(
      `Windows Rust dependency vulnerabilities: ${vulnerabilities
        .map((entry) => entry.advisory && entry.advisory.id)
        .filter(Boolean)
        .join(', ')}`
    );
  }
  const windowsPackages = packageKeysFromCargoTree(tree.stdout);
  const warnings = blockingWarnings(report, windowsPackages);
  if (warnings.length > 0) {
    throw new Error(
      `Windows Rust dependency warnings: ${warnings
        .map((warning) => `${warning.kind}:${warning.id}:${warning.packageKey}`)
        .join(', ')}`
    );
  }
  return {
    windowsPackages: windowsPackages.size,
    informationalWarnings: relevantWarnings(report, windowsPackages).filter(
      (warning) => !warnings.includes(warning)
    ),
  };
}

if (require.main === module) {
  try {
    const result = checkWindowsRustAudit(path.resolve(__dirname, '..'));
    for (const warning of result.informationalWarnings) {
      console.warn(
        `[windows-rust-audit] informational ${warning.kind}: ${warning.id} (${warning.packageKey})`
      );
    }
    console.log(`[windows-rust-audit] ok: ${result.windowsPackages} target packages`);
  } catch (error) {
    console.error(`[windows-rust-audit] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  WINDOWS_TARGET,
  checkWindowsRustAudit,
  packageKeysFromCargoTree,
  blockingWarnings,
  relevantWarnings,
  warningEntries,
};
