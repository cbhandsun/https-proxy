'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createHookFixtureTools } = require('./helpers/hook-fixture-path');
const { discoverTestFiles } = require('../lib/test-discovery');

function fixture(platform = 'win32') {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const key = (file) => (windows ? paths.normalize(file).toLowerCase() : paths.normalize(file));
  const entries = new Map();
  const add = (file, directory = false, physical = file) => {
    entries.set(key(file), { directory, physical });
  };
  const input = windows
    ? {
        platform,
        binDirectory: 'C:\\project\\node_modules\\.bin',
        nodeExecutable: 'C:\\node\\node.exe',
        environment: {
          Path: 'C:\\missing;C:\\git;C:\\unused',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          SystemRoot: 'C:\\Windows',
          RETAINED: 'value',
        },
      }
    : {
        platform,
        binDirectory: '/project/node_modules/.bin',
        nodeExecutable: '/runtime/node',
        environment: { PATH: '/missing:/usr/local/bin:/unused', RETAINED: 'value' },
      };
  const git = windows ? 'C:\\git\\git.exe' : '/usr/local/bin/git';
  for (const directory of [
    input.binDirectory,
    paths.dirname(input.nodeExecutable),
    paths.dirname(git),
  ])
    add(directory, true);
  add(input.nodeExecutable);
  add(git);
  if (windows) {
    add('C:\\Windows', true);
    add('C:\\Windows\\System32', true);
    add('C:\\Windows\\System32\\cmd.exe');
  } else {
    add('/usr/bin', true);
    add('/bin', true, '/usr/bin');
  }
  const lookup = (file) => {
    const entry = entries.get(key(file));
    if (!entry) throw Object.assign(new Error('PRIVATE_PATH_SENTINEL'), { code: 'ENOENT' });
    return entry;
  };
  const io = {
    stat(file) {
      const entry = lookup(file);
      return { isFile: () => !entry.directory, isDirectory: () => entry.directory };
    },
    realpath: (file) => lookup(file).physical,
    executable(file) {
      lookup(file);
    },
  };
  return { input, io, git, add, entries, key, run: () => createHookFixtureTools(input, io) };
}

function refuses(action) {
  assert.throws(action, (error) => {
    assert.equal(error.message, 'Hook fixture toolchain rejected');
    assert.equal(error.cause, undefined);
    assert.equal(error.code, undefined);
    assert.doesNotMatch(error.stack, /PRIVATE_PATH_SENTINEL/);
    return true;
  });
}

test('Windows fixture PATH retains only validated tool directories and the resolved native Git', () => {
  const f = fixture();
  const before = { ...f.input.environment };
  const result = f.run();
  assert.equal(result.gitExecutable, f.git);
  assert.equal(
    result.env.PATH,
    'C:\\project\\node_modules\\.bin;C:\\node;C:\\git;C:\\Windows\\System32;C:\\Windows'
  );
  assert.deepEqual(
    Object.keys(result.env).filter((key) => key.toLowerCase() === 'path'),
    ['PATH']
  );
  assert.equal(result.env.RETAINED, 'value');
  assert.equal(result.env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.deepEqual(f.input.environment, before);
  assert.equal(Object.isFrozen(result), true);
});

test('POSIX fixture PATH supports executable tools and physical /bin deduplication', () => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture(platform);
    assert.equal(f.run().gitExecutable, f.git);
    assert.equal(f.run().env.PATH, '/project/node_modules/.bin:/runtime:/usr/local/bin:/usr/bin');
  }
});

test('quoted inherited Windows directories and case aliases resolve without retaining unrelated PATH entries', () => {
  const f = fixture();
  f.input.environment.Path = '"C:\\git";C:\\GIT;C:\\unused';
  assert.equal(f.run().gitExecutable, f.git);
  f.input.binDirectory = 'C:\\git';
  assert.equal(
    f
      .run()
      .env.PATH.split(';')
      .filter((entry) => entry.toLowerCase() === 'c:\\git').length,
    1
  );
});

test('selected missing directories, files in place of directories and non-executable tools fail closed', () => {
  for (const target of ['binDirectory', 'nodeExecutable']) {
    const f = fixture();
    f.input[target] = 'C:\\missing';
    refuses(f.run);
  }
  for (const removed of [
    'C:\\Windows',
    'C:\\Windows\\System32',
    'C:\\Windows\\System32\\cmd.exe',
  ]) {
    const f = fixture();
    f.entries.delete(f.key(removed));
    refuses(f.run);
  }
  const f = fixture('linux');
  f.add(f.input.binDirectory, false);
  refuses(f.run);
  const denied = fixture('linux');
  denied.io.executable = () => {
    throw new Error('PRIVATE_PATH_SENTINEL');
  };
  refuses(denied.run);
});

test('empty, relative, unsafe, ambiguous and extreme search inputs are rejected safely', () => {
  for (const value of [
    '',
    '.',
    'relative',
    'C:\\git;;C:\\other',
    'C:\\git\nPRIVATE_PATH_SENTINEL',
    '\\\\server\\git',
    'C:\\git\\..\\elsewhere',
    'x'.repeat(32769),
    Array(514).fill('C:\\missing').join(';'),
  ]) {
    const f = fixture();
    f.input.environment.Path = value;
    refuses(f.run);
  }
  for (const value of [
    'relative',
    'C:\\bad;C:\\git',
    'C:\\bad\0PRIVATE_PATH_SENTINEL',
    'C:\\bad:stream',
  ]) {
    const f = fixture();
    f.input.binDirectory = value;
    refuses(f.run);
  }
  for (const value of [
    '',
    '.EXE',
    '.EXE;.CMD;PRIVATE_PATH_SENTINEL',
    Array(34).fill('.EXE').join(';'),
  ]) {
    const f = fixture();
    f.input.environment.PATHEXT = value;
    refuses(f.run);
  }
  const duplicate = fixture();
  duplicate.input.environment.PATH = duplicate.input.environment.Path;
  refuses(duplicate.run);
  const missing = fixture();
  delete missing.input.environment.Path;
  refuses(missing.run);
});

test('Git is required and earlier fixture tool directories cannot shadow the selected executable', () => {
  const absent = fixture();
  absent.entries.delete(absent.key(absent.git));
  refuses(absent.run);
  const shim = fixture();
  shim.add('C:\\missing\\git.cmd');
  refuses(shim.run);
  for (const directory of ['C:\\project\\node_modules\\.bin', 'C:\\node']) {
    const f = fixture();
    f.add(path.win32.join(directory, 'git.exe'));
    refuses(f.run);
  }
});

test('accessors, proxies and native filesystem failures cannot expose untrusted values', () => {
  let calls = 0;
  const getter = fixture();
  Object.defineProperty(getter.input.environment, 'Path', {
    enumerable: true,
    get() {
      calls++;
      throw new Error('PRIVATE_PATH_SENTINEL');
    },
  });
  refuses(getter.run);
  for (const where of ['input', 'environment']) {
    const f = fixture();
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          throw new Error('PRIVATE_PATH_SENTINEL');
        },
      }
    );
    if (where === 'input') refuses(() => createHookFixtureTools(proxy, f.io));
    else {
      f.input.environment = proxy;
      refuses(f.run);
    }
  }
  assert.equal(calls, 0);
  const native = fixture();
  native.io.stat = () => {
    throw Object.assign(new Error('PRIVATE_PATH_SENTINEL'), { code: 'EACCES' });
  };
  refuses(native.run);
});

test('fixture PATH regression file enters unified automatic discovery', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/hook-fixture-path.test.js')
  );
});
