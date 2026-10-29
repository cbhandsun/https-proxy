'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
const fail = () => new Error('source_manifest_verification_failed');
const MAX_FILES = 16384;
const MAX_FILE_BYTES = 64n * 1024n * 1024n;

function record(value, maximum = MAX_FILES) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) throw fail();
  const entries = [];
  for (const key of keys) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !slot.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    entries.push([key, slot.value]);
  }
  return entries;
}
function inputs(root, files, options) {
  const fields = new Map(record(options, 2));
  if (fields.size !== 2 || !fields.has('expectedCount') || !fields.has('onProgress')) throw fail();
  const count = fields.get('expectedCount'),
    progress = fields.get('onProgress');
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_FILES ||
    typeof progress !== 'function' ||
    types.isProxy(progress)
  )
    throw fail();
  const entries = record(files, count);
  if (entries.length !== count) throw fail();
  const seen = new Set();
  for (const [relative, digest] of entries) {
    if (
      !relative ||
      relative.length > 4096 ||
      /[\\:]/.test(relative) ||
      [...relative].some(
        (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127
      ) ||
      path.posix.isAbsolute(relative) ||
      relative
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        ) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      seen.has(relative.toLowerCase())
    )
      throw fail();
    seen.add(relative.toLowerCase());
  }
  return { root: safePath(root, true), entries, progress };
}
function same(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'nlink'].every(
    (key) => a[key] === b[key]
  );
}
function leaf(stat) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > MAX_FILE_BYTES ||
    stat.size < 0n
  )
    throw fail();
}
async function verifyFile(root, relative, digest) {
  const file = path.join(root, relative);
  const before = await fs.promises.lstat(file, { bigint: true });
  leaf(before);
  const physical = await fs.promises.realpath(file);
  const equal =
    process.platform === 'win32'
      ? physical.toLowerCase() === file.toLowerCase()
      : physical === file;
  if (!equal) throw fail();
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    leaf(opened);
    if (!same(before, opened)) throw fail();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const maximum = Math.min(buffer.length, Number(before.size) - total + 1);
      const { bytesRead } = await handle.read(buffer, 0, maximum, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > maximum) throw fail();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (BigInt(total) > before.size) throw fail();
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      BigInt(total) !== before.size ||
      hash.digest('hex') !== digest ||
      !same(opened, await handle.stat({ bigint: true }))
    )
      throw fail();
  } finally {
    if (handle) await handle.close();
  }
  const after = await fs.promises.lstat(file, { bigint: true });
  leaf(after);
  if (!same(before, after)) throw fail();
  const finalPhysical = await fs.promises.realpath(file);
  if (
    process.platform === 'win32'
      ? finalPhysical.toLowerCase() !== file.toLowerCase()
      : finalPhysical !== file
  )
    throw fail();
}

// File count belongs to the caller's pinned manifest, never a machine-specific
// constant. This verifies exactly those entries; Git/tree membership is a separate
// caller gate. No subprocess, retry, model call or installation claim is made.
async function verifySourceManifest(root, files, options) {
  try {
    const input = inputs(root, files, options);
    const initialRoot = await fs.promises.lstat(input.root, { bigint: true });
    let next = 0,
      completed = 0,
      failed = false;
    async function worker() {
      while (!failed && next < input.entries.length) {
        const [relative, digest] = input.entries[next++];
        try {
          await verifyFile(input.root, relative, digest);
          completed++;
          if (!failed && completed % 256 === 0) {
            const result = input.progress(completed);
            if (types.isPromise(result)) await result;
            else if (result !== undefined) throw fail();
          }
        } catch {
          failed = true;
        }
      }
    }
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => worker()));
    if (
      failed ||
      settled.some((result) => result.status !== 'fulfilled') ||
      completed !== input.entries.length
    )
      throw fail();
    safePath(input.root, true);
    const finalRoot = await fs.promises.lstat(input.root, { bigint: true });
    // Reading files may change directory access times; modification identity must hold.
    if (!same(initialRoot, finalRoot)) throw fail();
    return completed;
  } catch {
    throw fail();
  }
}

module.exports = { verifySourceManifest };
