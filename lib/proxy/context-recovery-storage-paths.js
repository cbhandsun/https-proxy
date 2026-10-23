'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { secureRecoveryStoragePath } = require('./context-recovery-private-path');
const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const {
  RECOVERY_DATABASE_BYTES,
  RECOVERY_DIRECTORY_BYTES,
} = require('./context-recovery-storage-quota');

const LIMITS = new Map([
  ['.writer.sqlite', 1048576],
  ['.data-key', 17000],
  ['checkpoint.sqlite', RECOVERY_DATABASE_BYTES],
  ['checkpoint.sqlite-journal', RECOVERY_DATABASE_BYTES],
  ['.writer.sqlite-journal', 1048576],
  ['.hpm-secured', 1024],
]);
const same = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function storageDirectory(input) {
  const value = storageData(input, 16384);
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !path.isAbsolute(value) ||
    /[\0\r\n]/.test(value) ||
    /^[\\/]{2}/.test(value) ||
    (process.platform === 'win32' && value.slice(2).includes(':'))
  )
    throw storageFailure();
  const root = path.resolve(value);
  if (root === path.parse(root).root) throw storageFailure();
  return root;
}

// No arbitrary filenames cross this boundary. The containing runtime directory
// must already exist; only the dedicated leaf is created and secured here.
function createStoragePaths(input) {
  const directory = storageDirectory(input);
  const ancestors = new Map(),
    pins = new Map();
  function verifyAncestors() {
    for (const [file, identity] of ancestors) {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, identity))
        throw storageFailure();
    }
  }
  function filePath(name) {
    if (!LIMITS.has(name)) throw storageFailure();
    return path.join(directory, name);
  }
  function statFile(name) {
    const stat = fs.lstatSync(filePath(name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMITS.get(name))
      throw storageFailure();
    return stat;
  }
  // The caller brackets this exact-inode read with ancestor verification.
  // An inventory can reuse its already validated stat; the opened descriptor
  // must still match it, and a fresh pathname stat must match after reading.
  function readPinned(name, before = statFile(name)) {
    const descriptor = fs.openSync(
      filePath(name),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!same(before, opened) || opened.nlink !== 1 || opened.size !== before.size)
        throw storageFailure();
      const bytes = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      if (offset !== opened.size || !same(opened, statFile(name))) throw storageFailure();
      return bytes.subarray(0, offset);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  function read(name) {
    verifyAncestors();
    const bytes = readPinned(name);
    verifyAncestors();
    return bytes;
  }
  function inventory() {
    verifyAncestors();
    const names = fs.readdirSync(directory);
    if (names.length > LIMITS.size) throw storageFailure();
    let bytes = 0;
    const observed = new Map();
    for (const name of names) {
      const stat = statFile(name);
      observed.set(name, stat);
      bytes += stat.size;
    }
    if (bytes > RECOVERY_DIRECTORY_BYTES) throw storageFailure();
    for (const [name, pin] of pins) {
      const stat = observed.get(name);
      if (
        !stat ||
        !same(pin.stat, stat) ||
        (pin.digest && pin.digest !== digest(readPinned(name, stat)))
      )
        throw storageFailure();
    }
    verifyAncestors();
  }
  try {
    const parent = path.dirname(directory);
    let current = path.parse(directory).root;
    for (const part of path.relative(current, parent).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure();
      ancestors.set(current, stat);
    }
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure();
    ancestors.set(directory, stat);
    verifyAncestors();
    inventory();
    secureRecoveryStoragePath(directory, 'directory');
    inventory();
  } catch {
    throw storageFailure();
  }
  return {
    directory,
    verify: inventory,
    read,
    exists(name) {
      verifyAncestors();
      try {
        statFile(name);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw storageFailure();
      }
    },
    pinExisting(name) {
      try {
        inventory();
        const before = statFile(name);
        secureRecoveryStoragePath(filePath(name), 'file');
        if (!same(before, statFile(name))) throw storageFailure();
        pins.set(name, { stat: before });
        inventory();
        return filePath(name);
      } catch {
        throw storageFailure();
      }
    },
    prepare(name) {
      try {
        inventory();
        try {
          const fd = fs.openSync(filePath(name), 'wx', 0o600);
          fs.closeSync(fd);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const before = statFile(name);
        secureRecoveryStoragePath(filePath(name), 'file');
        if (!same(before, statFile(name))) throw storageFailure();
        pins.set(name, { stat: before });
        inventory();
        return filePath(name);
      } catch {
        throw storageFailure();
      }
    },
    writeKey(bytes) {
      try {
        inventory();
        if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 17000) throw storageFailure();
        const fd = fs.openSync(filePath('.data-key'), 'wx', 0o600);
        try {
          secureRecoveryStoragePath(filePath('.data-key'), 'file');
          if (!same(fs.fstatSync(fd), statFile('.data-key'))) throw storageFailure();
          fs.writeFileSync(fd, bytes, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const persisted = read('.data-key');
        if (!persisted.equals(Buffer.from(bytes, 'utf8'))) throw storageFailure();
        pins.set('.data-key', { stat: statFile('.data-key'), digest: digest(persisted) });
        inventory();
        // This exact inode has just been secured, fsynced and read back. Return
        // its verified wrapping so fresh startup need not apply its ACL twice.
        // A new owner still uses pinKey() and secures the existing file anew.
        return new TextDecoder('utf-8', { fatal: true }).decode(persisted);
      } catch {
        throw storageFailure();
      }
    },
    pinKey() {
      try {
        const before = statFile('.data-key');
        secureRecoveryStoragePath(filePath('.data-key'), 'file');
        if (!same(before, statFile('.data-key'))) throw storageFailure();
        const bytes = read('.data-key');
        pins.set('.data-key', { stat: before, digest: digest(bytes) });
        inventory();
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw storageFailure();
      }
    },
  };
}

module.exports = { storageDirectory, createStoragePaths };
