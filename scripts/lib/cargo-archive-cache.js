'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const failure = () => new Error('cargo_archive_cache_rejected');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

// This deliberately accepts the generated Cargo.lock subset used by our two
// crates.io-only projects. Other registries, git sources and escaped identifiers
// fail closed; Cargo still independently applies --locked and its own parser.
function parseCargoRegistryArchives(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 4 * 1024 * 1024) throw failure();
  const sections = input.split(/^\[\[package\]\]\r?$/m);
  if (
    sections.length < 2 ||
    sections.length > 4097 ||
    (sections[0].match(/^version\s*=/gm) ?? []).length !== 1 ||
    !/^version = [34]\r?$/m.test(sections[0])
  )
    throw failure();
  const entries = new Map();
  function field(section, name, optional = false) {
    const assignments = section.match(new RegExp('^' + name + '\\s*=', 'gm')) ?? [];
    const matches = [
      ...section.matchAll(new RegExp('^' + name + ' = "([^"\\\\\\r\\n]*)"\\r?$', 'gm')),
    ];
    if (optional && assignments.length === 0) return undefined;
    if (assignments.length !== 1 || matches.length !== 1) throw failure();
    return matches[0][1];
  }
  for (const section of sections.slice(1)) {
    const name = field(section, 'name');
    const version = field(section, 'version');
    const source = field(section, 'source', true);
    const checksum = field(section, 'checksum', true);
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      version.length > 128 ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._+-]+)?$/.test(version)
    )
      throw failure();
    if (source === undefined) {
      if (checksum !== undefined) throw failure();
      continue;
    }
    if (
      source !== 'registry+https://github.com/rust-lang/crates.io-index' ||
      !/^[a-f0-9]{64}$/.test(checksum ?? '')
    )
      throw failure();
    const filename = name + '-' + version + '.crate';
    if (entries.has(filename) && entries.get(filename) !== checksum) throw failure();
    entries.set(filename, checksum);
  }
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, sha256]) => ({ filename, sha256 }));
}

function pinDirectory(input) {
  if (
    typeof input !== 'string' ||
    input.length > 4096 ||
    !path.isAbsolute(input) ||
    path.resolve(input) !== input ||
    /[\0\r\n]/.test(input) ||
    /^[\\/]{2}/.test(input)
  )
    throw failure();
  const pins = [];
  let current = input;
  for (;;) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
    pins.push([current, stat]);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return () => {
    for (const [file, before] of pins) {
      const after = fs.lstatSync(file, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || !same(before, after)) throw failure();
    }
  };
}

// Copy only immutable public archives, never expanded sources, credentials or
// hardlinks to another build. Hash the exact bounded descriptor bytes as written.
// A failure leaves an unqualified partial destination for diagnosis; never reuse
// it as a successful cache or silently retry it.
function copyCargoArchiveCache(options) {
  try {
    if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype)
      throw failure();
    const slots = Object.getOwnPropertyDescriptors(options);
    if (
      Reflect.ownKeys(slots).sort().join(',') !== 'destination,locks,source' ||
      Object.values(slots).some((slot) => !Object.hasOwn(slot, 'value'))
    )
      throw failure();
    const { source, destination, locks } = options;
    if (
      !Array.isArray(locks) ||
      types.isProxy(locks) ||
      Object.getPrototypeOf(locks) !== Array.prototype ||
      locks.length < 1 ||
      locks.length > 8
    )
      throw failure();
    const lockSlots = Object.getOwnPropertyDescriptors(locks);
    if (Reflect.ownKeys(lockSlots).length !== locks.length + 1) throw failure();
    for (let index = 0; index < locks.length; index++)
      if (!lockSlots[index] || !Object.hasOwn(lockSlots[index], 'value')) throw failure();
    const entries = new Map();
    for (let index = 0; index < locks.length; index++)
      for (const entry of parseCargoRegistryArchives(lockSlots[index].value)) {
        if (entries.has(entry.filename) && entries.get(entry.filename) !== entry.sha256)
          throw failure();
        entries.set(entry.filename, entry.sha256);
      }
    if (entries.size > 4096) throw failure();
    if (
      typeof destination !== 'string' ||
      destination.length > 4096 ||
      /[\0\r\n]/.test(destination) ||
      /^[\\/]{2}/.test(destination) ||
      path.basename(destination) === '.' ||
      path.resolve(destination) !== destination ||
      destination === path.parse(destination).root
    )
      throw failure();
    const verifySource = pinDirectory(source);
    const verifyParent = pinDirectory(path.dirname(destination));
    if (
      destination === source ||
      destination.startsWith(source + path.sep) ||
      source.startsWith(destination + path.sep)
    )
      throw failure();
    // String comparison alone misses case aliases on Windows/APFS. Refuse a
    // destination anywhere inside the source's physical directory identity.
    const sourceIdentity = fs.lstatSync(source, { bigint: true });
    for (let parent = path.dirname(destination); ; parent = path.dirname(parent)) {
      if (same(sourceIdentity, fs.lstatSync(parent, { bigint: true }))) throw failure();
      if (parent === path.dirname(parent)) break;
    }
    fs.mkdirSync(destination);
    const verifyDestination = pinDirectory(destination);
    let totalBytes = 0,
      copiedArchives = 0,
      missingArchives = 0;
    for (const [filename, expected] of entries) {
      verifySource();
      verifyParent();
      verifyDestination();
      const from = path.join(source, filename),
        to = path.join(destination, filename);
      let before;
      try {
        before = fs.lstatSync(from, { bigint: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // A Windows cache need not contain Linux/macOS-only lock entries.
        // Absence grants no dependency or build qualification: the caller must
        // still run Cargo with its original --offline/--locked build/test gates.
        verifySource();
        verifyParent();
        verifyDestination();
        missingArchives++;
        continue;
      }
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size < 1n ||
        before.size > BigInt(MAX_ARCHIVE_BYTES) ||
        totalBytes + Number(before.size) > MAX_TOTAL_BYTES
      )
        throw failure();
      let input, output;
      try {
        input = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(input, { bigint: true });
        if (!same(before, opened) || opened.nlink !== 1n || opened.size !== before.size)
          throw failure();
        output = fs.openSync(to, 'wx+', 0o600);
        const outputPin = fs.fstatSync(output, { bigint: true });
        const hash = createHash('sha256'),
          buffer = Buffer.alloc(65536);
        let offset = 0;
        while (offset < Number(opened.size)) {
          const count = fs.readSync(
            input,
            buffer,
            0,
            Math.min(buffer.length, Number(opened.size) - offset),
            offset
          );
          if (count < 1) throw failure();
          hash.update(buffer.subarray(0, count));
          let written = 0;
          while (written < count) {
            const size = fs.writeSync(output, buffer, written, count - written, offset + written);
            if (size < 1) throw failure();
            written += size;
          }
          offset += count;
        }
        if (fs.readSync(input, buffer, 0, 1, offset) !== 0 || hash.digest('hex') !== expected)
          throw failure();
        const copiedHash = createHash('sha256');
        let readback = 0;
        while (readback < offset) {
          const count = fs.readSync(
            output,
            buffer,
            0,
            Math.min(buffer.length, offset - readback),
            readback
          );
          if (count < 1) throw failure();
          copiedHash.update(buffer.subarray(0, count));
          readback += count;
        }
        if (
          fs.readSync(output, buffer, 0, 1, readback) !== 0 ||
          copiedHash.digest('hex') !== expected
        )
          throw failure();
        const after = fs.lstatSync(from, { bigint: true });
        const copied = fs.lstatSync(to, { bigint: true });
        if (
          !same(opened, after) ||
          !after.isFile() ||
          after.isSymbolicLink() ||
          after.nlink !== 1n ||
          after.size !== opened.size ||
          !same(outputPin, copied) ||
          !copied.isFile() ||
          copied.isSymbolicLink() ||
          copied.nlink !== 1n ||
          copied.size !== opened.size
        )
          throw failure();
        totalBytes += offset;
        copiedArchives++;
      } finally {
        try {
          if (output !== undefined) fs.closeSync(output);
        } finally {
          if (input !== undefined) fs.closeSync(input);
        }
      }
      verifySource();
      verifyParent();
      verifyDestination();
    }
    return {
      archives: copiedArchives,
      lockArchives: entries.size,
      missingArchives,
      bytes: totalBytes,
      expandedSourcesCopied: false,
      credentialsCopied: false,
    };
  } catch {
    throw failure();
  }
}

module.exports = { parseCargoRegistryArchives, copyCargoArchiveCache };
