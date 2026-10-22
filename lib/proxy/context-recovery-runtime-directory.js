'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storageDirectory } = require('./context-recovery-storage-paths');
const { storageFailure } = require('./context-recovery-storage-contract');

const same = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

// Prepare only the owner-selected application runtime path, before acquiring a
// storage owner. Never follows a junction, recursively creates an unchecked path,
// changes an existing ancestor's permissions, or touches evidence files. The
// storage worker still creates/secures its dedicated leaf and verifies ancestors.
async function prepareRecoveryRuntimeDirectory(input, fileSystem = fs.promises) {
  try {
    const directory = storageDirectory(input);
    const root = path.parse(directory).root;
    const parts = path.relative(root, directory).split(path.sep).filter(Boolean);
    if (parts.length > 128) throw storageFailure();
    const methods = Object.create(null);
    for (const name of ['lstat', 'mkdir']) {
      const slot = Object.getOwnPropertyDescriptor(fileSystem, name);
      if (typeof slot?.value !== 'function') throw storageFailure();
      methods[name] = slot.value.bind(fileSystem);
    }
    const pins = new Map();
    function validate(stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure();
      return stat;
    }
    async function verify() {
      for (const [ancestor, identity] of pins) {
        if (!same(identity, validate(await methods.lstat(ancestor)))) throw storageFailure();
      }
    }
    let current = root;
    pins.set(root, validate(await methods.lstat(root)));
    for (const part of parts) {
      await verify();
      current = path.join(current, part);
      let stat;
      try {
        stat = await methods.lstat(current);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await verify();
        try {
          await methods.mkdir(current, { mode: 0o700 });
        } catch (error) {
          // Another owner may have prepared this runtime directory. Validate
          // the resulting identity/type rather than treating EEXIST as success.
          if (error?.code !== 'EEXIST') throw error;
        }
        stat = await methods.lstat(current);
      }
      pins.set(current, validate(stat));
      await verify();
    }
  } catch {
    // No path, native error or user-controlled content leaves this boundary.
    throw storageFailure();
  }
}

module.exports = { prepareRecoveryRuntimeDirectory };
