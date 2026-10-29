'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  parseCargoRegistryArchives,
  copyCargoArchiveCache,
} = require('../scripts/lib/cargo-archive-cache');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lock = (checksum, name = 'synthetic', version = '1.2.3') =>
  'version = 4\n\n[[package]]\nname = "' +
  name +
  '"\nversion = "' +
  version +
  '"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' +
  checksum +
  '"\n';
const rejected = (error) => {
  assert.equal(error.message, 'cargo_archive_cache_rejected');
  assert.equal(error.cause, undefined);
  return true;
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-cargo-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  const bytes = Buffer.alloc(70001, 123),
    archive = path.join(source, 'synthetic-1.2.3.crate');
  fs.writeFileSync(archive, bytes);
  const locks = [lock(hash(bytes))];
  return { root, source, destination, archive, bytes, locks };
}

test('archive plan reads both repository lockfiles without changing their fixed checksums', () => {
  for (const [file, count] of [
    ['src-tauri/Cargo.lock', 499],
    ['native/context-recovery-key/Cargo.lock', 12],
  ]) {
    const entries = parseCargoRegistryArchives(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    );
    assert.equal(entries.length, count);
    assert.ok(
      entries.every(
        (entry) =>
          /^[a-zA-Z0-9_.+-]+\.crate$/.test(entry.filename) && /^[a-f0-9]{64}$/.test(entry.sha256)
      )
    );
  }
});

test('generated lock subset supports CRLF, prereleases, duplicate archives and local-only workspaces', () => {
  const checksum = 'a'.repeat(64);
  assert.deepEqual(
    parseCargoRegistryArchives(
      lock(checksum, 'a_b-c', '1.2.3-alpha+build').replaceAll('\n', '\r\n')
    ),
    [{ filename: 'a_b-c-1.2.3-alpha+build.crate', sha256: checksum }]
  );
  assert.equal(
    parseCargoRegistryArchives(
      lock(checksum) + lock(checksum).split('[[package]]')[1].replace(/^/, '[[package]]')
    ).length,
    1
  );
  assert.deepEqual(
    parseCargoRegistryArchives('version = 3\n[[package]]\nname = "workspace"\nversion = "0.1.0"\n'),
    []
  );
});

test('malformed, missing, traversal, unsupported and extreme lock inputs fail closed', () => {
  const good = lock('a'.repeat(64));
  for (const value of [
    undefined,
    null,
    {},
    '',
    'version = 4\n',
    ' '.repeat(4 * 1024 * 1024 + 1),
    good.replace('version = 4', 'version = 5'),
    good.replace('version = 4', 'version = 4\nversion = 3'),
    good.replace('name = "synthetic"', 'name = "../escape"'),
    good.replace('1.2.3', '../../escape'),
    good.replace('crates.io-index', 'OTHER'),
    good.replace('registry+', 'git+'),
    good.replace(/checksum = .*\n/, ''),
    good.replace('a'.repeat(64), 'A'.repeat(64)),
    good.replace('name = "synthetic"', 'name = "synthetic"\nname = "duplicate"'),
    good.replace('source = "registry+', 'source = """registry+'),
    good +
      '[[package]]\nname = "synthetic"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' +
      'b'.repeat(64) +
      '"\n',
  ])
    assert.throws(() => parseCargoRegistryArchives(value), rejected);
});

test('copies only lock-selected public archives, verifies readback and never copies expanded sources or credentials', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'unselected-1.0.0.crate'), 'not selected');
  fs.writeFileSync(path.join(f.source, 'credentials.toml'), 'PRIVATE_SENTINEL');
  fs.mkdirSync(path.join(f.source, 'src'));
  const result = copyCargoArchiveCache({
    source: f.source,
    destination: f.destination,
    locks: [...f.locks, ...f.locks],
  });
  assert.deepEqual(result, {
    archives: 1,
    lockArchives: 1,
    missingArchives: 0,
    bytes: f.bytes.length,
    expandedSourcesCopied: false,
    credentialsCopied: false,
  });
  assert.deepEqual(fs.readdirSync(f.destination), ['synthetic-1.2.3.crate']);
  const to = path.join(f.destination, 'synthetic-1.2.3.crate');
  assert.deepEqual(fs.readFileSync(to), f.bytes);
  assert.equal(fs.statSync(to, { bigint: true }).nlink, 1n);
  assert.notEqual(
    fs.statSync(to, { bigint: true }).ino,
    fs.statSync(f.archive, { bigint: true }).ino
  );
  assert.deepEqual(fs.readFileSync(f.archive), f.bytes);
});

test('a wrong checksum fails and the partial destination never becomes a reusable successful cache', (t) => {
  const f = fixture(t);
  const options = { source: f.source, destination: f.destination, locks: [lock('0'.repeat(64))] };
  assert.throws(() => copyCargoArchiveCache(options), rejected);
  assert.deepEqual(fs.readFileSync(f.archive), f.bytes);
  assert.throws(() => copyCargoArchiveCache({ ...options, locks: f.locks }), rejected);
});

test('a local-only lock creates an empty cache without copying unrelated public files', (t) => {
  const f = fixture(t);
  const locks = ['version = 4\n[[package]]\nname = "workspace"\nversion = "0.1.0"\n'];
  assert.equal(
    copyCargoArchiveCache({ source: f.source, destination: f.destination, locks }).archives,
    0
  );
  assert.deepEqual(fs.readdirSync(f.destination), []);
});

test('physical aliases of a source parent cannot turn the read-only source into a destination', (t) => {
  const f = fixture(t),
    lstat = fs.lstatSync,
    sourceIdentity = lstat(f.source, { bigint: true });
  const alias = path.join(f.root, 'alias');
  let created = false;
  t.mock.method(fs, 'lstatSync', (file, options) =>
    file === alias ? sourceIdentity : lstat(file, options)
  );
  t.mock.method(fs, 'mkdirSync', () => {
    created = true;
    throw Error('PRIVATE');
  });
  assert.throws(
    () =>
      copyCargoArchiveCache({
        source: f.source,
        destination: path.join(alias, 'nested'),
        locks: f.locks,
      }),
    rejected
  );
  assert.equal(created, false);
});

test('existing destinations and overlapping source roots are refused without changing old data', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.destination);
  fs.writeFileSync(path.join(f.destination, 'keep'), 'keep');
  for (const destination of [f.destination, f.source, path.join(f.source, 'nested')])
    assert.throws(
      () => copyCargoArchiveCache({ source: f.source, destination, locks: f.locks }),
      rejected
    );
  assert.equal(fs.readFileSync(path.join(f.destination, 'keep'), 'utf8'), 'keep');
});

test('invalid destination paths are rejected before creating any filesystem entry', (t) => {
  const f = fixture(t),
    before = fs.readdirSync(f.root);
  for (const destination of [
    f.destination + '\n',
    f.destination + '\r',
    f.destination + '\0',
    'relative',
    path.parse(f.root).root,
  ]) {
    assert.throws(
      () => copyCargoArchiveCache({ source: f.source, destination, locks: f.locks }),
      rejected
    );
    assert.deepEqual(fs.readdirSync(f.root), before);
  }
});

test('untrusted option records and lock arrays cannot execute getters, iterators or proxy traps', (t) => {
  const f = fixture(t);
  let effects = 0;
  const options = { source: f.source, destination: f.destination, locks: f.locks };
  const getter = { ...options };
  Object.defineProperty(getter, 'locks', {
    get() {
      effects++;
      return f.locks;
    },
  });
  const locks = [];
  Object.defineProperty(locks, '0', {
    get() {
      effects++;
      return f.locks[0];
    },
  });
  const iterator = [...f.locks];
  iterator[Symbol.iterator] = () => {
    effects++;
    throw Error('PRIVATE');
  };
  const proxy = new Proxy(options, {
    get() {
      effects++;
      throw Error('PRIVATE');
    },
    ownKeys() {
      effects++;
      throw Error('PRIVATE');
    },
  });
  for (const value of [
    getter,
    proxy,
    { ...options, locks },
    { ...options, locks: iterator },
    { ...options, locks: [] },
    { ...options, locks: Array(9).fill(f.locks[0]) },
    { ...options, extra: true },
  ])
    assert.throws(() => copyCargoArchiveCache(value), rejected);
  assert.equal(effects, 0);
  assert.equal(fs.existsSync(f.destination), false);
});

test('hardlinked, empty and oversized archives are refused; missing cache entries remain explicitly unqualified', (t) => {
  const f = fixture(t);
  fs.linkSync(f.archive, path.join(f.source, 'alias'));
  assert.throws(
    () => copyCargoArchiveCache({ source: f.source, destination: f.destination, locks: f.locks }),
    rejected
  );
  fs.unlinkSync(path.join(f.source, 'alias'));
  const lstat = fs.lstatSync;
  for (const size of [0n, 64n * 1024n * 1024n + 1n]) {
    t.mock.method(fs, 'lstatSync', (file, options) => {
      const stat = lstat(file, options);
      return file === f.archive
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size })
        : stat;
    });
    assert.throws(
      () =>
        copyCargoArchiveCache({
          source: f.source,
          destination: f.destination + String(size),
          locks: f.locks,
        }),
      rejected
    );
    t.mock.restoreAll();
  }
  fs.unlinkSync(f.archive);
  const missing = copyCargoArchiveCache({
    source: f.source,
    destination: f.destination + '-missing',
    locks: f.locks,
  });
  assert.equal(missing.archives, 0);
  assert.equal(missing.missingArchives, 1);
  assert.equal(missing.lockArchives, 1);
  assert.equal(missing.bytes, 0);
});

test('a reparse observation is refused before opening archive data', (t) => {
  const f = fixture(t),
    lstat = fs.lstatSync;
  let opened = false;
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const stat = lstat(file, options);
    return file === f.archive
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          isSymbolicLink: () => true,
        })
      : stat;
  });
  t.mock.method(fs, 'openSync', () => {
    opened = true;
    throw Error('PRIVATE');
  });
  assert.throws(
    () => copyCargoArchiveCache({ source: f.source, destination: f.destination, locks: f.locks }),
    rejected
  );
  assert.equal(opened, false);
});

test('source replacement between observation and open fails without importing replacement authority', (t) => {
  const f = fixture(t),
    open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === f.archive && !replaced) {
      replaced = true;
      fs.renameSync(f.source, f.source + '-prior');
      fs.mkdirSync(f.source);
      fs.writeFileSync(f.archive, f.bytes);
    }
    return open(file, ...args);
  });
  assert.throws(
    () => copyCargoArchiveCache({ source: f.source, destination: f.destination, locks: f.locks }),
    rejected
  );
  assert.equal(fs.readdirSync(f.destination).length, 0);
});

test('readback detects changed destination bytes and failed I/O closes both descriptors', (t) => {
  const f = fixture(t),
    write = fs.writeSync,
    open = fs.openSync,
    close = fs.closeSync;
  const opened = new Set(),
    closed = new Set();
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    opened.add(fd);
    return fd;
  });
  t.mock.method(fs, 'closeSync', (fd) => {
    closed.add(fd);
    return close(fd);
  });
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, count, position) =>
    write(fd, Buffer.alloc(buffer.length), offset, count, position)
  );
  assert.throws(
    () => copyCargoArchiveCache({ source: f.source, destination: f.destination, locks: f.locks }),
    rejected
  );
  assert.deepEqual(closed, opened);
  assert.equal(opened.size, 2);
});

test('write failures expose no underlying exception and close both owned descriptors', (t) => {
  const f = fixture(t),
    open = fs.openSync,
    close = fs.closeSync;
  const opened = new Set(),
    closed = new Set();
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    opened.add(fd);
    return fd;
  });
  t.mock.method(fs, 'closeSync', (fd) => {
    closed.add(fd);
    return close(fd);
  });
  t.mock.method(fs, 'writeSync', () => {
    throw Error('PRIVATE_IO_DETAIL');
  });
  assert.throws(
    () => copyCargoArchiveCache({ source: f.source, destination: f.destination, locks: f.locks }),
    rejected
  );
  assert.deepEqual(closed, opened);
  assert.equal(opened.size, 2);
});
