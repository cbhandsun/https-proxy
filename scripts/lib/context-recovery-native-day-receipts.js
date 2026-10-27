'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const fail = () => new Error('native_day_receipts_failed');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const MAX_BYTES = 16 * 1024 * 1024;

// The child owns this fresh journal independently of its supervisor's pipes.
// Callers supply only the native day's existing finite, data-free receipts.
function createNativeDayReceipts(parent) {
  let descriptor, directory, identity;
  const ancestors = new Map();
  let bytes = 0,
    closed = false,
    finished = false,
    rejected = false,
    outputFailed = false;
  function verify() {
    for (const [file, pin] of ancestors) {
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, pin)) throw fail();
    }
    const current = fs.lstatSync(path.join(directory, 'progress.jsonl'), { bigint: true });
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      opened.nlink !== 1n ||
      !same(current, identity) ||
      !same(opened, identity) ||
      current.size !== BigInt(bytes) ||
      opened.size !== BigInt(bytes)
    )
      throw fail();
  }
  function append(event) {
    try {
      if (closed || rejected) throw fail();
      verify();
      const line = JSON.stringify(event) + '\n';
      const buffer = Buffer.from(line);
      if (buffer.length > 65536 || bytes + buffer.length > MAX_BYTES) throw fail();
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
        if (count < 1) throw fail();
        offset += count;
        bytes += count;
      }
      fs.fsyncSync(descriptor);
      verify();
      return line;
    } catch {
      rejected = true;
      throw fail();
    }
  }
  try {
    if (
      typeof parent !== 'string' ||
      parent.length > 4096 ||
      !path.isAbsolute(parent) ||
      /[\0\r\n]/.test(parent) ||
      /^[\\/]{2}/.test(parent) ||
      path.resolve(parent) !== parent ||
      (process.platform === 'win32' && parent.slice(2).includes(':'))
    )
      throw fail();
    let current = path.parse(parent).root;
    for (const part of [
      current,
      ...path.relative(current, parent).split(path.sep).filter(Boolean),
    ]) {
      current = path.isAbsolute(part) ? part : path.join(current, part);
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
      ancestors.set(current, stat);
    }
    directory = fs.mkdtempSync(path.join(parent, 'hpm-native-day-'));
    ancestors.set(directory, fs.lstatSync(directory, { bigint: true }));
    descriptor = fs.openSync(
      path.join(directory, 'progress.jsonl'),
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    identity = fs.fstatSync(descriptor, { bigint: true });
    verify();
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw fail();
  }
  return Object.freeze({
    directory,
    emit(event, write) {
      if (
        finished ||
        typeof write !== 'function' ||
        types.isProxy(write) ||
        types.isAsyncFunction(write) ||
        types.isGeneratorFunction(write)
      )
        throw fail();
      // A broken pipe still rejects the run. Its failure receipt can now be
      // written to the independent journal without invoking that pipe again.
      const line = append(event);
      try {
        if (write(line) !== Buffer.byteLength(line)) throw fail();
      } catch {
        outputFailed = true;
        throw fail();
      }
    },
    finish(exitCode) {
      if (finished || ![0, 1].includes(exitCode) || (outputFailed && exitCode !== 1)) throw fail();
      append({
        event: 'native_day_process_result',
        pid: process.pid,
        exitCode,
        atUtc: new Date().toISOString(),
        actualExitVerified: false,
      });
      finished = true;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        verify();
      } catch {
        throw fail();
      } finally {
        fs.closeSync(descriptor);
      }
    },
  });
}
module.exports = { createNativeDayReceipts };
