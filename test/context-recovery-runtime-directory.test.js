'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  prepareRecoveryRuntimeDirectory,
} = require('../lib/proxy/context-recovery-runtime-directory');

function safe(error) {
  assert.equal(error.code, 'context_recovery_storage_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
const missing = () => Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOENT' });
function fixture() {
  const root = path.parse(os.tmpdir()).root;
  const directory = path.join(root, 'hpm-test', 'custom', 'runtime');
  let sequence = 1;
  const entry = (kind = 'directory') => ({
    dev: 1,
    ino: sequence++,
    birthtimeMs: sequence,
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'link',
  });
  const entries = new Map([[root, entry()]]);
  const created = [];
  const fileSystem = {
    async lstat(file) {
      const stat = entries.get(file);
      if (!stat) throw missing();
      return stat;
    },
    async mkdir(file, options) {
      assert.deepEqual(options, { mode: 0o700 });
      assert.ok(entries.has(path.dirname(file)));
      entries.set(file, entry());
      created.push(file);
    },
  };
  return { root, directory, entry, entries, created, fileSystem };
}

test('runtime directory prepares missing ancestors individually and leaves existing paths untouched', async () => {
  const f = fixture();
  assert.equal(await prepareRecoveryRuntimeDirectory(f.directory, f.fileSystem), undefined);
  assert.deepEqual(f.created, [
    path.join(f.root, 'hpm-test'),
    path.join(f.root, 'hpm-test', 'custom'),
    f.directory,
  ]);
  const identities = [...f.entries];
  await prepareRecoveryRuntimeDirectory(f.directory, f.fileSystem);
  assert.equal(f.created.length, 3);
  assert.deepEqual([...f.entries], identities);
});

test('invalid, empty, executable, root and excessive-depth paths reject before filesystem access', async () => {
  let accessed = 0;
  const fileSystem = {
    get lstat() {
      accessed++;
      throw new Error('PRIVATE_PATH');
    },
  };
  const values = [
    undefined,
    null,
    '',
    [],
    'relative',
    path.parse(os.tmpdir()).root,
    path.join(path.parse(os.tmpdir()).root, ...Array(129).fill('x')),
    path.join(os.tmpdir(), 'x\nPRIVATE_PATH'),
    'x'.repeat(5000),
    {
      toString() {
        accessed++;
        return os.tmpdir();
      },
    },
  ];
  for (const value of values)
    await assert.rejects(prepareRecoveryRuntimeDirectory(value, fileSystem), safe);
  await assert.rejects(prepareRecoveryRuntimeDirectory(os.tmpdir(), fileSystem), safe);
  assert.equal(accessed, 0);
});

test('junctions, files and changed ancestor identities reject before descendant creation', async () => {
  for (const mode of ['link', 'file', 'replacement', 'disappearance']) {
    const f = fixture();
    const first = path.join(f.root, 'hpm-test');
    if (mode === 'link' || mode === 'file') {
      f.entries.set(first, f.entry(mode));
    } else {
      const mkdir = f.fileSystem.mkdir;
      f.fileSystem.mkdir = async (file, options) => {
        await mkdir(file, options);
        if (mode === 'replacement') f.entries.set(f.root, f.entry());
        else f.entries.delete(f.root);
      };
    }
    await assert.rejects(prepareRecoveryRuntimeDirectory(f.directory, f.fileSystem), safe);
    assert.equal(f.entries.has(path.join(first, 'custom')), false);
    assert.ok(f.created.length <= 1);
  }
});

test('concurrent EEXIST must validate the created directory, and native failures remain safe', async () => {
  for (const mode of ['directory', 'file', 'link', 'missing', 'denied', 'stat-denied']) {
    const f = fixture();
    if (mode === 'stat-denied') {
      f.fileSystem.lstat = async () => {
        throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EACCES' });
      };
    } else {
      f.fileSystem.mkdir = async (file) => {
        if (mode === 'denied') throw new Error('PRIVATE_PATH');
        if (mode !== 'missing') f.entries.set(file, f.entry(mode));
        throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EEXIST' });
      };
    }
    if (mode === 'directory') {
      await prepareRecoveryRuntimeDirectory(f.directory, f.fileSystem);
      assert.ok(f.entries.has(f.directory));
    } else await assert.rejects(prepareRecoveryRuntimeDirectory(f.directory, f.fileSystem), safe);
  }
});

test('actual nested runtime creation preserves files and refuses an actual directory junction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-runtime-directory-'));
  try {
    const directory = path.join(root, 'custom', 'runtime');
    const marker = path.join(root, 'owner.txt');
    fs.writeFileSync(marker, 'owner fixture');
    await Promise.all([
      prepareRecoveryRuntimeDirectory(directory),
      prepareRecoveryRuntimeDirectory(directory),
    ]);
    assert.ok(fs.lstatSync(directory).isDirectory());
    assert.equal(fs.existsSync(path.join(directory, 'context-recovery-v1')), false);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'owner fixture');
    const outside = path.join(root, 'outside');
    const junction = path.join(root, 'junction');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareRecoveryRuntimeDirectory(path.join(junction, 'runtime')), safe);
    assert.equal(fs.existsSync(path.join(outside, 'runtime')), false);
  } finally {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('hpm-runtime-directory-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});
