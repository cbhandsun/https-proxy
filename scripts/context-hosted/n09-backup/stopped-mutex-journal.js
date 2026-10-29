'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = () => new Error('n09_stopped_store_backup_failed');
const identity = (stat) => [stat.dev, stat.ino, stat.birthtimeMs].join(':');
const powerOfTwo = (value) => value >= 512 && value <= 65536 && (value & (value - 1)) === 0;

// BEGIN EXCLUSIVE on the product's empty ownership database leaves an inert
// rollback header after a forced exit. It has no committed pages to restore.
// Observe that exact form only; never open SQLite, repair, copy or delete it.
function createStoppedMutexWitness(directory) {
  function read(name, empty) {
    const file = path.join(directory, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const before = fs.fstatSync(fd);
      const current = fs.lstatSync(file);
      if (
        !before.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        before.nlink !== 1 ||
        current.nlink !== 1 ||
        identity(before) !== identity(current) ||
        (empty ? before.size !== 0 : !powerOfTwo(before.size)) ||
        path.resolve(fs.realpathSync.native(file)).toLowerCase() !==
          path.resolve(file).toLowerCase()
      )
        throw fail();
      bytes = Buffer.alloc(before.size + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd);
      const named = fs.lstatSync(file);
      if (
        count !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.nlink !== 1 ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        identity(named) !== identity(before)
      )
        throw fail();
      const contents = bytes.subarray(0, count);
      if (
        !empty &&
        (!contents.subarray(0, 12).every((byte) => byte === 0) ||
          contents.readUInt32BE(16) !== 0 ||
          contents.readUInt32BE(20) !== count ||
          !powerOfTwo(contents.readUInt32BE(24)) ||
          !contents.subarray(28).every((byte) => byte === 0))
      )
        throw fail();
      return [
        identity(before),
        before.mtimeMs,
        createHash('sha256').update(contents).digest('hex'),
      ].join(':');
    } finally {
      bytes?.fill(0);
      fs.closeSync(fd);
    }
  }
  function snapshot() {
    try {
      fs.lstatSync(path.join(directory, '.writer.sqlite-journal'));
    } catch (error) {
      if (error?.code === 'ENOENT') return 'absent';
      throw fail();
    }
    return read('.writer.sqlite', true) + ':' + read('.writer.sqlite-journal', false);
  }
  const original = snapshot();
  return () => {
    if (snapshot() !== original) throw fail();
  };
}

module.exports = { createStoppedMutexWitness };
