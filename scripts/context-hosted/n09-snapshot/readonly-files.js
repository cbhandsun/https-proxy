'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { createHash } = require('node:crypto');
const failure = () => new Error('n09_readonly_snapshot_unavailable');

function optionsData(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw failure();
  const slots = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(slots).sort().join(',') !== 'ownedRoot,runtimeDir') throw failure();
  const result = {};
  for (const name of ['ownedRoot', 'runtimeDir']) {
    const slot = slots[name];
    if (
      !slot.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'string' ||
      slot.value.length > 4096 ||
      /[\0\r\n]/.test(slot.value) ||
      /^[\\/]{2}/.test(slot.value) ||
      (process.platform === 'win32' && slot.value.slice(2).includes(':')) ||
      !path.isAbsolute(slot.value)
    )
      throw failure();
    result[name] = path.resolve(slot.value);
    if (result[name] === path.parse(result[name]).root) throw failure();
  }
  const relative = path.relative(result.ownedRoot, result.runtimeDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure();
  return result;
}
function identity(stat) {
  if ([stat.dev, stat.ino, stat.birthtimeNs].some((value) => typeof value !== 'bigint'))
    throw failure();
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':');
}
function createReadonlyFiles(input) {
  const options = optionsData(input);
  const directory = path.join(options.runtimeDir, 'context-recovery-v1');
  const pins = new Map();
  let keyDigest;
  function pin(file, directoryOnly = false, maximum = 1024 * 1024 * 1024) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (directoryOnly
        ? !stat.isDirectory()
        : !stat.isFile() ||
          stat.nlink !== 1n ||
          typeof stat.size !== 'bigint' ||
          stat.size < 0n ||
          stat.size > BigInt(maximum))
    )
      throw failure();
    if (
      path.resolve(fs.realpathSync.native(file)).toLowerCase() !== path.resolve(file).toLowerCase()
    )
      throw failure();
    const previous = pins.get(file);
    if (previous !== undefined && previous !== identity(stat)) throw failure();
    pins.set(file, identity(stat));
    return stat;
  }
  function ancestors() {
    let current = directory;
    while (true) {
      pin(current, true);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  function verify() {
    ancestors();
    pin(path.join(directory, 'checkpoint.sqlite'));
    pin(path.join(directory, '.data-key'), false, 17000);
  }
  function readKey() {
    verify();
    const file = path.join(directory, '.data-key');
    const before = pin(file, false, 17000);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const held = fs.fstatSync(fd, { bigint: true });
      if (identity(held) !== identity(before) || held.size !== before.size || held.nlink !== 1n)
        throw failure();
      // Conversion is safe only after pin() has checked the unchanged key cap.
      const size = Number(before.size);
      bytes = Buffer.alloc(size + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count !== size) throw failure();
      const digest = createHash('sha256').update(bytes.subarray(0, count)).digest('hex');
      if (keyDigest !== undefined && keyDigest !== digest) throw failure();
      keyDigest = digest;
      verify();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } finally {
      bytes?.fill(0);
      fs.closeSync(fd);
    }
  }
  return Object.freeze({
    directory,
    databaseFile: path.join(directory, 'checkpoint.sqlite'),
    verify,
    readKey,
  });
}
module.exports = { optionsData, createReadonlyFiles, failure };
