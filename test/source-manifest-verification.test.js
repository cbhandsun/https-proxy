'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifySourceManifest } = require('../scripts/lib/source-manifest-verification');
const failure = { message: 'source_manifest_verification_failed' };
const bytes = Buffer.from('public source 中文');
const digest = createHash('sha256').update(bytes).digest('hex');
function root(t) {
  const value = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'source-manifest-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
const options = (expectedCount, onProgress = () => {}) => ({ expectedCount, onProgress });

test('real files verify hashes and exact counts, while corrupted, missing, linked and non-file entries reject', async (t) => {
  const dir = root(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub/a'), bytes);
  fs.writeFileSync(path.join(dir, 'empty'), '');
  const empty = createHash('sha256').update('').digest('hex');
  assert.equal(await verifySourceManifest(dir, { 'sub/a': digest, empty }, options(2)), 2);
  for (const files of [{ 'sub/a': '0'.repeat(64) }, { missing: digest }, { sub: digest }])
    await assert.rejects(verifySourceManifest(dir, files, options(1)), failure);
  fs.linkSync(path.join(dir, 'sub/a'), path.join(dir, 'hard'));
  await assert.rejects(verifySourceManifest(dir, { hard: digest }, options(1)), failure);
  fs.unlinkSync(path.join(dir, 'hard'));
  fs.symlinkSync(path.join(dir, 'sub/a'), path.join(dir, 'link'));
  await assert.rejects(verifySourceManifest(dir, { link: digest }, options(1)), failure);
  fs.symlinkSync(
    path.join(dir, 'sub'),
    path.join(dir, 'ancestor'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(verifySourceManifest(dir, { 'ancestor/a': digest }, options(1)), failure);
});

test('external records reject omissions, excess, empty, hostile descriptors, portable path aliases and extreme counts before I/O', async (t) => {
  const dir = root(t);
  let touched = 0;
  const accessor = Object.defineProperty({}, 'a', {
    enumerable: true,
    get() {
      touched++;
      return digest;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        return [];
      },
    }
  );
  const bad = [null, [], {}, accessor, proxy, { a: null }, { a: digest, b: digest }];
  for (const value of bad)
    await assert.rejects(verifySourceManifest(dir, value, options(1)), failure);
  for (const name of [
    '../a',
    '/a',
    'a\\b',
    'C:a',
    'a//b',
    './a',
    'a/../b',
    'a\0b',
    'a.',
    'a ',
    'NUL.txt',
    'x/'.repeat(2049),
  ])
    await assert.rejects(verifySourceManifest(dir, { [name]: digest }, options(1)), failure);
  await assert.rejects(verifySourceManifest(dir, { a: digest, A: digest }, options(2)), failure);
  for (const count of [0, -1, NaN, Infinity, 16385])
    await assert.rejects(verifySourceManifest(dir, { a: digest }, options(count)), failure);
  await assert.rejects(
    verifySourceManifest(
      dir,
      { a: digest },
      { expectedCount: 1, onProgress: () => {}, extra: true }
    ),
    failure
  );
  assert.equal(touched, 0);
});

async function parallel(t, mode) {
  const dir = root(t);
  const files = Object.fromEntries(
    Array.from({ length: 2159 }, (_, index) => ['f' + index, digest])
  );
  const realStat = fs.promises.lstat.bind(fs.promises);
  let active = 0,
    maximum = 0,
    opened = 0,
    closed = 0,
    finished = false;
  const stat = {
    dev: 1n,
    ino: 2n,
    size: BigInt(bytes.length),
    mtimeNs: 3n,
    ctimeNs: 4n,
    birthtimeNs: 5n,
    nlink: 1n,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  t.mock.method(fs.promises, 'lstat', async (file, config) =>
    file === dir ? realStat(file, config) : stat
  );
  t.mock.method(fs.promises, 'realpath', async (file) => file);
  t.mock.method(fs.promises, 'open', async (file) => {
    if (mode === 'open-error' && file.endsWith('f0')) throw Error('PRIVATE_OPEN');
    active++;
    opened++;
    maximum = Math.max(maximum, active);
    let offset = 0,
      calls = 0;
    return {
      async stat() {
        calls++;
        return mode === 'identity' && file.endsWith('f0') && calls > 1
          ? { ...stat, ino: 99n }
          : stat;
      },
      async read(buffer, start, size) {
        await new Promise((resolve) => setImmediate(resolve));
        if (
          (mode === 'read-error' && file.endsWith('f0')) ||
          (mode === 'multi-error' && /f[01]$/.test(file))
        )
          throw Error('PRIVATE_PATH');
        const input =
          mode === 'hash' && file.endsWith('f0') ? Buffer.from('changed contents') : bytes;
        const source =
          mode === 'growth' && file.endsWith('f0')
            ? Buffer.concat([input, Buffer.from('x')])
            : input;
        const count = Math.min(size, source.length - offset);
        source.copy(buffer, start, offset, offset + count);
        offset += count;
        return { bytesRead: count };
      },
      async close() {
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        closed++;
        if (mode === 'close' && file.endsWith('f0')) throw Error('PRIVATE_CLEANUP');
      },
    };
  });
  const progress = [];
  const progressCallback =
    mode === 'progress-sync'
      ? () => {
          throw Error('PRIVATE_SYNC');
        }
      : mode === 'progress-return'
        ? () => ({
            get then() {
              throw Error('UNSAFE_THENABLE_READ');
            },
          })
        : async (count) => {
            progress.push(count);
            await new Promise((resolve) => setImmediate(resolve));
            if (mode === 'progress') throw Error('PRIVATE_PROGRESS');
          };
  const promise = verifySourceManifest(dir, files, options(2159, progressCallback)).then(
    (result) => {
      assert.equal(active, 0);
      finished = true;
      return result;
    },
    (error) => {
      assert.equal(active, 0);
      finished = true;
      throw error;
    }
  );
  assert.equal(finished, false);
  if (mode === 'normal') {
    assert.equal(await promise, 2159);
    assert.deepEqual(progress, [256, 512, 768, 1024, 1280, 1536, 1792, 2048]);
  } else await assert.rejects(promise, failure);
  assert.equal(maximum, mode === 'open-error' ? 3 : 4);
  assert.equal(active, 0);
  assert.equal(opened, closed);
  assert.equal(finished, true);
}
for (const mode of [
  'normal',
  'read-error',
  'multi-error',
  'hash',
  'identity',
  'close',
  'progress',
  'progress-sync',
  'progress-return',
  'growth',
  'open-error',
])
  test('four bounded workers settle all owned file handles before ' + mode + ' returns', (t) =>
    parallel(t, mode)
  );

test('source manifest regressions enter the existing automatic unit discovery', () => {
  const { discoverTestFiles } = require('../lib/test-discovery');
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/source-manifest-verification.test.js'
    )
  );
});
