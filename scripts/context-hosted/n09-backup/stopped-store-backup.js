'use strict';

// Runner-only backup of two encrypted files. The caller must have acknowledged
// termination of its entire owned Job before each operation. No native owner,
// DPAPI, registry anchor, directory replacement or product restore API is used.
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { createReadonlyFiles } = require('../n09-snapshot/readonly-files');
const { discardN09PromiseRejection } = require('../n09-ack/contract');

const fail = () => new Error('n09_stopped_store_backup_failed');
const entries = Object.freeze([
  { name: 'checkpoint.sqlite', maximum: 1024 * 1024 },
  { name: '.data-key', maximum: 17000 },
]);
const journals = Object.freeze([
  'checkpoint.sqlite-journal',
  'checkpoint.sqlite-wal',
  'checkpoint.sqlite-shm',
  '.writer.sqlite-journal',
  '.writer.sqlite-wal',
  '.writer.sqlite-shm',
]);
const identity = (stat) => [stat.dev, stat.ino, stat.birthtimeMs].join(':');

function createStoppedStoreBackup(input, assertStopped) {
  let files;
  try {
    if (
      typeof assertStopped !== 'function' ||
      types.isProxy(assertStopped) ||
      types.isAsyncFunction(assertStopped) ||
      types.isGeneratorFunction(assertStopped)
    )
      throw fail();
    files = createReadonlyFiles(input);
  } catch {
    throw fail();
  }
  let captured,
    restored = false,
    closed = false,
    busy = false;
  function close() {
    closed = true;
    for (const entry of captured ?? []) entry.bytes.fill(0);
    captured = undefined;
  }
  function stopped() {
    if (closed) throw fail();
    const acknowledged = assertStopped();
    if (types.isPromise(acknowledged)) discardN09PromiseRejection(acknowledged);
    if (acknowledged !== true) throw fail();
    files.verify();
    for (const name of journals) {
      try {
        fs.lstatSync(path.join(files.directory, name));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw fail();
      }
      throw fail();
    }
  }
  function stat(fd, file, maximum, expected) {
    const held = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (
      !held.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      held.nlink !== 1 ||
      current.nlink !== 1 ||
      held.size < 1 ||
      held.size > maximum ||
      identity(held) !== identity(current) ||
      (expected !== undefined && identity(held) !== expected)
    )
      throw fail();
    return held;
  }
  function read(fd, file, entry) {
    const before = stat(fd, file, entry.maximum, entry.identity);
    const bytes = Buffer.alloc(before.size + 1);
    let returned = false;
    try {
      let count = 0;
      while (count < bytes.length) {
        const next = fs.readSync(fd, bytes, count, bytes.length - count, count);
        if (next === 0) break;
        count += next;
      }
      const after = stat(fd, file, entry.maximum, identity(before));
      if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw fail();
      returned = true;
      return bytes.subarray(0, count);
    } finally {
      if (!returned) bytes.fill(0);
    }
  }
  function withFiles(writing, operation) {
    const opened = [];
    let result,
      failed = false;
    try {
      if (busy || closed) throw fail();
      busy = true;
      stopped();
      for (const entry of entries) {
        const file = path.join(files.directory, entry.name);
        const fd = fs.openSync(
          file,
          (writing ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0)
        );
        const held = { ...entry, file, fd };
        opened.push(held);
        held.identity = identity(stat(fd, file, entry.maximum));
      }
      stopped();
      result = operation(opened);
      stopped();
    } catch {
      failed = true;
    } finally {
      for (const entry of opened) {
        try {
          fs.closeSync(entry.fd);
        } catch {
          failed = true;
        }
      }
      busy = false;
    }
    if (failed) {
      close();
      throw fail();
    }
    return result;
  }
  return Object.freeze({
    capture() {
      if (captured || restored || closed) throw fail();
      return withFiles(false, (opened) => {
        captured = [];
        for (const entry of opened)
          captured.push({ ...entry, bytes: read(entry.fd, entry.file, entry) });
        return Object.freeze({ encryptedFilesCaptured: 2, independentAnchorCaptured: false });
      });
    },
    restore() {
      if (!captured || restored || closed) throw fail();
      return withFiles(true, (opened) => {
        for (let index = 0; index < entries.length; index++) {
          if (opened[index].identity !== captured[index].identity) throw fail();
        }
        // Validate both targets before touching either. A failure during a
        // write leaves the isolated fixture failed; never retry or claim an
        // atomic restore. Preserve inode/ACL and never restore the OS anchor.
        restored = true;
        for (let index = 0; index < entries.length; index++) {
          const target = opened[index],
            source = captured[index];
          let written = 0;
          while (written < source.bytes.length) {
            const count = fs.writeSync(
              target.fd,
              source.bytes,
              written,
              source.bytes.length - written,
              written
            );
            if (!Number.isInteger(count) || count <= 0) throw fail();
            written += count;
          }
          fs.ftruncateSync(target.fd, source.bytes.length);
          fs.fsyncSync(target.fd);
          const restoredBytes = read(target.fd, target.file, target);
          try {
            if (!restoredBytes.equals(source.bytes)) throw fail();
          } finally {
            restoredBytes.fill(0);
          }
        }
        return Object.freeze({ encryptedFilesRestored: 2, independentAnchorRestored: false });
      });
    },
    close,
  });
}

module.exports = { createStoppedStoreBackup };
