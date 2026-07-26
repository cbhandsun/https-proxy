'use strict';

const fs = require('fs');
const path = require('path');

const FORBIDDEN_FILE_NAMES = new Set([
  '.env',
  '.mgmt-token',
  '.proxy.lock',
  '.proxy.pid',
  'proxy.config.json',
  'proxy.log',
  'proxy.err.log',
]);

const FORBIDDEN_DIRECTORY_NAMES = new Set(['.certs', '.hpm-runtime', '.claude']);
const PRIVATE_MARKERS = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
];
const MAX_SCANNED_TEXT_BYTES = 1024 * 1024;

function normalizeRelativePath(value) {
  return String(value || '')
    .split(path.sep)
    .join('/');
}

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertSafeReleasePath(repoRoot, candidatePath) {
  const allowedRoot = path.join(path.resolve(repoRoot), 'dist');
  const resolved = path.resolve(candidatePath);
  if (!isPathInside(allowedRoot, resolved)) {
    throw new Error(`Release output must stay inside ${allowedRoot}: ${resolved}`);
  }
  return resolved;
}

function collectReleaseEntries(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];
  const directories = [];
  if (!fs.existsSync(root)) return { files, directories };

  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        files.push({ absolute, relative, symbolicLink: true });
      } else if (entry.isDirectory()) {
        directories.push({ absolute, relative });
        visit(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative, symbolicLink: false });
      }
    }
  }

  visit(root);
  return { files, directories };
}

function findSensitiveReleaseEntries(rootDir) {
  const findings = [];
  const { files, directories } = collectReleaseEntries(rootDir);

  for (const directory of directories) {
    const name = path.basename(directory.absolute).toLowerCase();
    const belongsToDependency = directory.relative.startsWith('node_modules/');
    if (!belongsToDependency && FORBIDDEN_DIRECTORY_NAMES.has(name)) {
      findings.push({ type: 'forbidden-directory', path: directory.relative });
    }
  }

  for (const file of files) {
    const name = path.basename(file.absolute).toLowerCase();
    if (
      file.symbolicLink ||
      FORBIDDEN_FILE_NAMES.has(name) ||
      name.startsWith('.mgmt-token-') ||
      name.endsWith('.log') ||
      name.endsWith('.jsonl') ||
      name.endsWith('.pem') ||
      name.endsWith('.key')
    ) {
      findings.push({
        type: file.symbolicLink ? 'symbolic-link' : 'forbidden-file',
        path: file.relative,
      });
      continue;
    }

    const stat = fs.statSync(file.absolute);
    if (stat.size <= 0 || stat.size > MAX_SCANNED_TEXT_BYTES) continue;
    const extension = path.extname(name);
    if (!['.json', '.txt', '.md', '.yaml', '.yml'].includes(extension)) continue;
    const text = fs.readFileSync(file.absolute, 'utf8');
    if (PRIVATE_MARKERS.some((marker) => text.includes(marker))) {
      findings.push({ type: 'private-key-content', path: file.relative });
    }
  }

  return findings;
}

function requiredReleasePaths(expectedDependencies, options = {}) {
  const required = [
    'openai-proxy.js',
    'lib/proxy/config.js',
    'proxy.bat',
    'proxy.ps1',
    'proxy.config.example.json',
    'package.json',
    'runtime/node/node.exe',
  ];
  if (options.requireExecutable !== false) required.push('https-proxy-manager.exe');
  for (const dependency of Object.keys(expectedDependencies || {})) {
    required.push(`node_modules/${dependency}/package.json`);
  }
  return required;
}

function findUnexpectedReleaseLibraries(rootDir) {
  const libraryRoot = path.join(path.resolve(rootDir), 'lib');
  if (!fs.existsSync(libraryRoot) || !fs.statSync(libraryRoot).isDirectory()) return [];

  return fs
    .readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== 'proxy')
    .map((entry) => normalizeRelativePath(path.join('lib', entry.name)));
}

function validateReleaseDirectory(rootDir, expectedDependencies, options = {}) {
  const root = path.resolve(rootDir);
  const errors = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, errors: [`Release directory does not exist: ${root}`], findings: [] };
  }

  for (const relative of requiredReleasePaths(expectedDependencies, options)) {
    if (!fs.existsSync(path.join(root, ...relative.split('/')))) {
      errors.push(`Missing required release file: ${relative}`);
    }
  }

  const findings = findSensitiveReleaseEntries(root);
  for (const finding of findings) {
    errors.push(`Unsafe release content (${finding.type}): ${finding.path}`);
  }
  for (const relative of findUnexpectedReleaseLibraries(root)) {
    errors.push(`Unexpected development library in release: ${relative}`);
  }

  try {
    const runtimePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const actualDependencies = runtimePackage.dependencies || {};
    for (const [name, version] of Object.entries(expectedDependencies || {})) {
      if (actualDependencies[name] !== version) {
        errors.push(
          `Runtime dependency mismatch for ${name}: expected ${version}, got ${actualDependencies[name] || 'missing'}`
        );
      }
    }
    if (runtimePackage.scripts && Object.keys(runtimePackage.scripts).length > 0) {
      errors.push('Runtime package.json must not contain lifecycle scripts');
    }
  } catch (error) {
    errors.push(`Invalid runtime package.json: ${error.message}`);
  }

  return { ok: errors.length === 0, errors, findings };
}

module.exports = {
  FORBIDDEN_DIRECTORY_NAMES,
  FORBIDDEN_FILE_NAMES,
  assertSafeReleasePath,
  collectReleaseEntries,
  findSensitiveReleaseEntries,
  findUnexpectedReleaseLibraries,
  isPathInside,
  normalizeRelativePath,
  requiredReleasePaths,
  validateReleaseDirectory,
};
