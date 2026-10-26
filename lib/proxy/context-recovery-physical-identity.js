'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { storageFailure } = require('./context-recovery-storage-contract');

// A complete canonical path already resolves all of its prefixes. Bracket a
// fresh ancestor walk with that complete-path check, then recheck the leaf's
// identity. No path proof is retained across calls or native operations.
function recoveryPhysicalIdentity(input, directory) {
  try {
    if (
      typeof input !== 'string' ||
      input.length > 4096 ||
      !path.isAbsolute(input) ||
      /^[\\/]{2}/.test(input) ||
      /[\0\r\n]/.test(input) ||
      typeof directory !== 'boolean'
    )
      throw storageFailure();
    const target = path.resolve(input);
    if (target === path.parse(target).root) throw storageFailure();
    const leaf = () => {
      const stat = fs.lstatSync(target, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      )
        throw storageFailure();
      return stat;
    };
    const canonical = () => {
      if (path.resolve(fs.realpathSync.native(target)).toLowerCase() !== target.toLowerCase())
        throw storageFailure();
    };
    const identity = leaf();
    canonical();
    for (let current = path.dirname(target); ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure();
      if (current === path.dirname(current)) break;
    }
    canonical();
    const after = leaf();
    if (
      identity.dev !== after.dev ||
      identity.ino !== after.ino ||
      identity.birthtimeNs !== after.birthtimeNs
    )
      throw storageFailure();
    return [identity.dev.toString(), identity.ino.toString(), identity.birthtimeNs.toString()];
  } catch {
    throw storageFailure();
  }
}

module.exports = { recoveryPhysicalIdentity };
