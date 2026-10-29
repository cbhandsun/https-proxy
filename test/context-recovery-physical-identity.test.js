'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recoveryPhysicalIdentity } = require('../lib/proxy/context-recovery-physical-identity');
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503 &&
  error.cause === undefined;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-physical-id-'));
  const file = path.join(root, 'native.exe');
  fs.writeFileSync(file, 'synthetic-native');
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('hpm-physical-id-'));
    fs.rmSync(root, { recursive: true });
  });
  return { root, file };
}
function patched({ stat, real }, action) {
  const originalStat = fs.lstatSync;
  const originalReal = fs.realpathSync.native;
  try {
    if (stat) fs.lstatSync = (...args) => stat(originalStat, ...args);
    if (real) fs.realpathSync.native = (...args) => real(originalReal, ...args);
    return action();
  } finally {
    fs.lstatSync = originalStat;
    fs.realpathSync.native = originalReal;
  }
}

test('physical identity checks every ancestor and brackets it with complete canonical paths', (t) => {
  const f = fixture(t),
    stats = [],
    canonical = [];
  const result = patched(
    {
      stat: (original, ...args) => {
        stats.push(args[0]);
        return original(...args);
      },
      real: (original, ...args) => {
        canonical.push(args[0]);
        return original(...args);
      },
    },
    () => recoveryPhysicalIdentity(f.file, false)
  );
  const expected = fs.lstatSync(f.file, { bigint: true });
  assert.deepEqual(result, [expected.dev, expected.ino, expected.birthtimeNs].map(String));
  assert.deepEqual(canonical, [f.file, f.file]);
  assert.equal(stats.filter((file) => file === f.file).length, 2);
  for (let parent = path.dirname(f.file); ; parent = path.dirname(parent)) {
    assert.ok(stats.includes(parent));
    if (parent === path.dirname(parent)) break;
  }
  assert.equal(recoveryPhysicalIdentity(f.root, true).length, 3);
});

test('empty, illegal, extreme and hostile paths fail before filesystem reflection', () => {
  let touched = false;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw Error();
      },
    }
  );
  patched(
    {
      stat() {
        touched = true;
        throw Error();
      },
      real() {
        touched = true;
        throw Error();
      },
    },
    () => {
      for (const input of [
        '',
        null,
        undefined,
        1,
        [],
        {},
        hostile,
        () => {},
        'relative.exe',
        '//server/native.exe',
        '/a\0b',
        '/a\nb',
        '/a\rb',
        '/' + 'x'.repeat(4096),
        path.parse(process.cwd()).root,
      ])
        assert.throws(() => recoveryPhysicalIdentity(input, false), safe);
    }
  );
  assert.equal(touched, false);
});

test('directory mode and leaf types are strict; missing targets remain fixed failures', (t) => {
  const f = fixture(t);
  for (const mode of [undefined, null, 0, 1, 'true', {}, []])
    assert.throws(() => recoveryPhysicalIdentity(f.file, mode), safe);
  assert.throws(() => recoveryPhysicalIdentity(f.file, true), safe);
  assert.throws(() => recoveryPhysicalIdentity(f.root, false), safe);
  assert.throws(() => recoveryPhysicalIdentity(path.join(f.root, 'missing.exe'), false), safe);
});

for (const boundary of [1, 2]) {
  test('canonical alias substitution is rejected at complete-path boundary ' + boundary, (t) => {
    const f = fixture(t);
    let calls = 0;
    patched(
      {
        real: (original, file) =>
          ++calls === boundary ? path.join(f.root, 'other.exe') : original(file),
      },
      () => {
        assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe);
      }
    );
  });
  test('canonical failure stays sanitized at complete-path boundary ' + boundary, (t) => {
    const f = fixture(t);
    let calls = 0;
    patched(
      {
        real: (original, file) => {
          if (++calls === boundary) throw Error('synthetic-private');
          return original(file);
        },
      },
      () => {
        assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe);
      }
    );
  });
  test('leaf stat failure stays sanitized at boundary ' + boundary, (t) => {
    const f = fixture(t);
    let calls = 0;
    patched(
      {
        stat: (original, file, options) => {
          if (file === f.file && ++calls === boundary) throw Error('synthetic-private');
          return original(file, options);
        },
      },
      () => {
        assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe);
      }
    );
  });
  test('leaf reparse observations fail closed at boundary ' + boundary, (t) => {
    const f = fixture(t);
    let calls = 0;
    patched(
      {
        stat: (original, file, options) => {
          const value = original(file, options);
          if (file === f.file && ++calls === boundary) value.isSymbolicLink = () => true;
          return value;
        },
      },
      () => {
        assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe);
      }
    );
  });
}

for (const fault of ['reparse', 'not-directory', 'failure']) {
  test('ancestor observation refuses ' + fault, (t) => {
    const f = fixture(t);
    patched(
      {
        stat: (original, file, options) => {
          if (file !== f.root) return original(file, options);
          if (fault === 'failure') throw Error('synthetic-private');
          const value = original(file, options);
          if (fault === 'reparse') value.isSymbolicLink = () => true;
          else value.isDirectory = () => false;
          return value;
        },
      },
      () => assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe)
    );
  });
}

test('target replacement after final canonicalization cannot inherit the prior identity', (t) => {
  const f = fixture(t);
  let calls = 0;
  patched(
    {
      real: (original, file) => {
        const value = original(file);
        if (++calls === 2) {
          fs.renameSync(f.file, path.join(f.root, 'prior.exe'));
          fs.writeFileSync(f.file, 'replacement');
        }
        return value;
      },
    },
    () => assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe)
  );
});

test('hard links are rejected initially and when introduced during the ancestor walk', (t) => {
  const f = fixture(t),
    link = path.join(f.root, 'linked.exe');
  fs.linkSync(f.file, link);
  assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe);
  fs.unlinkSync(link);
  let linked = false;
  patched(
    {
      stat: (original, file, options) => {
        if (file === f.root && !linked) {
          fs.linkSync(f.file, link);
          linked = true;
        }
        return original(file, options);
      },
    },
    () => assert.throws(() => recoveryPhysicalIdentity(f.file, false), safe)
  );
});

test('Unicode leaves and empty directories retain exact physical identities', (t) => {
  const f = fixture(t),
    unicode = path.join(f.root, 'native-中文🙂.exe'),
    empty = path.join(f.root, 'empty');
  fs.writeFileSync(unicode, 'synthetic-native');
  fs.mkdirSync(empty);
  for (const [target, directory] of [
    [unicode, false],
    [empty, true],
  ]) {
    const stat = fs.lstatSync(target, { bigint: true });
    assert.deepEqual(
      recoveryPhysicalIdentity(target, directory),
      [stat.dev, stat.ino, stat.birthtimeNs].map(String)
    );
  }
});
