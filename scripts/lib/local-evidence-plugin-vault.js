'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyBundledPlugin } = require('./local-evidence-plugin-bundle');

const MAX_FILES = 16384;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROOTS = new Set([
  '.gitignore',
  '.codex-plugin',
  '.mcp.json',
  'mcp.json',
  'hooks',
  'package.json',
  'package-lock.json',
  'plugin.portable.json',
  'runtime-manifest.json',
  'runtime',
  'server.cjs',
  'node_modules',
  'third-party-notices.json',
]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refuse = () => new Error('local_evidence_vault_refused');
const check = (value) => {
  if (!value) throw refuse();
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function directory(input) {
  check(typeof input === 'string' && input.length > 0 && path.isAbsolute(input));
  const resolved = path.resolve(input);
  check(fs.lstatSync(resolved).isDirectory() && !fs.lstatSync(resolved).isSymbolicLink());
  const real = fs.realpathSync(resolved);
  check(
    process.platform === 'win32' ? real.toLowerCase() === resolved.toLowerCase() : real === resolved
  );
  return real;
}

function readFile(file, remaining) {
  const before = fs.lstatSync(file);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  check(before.size <= MAX_FILE_BYTES && before.size <= remaining);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    check(
      opened.isFile() &&
        opened.nlink === 1 &&
        opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size
    );
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      check(read > 0);
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    check(
      bytes.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs
    );
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function inventory(input) {
  const root = directory(input),
    files = [];
  let bytes = 0,
    nodes = 0;
  function visit(relative, depth) {
    check(depth <= 32 && ++nodes <= MAX_FILES * 2);
    const file = path.join(root, relative),
      stat = fs.lstatSync(file);
    check(!stat.isSymbolicLink());
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        check(
          !/[\\/:]/.test(name) &&
            ![...name].some((character) => character.charCodeAt(0) < 32) &&
            name !== '.' &&
            name !== '..'
        );
        if (!relative) check(ROOTS.has(name));
        visit(relative ? relative + '/' + name : name, depth + 1);
      }
    } else {
      check(files.length < MAX_FILES);
      const content = readFile(file, MAX_BYTES - bytes);
      bytes += content.length;
      files.push({ path: relative, sha256: sha(content), bytes: content.length, content });
    }
  }
  visit('', 0);
  return { files, bytes };
}

function identity(files) {
  const byName = new Map(files.map((entry) => [entry.path, entry]));
  const json = (name) => JSON.parse(byName.get(name)?.content.toString('utf8') || 'null');
  const pkg = json('package.json');
  check(record(pkg) && pkg.name === 'hpm-local-evidence' && typeof pkg.version === 'string');
  check(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,64})?$/.test(pkg.version));
  for (const name of ['.codex-plugin/plugin.json', 'plugin.portable.json', 'package-lock.json']) {
    const value = json(name);
    check(record(value) && value.name === pkg.name && value.version === pkg.version);
  }
  const lock = json('package-lock.json');
  check(lock.packages?.['']?.version === pkg.version);
  const sdk = pkg.dependencies?.['@modelcontextprotocol/sdk'];
  check(typeof sdk === 'string');
  check(lock.packages?.['node_modules/@modelcontextprotocol/sdk']?.version === sdk);
  for (const name of ['server.cjs', '.mcp.json', 'mcp.json', 'hooks/hooks.json'])
    check(byName.has(name));
  const closure = json('runtime-manifest.json');
  if (closure?.schema === 'hpm.context.plugin-bundle') {
    verifyBundledPlugin(files, closure, pkg, lock);
    return pkg.version;
  }
  check(json('node_modules/@modelcontextprotocol/sdk/package.json')?.version === sdk);
  check(
    closure?.schema === 'hpm.context.plugin-closure' &&
      closure.version === 1 &&
      Array.isArray(closure.files) &&
      closure.files.length > 0
  );
  const seen = new Set();
  for (const entry of closure.files) {
    check(
      record(entry) &&
        /^lib\/[A-Za-z0-9_./-]+\.js$/.test(entry.path) &&
        !entry.path.includes('..') &&
        !seen.has(entry.path)
    );
    seen.add(entry.path);
    check(byName.get('runtime/' + entry.path)?.sha256 === entry.sha256);
  }
  check(files.filter((entry) => entry.path.startsWith('runtime/')).length === seen.size);
  return pkg.version;
}

function describe(input) {
  const collected = inventory(input);
  const version = identity(collected.files);
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 'hpm.plugin-vault',
      version: 1,
      packageVersion: version,
      files: collected.files.map(({ path: name, sha256, bytes }) => ({
        path: name,
        sha256,
        bytes,
      })),
    }) + '\n'
  );
  return { ...collected, version, manifest, id: sha(manifest) };
}

function verified(vault, id) {
  check(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));
  const entry = directory(path.join(directory(vault), id));
  const index = readFile(path.join(entry, 'index.json'), 4 * 1024 * 1024);
  check(sha(index) === id);
  const value = describe(path.join(entry, 'package'));
  check(value.id === id && value.manifest.equals(index));
  return { ...value, packageDirectory: path.join(entry, 'package') };
}

function writeFiles(destination, files) {
  for (const entry of files) {
    const file = path.join(destination, entry.path);
    check(file.startsWith(destination + path.sep));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.content, { flag: 'wx', mode: 0o600 });
  }
}

function cleanupStaging(staging, parent) {
  if (!staging) return;
  check(path.dirname(staging) === parent && path.basename(staging).startsWith('.staging-'));
  try {
    fs.rmSync(staging, { recursive: true });
  } catch {
    throw refuse();
  }
}

// The native client owns disposable caches. This independent content-addressed
// store contains package bytes only, never credentials, transcripts or config.
function retainLocalEvidencePlugin(source, vault) {
  let staging;
  let vaultRoot;
  try {
    const packageRoot = directory(source);
    vaultRoot = directory(vault);
    check(
      !vaultRoot.startsWith(packageRoot + path.sep) &&
        !packageRoot.startsWith(vaultRoot + path.sep) &&
        vaultRoot !== packageRoot
    );
    const value = describe(packageRoot);
    const target = path.join(vaultRoot, value.id);
    if (!fs.existsSync(target)) {
      staging = fs.mkdtempSync(path.join(vaultRoot, '.staging-'));
      const destination = path.join(staging, 'package');
      fs.mkdirSync(destination);
      writeFiles(destination, value.files);
      fs.writeFileSync(path.join(staging, 'index.json'), value.manifest, {
        flag: 'wx',
        mode: 0o600,
      });
      check(describe(packageRoot).id === value.id && describe(destination).id === value.id);
      fs.renameSync(staging, target);
      staging = undefined;
    }
    const saved = verified(vaultRoot, value.id);
    return {
      snapshotId: saved.id,
      version: saved.version,
      fileCount: saved.files.length,
      bytes: saved.bytes,
    };
  } catch {
    cleanupStaging(staging, vaultRoot);
    throw refuse();
  }
}

// Restore into a new directory only; the caller owns native installation and
// activation. Every retained byte is checked before any destination is created.
function restoreLocalEvidencePlugin(vault, id, destination) {
  let staging;
  let parent;
  try {
    check(typeof destination === 'string' && path.isAbsolute(destination));
    const resolved = path.resolve(destination);
    parent = directory(path.dirname(resolved));
    const target = path.join(parent, path.basename(resolved));
    check(target !== parent && !fs.existsSync(target));
    const value = verified(vault, id);
    const vaultRoot = directory(vault);
    check(target !== vaultRoot && !target.startsWith(vaultRoot + path.sep));
    staging = fs.mkdtempSync(path.join(parent, '.staging-'));
    writeFiles(staging, value.files);
    check(describe(staging).id === id && !fs.existsSync(target));
    fs.renameSync(staging, target);
    staging = undefined;
    return {
      snapshotId: id,
      version: value.version,
      fileCount: value.files.length,
      bytes: value.bytes,
    };
  } catch {
    cleanupStaging(staging, parent);
    throw refuse();
  }
}

function inspectLocalEvidencePlugin(source) {
  try {
    const value = describe(source);
    return {
      snapshotId: value.id,
      version: value.version,
      fileCount: value.files.length,
      bytes: value.bytes,
    };
  } catch {
    throw refuse();
  }
}

module.exports = {
  retainLocalEvidencePlugin,
  restoreLocalEvidencePlugin,
  inspectLocalEvidencePlugin,
};
