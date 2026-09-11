'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneDependencyMetadata } = require('../../lib/release/dependency-metadata');
const { findSensitiveReleaseEntries } = require('../../lib/release/governance');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-metadata-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hpm-metadata-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const release = path.join(root, 'dist', 'staging', 'runtime');
  const write = (relative, value = 'fixture') => {
    const target = path.join(release, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
    return target;
  };
  return { root, release, write };
}

test('removes nested dependency metadata but preserves runtime and other findings', (t) => {
  const { root, release, write } = fixture(t);
  write('node_modules/pkg/.github/workflow.yml');
  write('node_modules/pkg/.github/nested/.claude/notes.md');
  write('node_modules/@scope/pkg/.CLAUDE/notes.md');
  const code = write('node_modules/pkg/index.js');
  write('node_modules/pkg/.env');
  const sourceMetadata = write('.github/keep.yml');
  assert.equal(pruneDependencyMetadata(root, release), 3);
  assert.equal(fs.readFileSync(code, 'utf8'), 'fixture');
  assert.ok(fs.existsSync(sourceMetadata));
  assert.ok(
    findSensitiveReleaseEntries(release).some((item) => item.path === 'node_modules/pkg/.env')
  );
  assert.equal(pruneDependencyMetadata(root, release), 0);
});

test('empty staging is harmless and paths outside dist are rejected', (t) => {
  const { root, release } = fixture(t);
  assert.equal(pruneDependencyMetadata(root, release), 0);
  for (const candidate of [root, path.dirname(root), path.join(root, 'dist', '..', 'other')]) {
    assert.throws(() => pruneDependencyMetadata(root, candidate), /must stay inside/);
  }
});

test('rejects dependency junctions without touching their targets', (t) => {
  const { root, release, write } = fixture(t);
  const keep = write('outside/keep.txt');
  fs.symlinkSync(
    path.dirname(keep),
    path.join(release, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(() => pruneDependencyMetadata(root, release), /without symlinks/);
  assert.ok(fs.existsSync(keep));
});

test('rejects nested symlinks before deleting metadata', (t) => {
  const { root, release, write } = fixture(t);
  const keep = write('node_modules/pkg/.github/keep.yml');
  fs.symlinkSync(
    path.dirname(keep),
    path.join(release, 'node_modules', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(() => pruneDependencyMetadata(root, release), /symbolic links/);
  assert.ok(fs.existsSync(keep));
});

test('invalid dependency directory fails visibly', (t) => {
  const { root, release, write } = fixture(t);
  write('node_modules');
  assert.throws(() => pruneDependencyMetadata(root, release), /ENOTDIR/);
});

test('rejects a junction in the staging parent instead of deleting source metadata', (t) => {
  const { root, release } = fixture(t);
  const source = path.join(root, 'source');
  const metadata = path.join(source, 'node_modules', 'pkg', '.github');
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'keep.yml'), 'keep');
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.symlinkSync(source, release, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneDependencyMetadata(root, release), /without symlinks/);
  assert.ok(fs.existsSync(path.join(metadata, 'keep.yml')));
});
