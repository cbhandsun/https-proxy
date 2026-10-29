'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPublicationAckFiles,
  createPublicationObservationFiles,
} = require('../../scripts/context-hosted/n09-business/publication-observation-files');

function fixture(t, ack) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-publication-files-'));
  const epoch = 'a'.repeat(32);
  const directory = path.join(
    root,
    (ack ? 'n09-publication-ack-' : 'n09-publication-') + '17-' + epoch
  );
  const create = ack ? createPublicationAckFiles : createPublicationObservationFiles;
  const files = create({ directory, pid: 17, epoch }, true);
  t.after(() => {
    files.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, files, kind: ack ? 'arm' : 'query' };
}

for (const ack of [false, true]) {
  const name = ack ? 'ACK' : 'observation';
  test(`${name} transport bounds ancestor walks without caching across operations`, (t) => {
    const f = fixture(t, ack);
    const original = fs.lstatSync;
    let walks = 0;
    t.mock.method(fs, 'lstatSync', function (file, ...args) {
      if (file === f.directory) walks++;
      return Reflect.apply(original, fs, [file, ...args]);
    });
    f.files.write(f.kind, 1, '{"value":1}');
    assert.equal(walks, 3, 'before create, complete data path, complete marker path');
    walks = 0;
    assert.deepEqual(f.files.read(f.kind, 1), { value: 1 });
    assert.equal(walks, 3, 'marker, before descriptor read, after descriptor read');
    walks = 0;
    assert.deepEqual(f.files.read(f.kind, 1), { value: 1 });
    assert.equal(walks, 3, 'a later read must perform every physical check again');
  });

  test(`${name} empty polling validates its pinned ancestors once per observation`, (t) => {
    const f = fixture(t, ack);
    const original = fs.lstatSync;
    let walks = 0;
    t.mock.method(fs, 'lstatSync', function (file, ...args) {
      if (file === f.directory) walks++;
      return Reflect.apply(original, fs, [file, ...args]);
    });
    assert.equal(f.files.read(f.kind, 1), null);
    assert.equal(walks, 1);
    assert.equal(f.files.read(f.kind, 1), null);
    assert.equal(walks, 2, 'later missing observations still revalidate the physical directory');
  });

  test(`${name} marker inspection cannot authorize a replaced parent or open its payload`, async (t) => {
    for (const present of [false, true]) {
      await t.test(present ? 'present' : 'missing', (t) => {
        const f = fixture(t, ack);
        if (present) f.files.write(f.kind, 1, '{}');
        const original = fs.lstatSync;
        const marker = path.join(f.directory, f.kind + '-1.json.ready');
        let replaced = false;
        t.mock.method(fs, 'lstatSync', function (file, ...args) {
          if (file !== marker || replaced) return Reflect.apply(original, fs, [file, ...args]);
          let stat, failure;
          try {
            stat = Reflect.apply(original, fs, [file, ...args]);
          } catch (error) {
            failure = error;
          }
          fs.renameSync(f.directory, f.directory + '.old');
          fs.mkdirSync(f.directory);
          replaced = true;
          if (failure) throw failure;
          return stat;
        });
        let opened = 0;
        const open = fs.openSync;
        t.mock.method(fs, 'openSync', function (...args) {
          opened++;
          return Reflect.apply(open, fs, args);
        });
        assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
        assert.equal(replaced, true);
        assert.equal(opened, 0);
        assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
      });
    }
  });

  test(`${name} closed marker inspection does not open the payload`, (t) => {
    const f = fixture(t, ack);
    f.files.write(f.kind, 1, '{}');
    const marker = path.join(f.directory, f.kind + '-1.json.ready');
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', function (file, ...args) {
      const stat = Reflect.apply(original, fs, [file, ...args]);
      if (file === marker) f.files.close();
      return stat;
    });
    let opened = 0;
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', function (...args) {
      opened++;
      return Reflect.apply(open, fs, args);
    });
    assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
    assert.equal(opened, 0);
  });

  test(`${name} replaced write directory is rejected before any wx creation`, (t) => {
    const f = fixture(t, ack);
    fs.renameSync(f.directory, f.directory + '.old');
    fs.mkdirSync(f.directory);
    let opened = 0;
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', function (...args) {
      opened++;
      return Reflect.apply(open, fs, args);
    });
    assert.throws(() => f.files.write(f.kind, 1, '{}'), /n09_publication_files_rejected/);
    assert.equal(opened, 0);
  });

  test(`${name} marker aliases are rejected before opening payload bytes`, async (t) => {
    for (const alias of ['parent', 'symlink', 'hardlink']) {
      await t.test(alias, (t) => {
        const f = fixture(t, ack);
        f.files.write(f.kind, 1, '{}');
        const marker = path.join(f.directory, f.kind + '-1.json.ready');
        if (alias === 'parent') {
          fs.renameSync(f.directory, f.directory + '.old');
          fs.symlinkSync(
            f.directory + '.old',
            f.directory,
            process.platform === 'win32' ? 'junction' : 'dir'
          );
        } else if (alias === 'symlink') {
          fs.renameSync(marker, marker + '.old');
          if (process.platform === 'win32') {
            const target = path.join(f.root, 'marker-target');
            fs.mkdirSync(target);
            fs.symlinkSync(target, marker, 'junction');
          } else fs.symlinkSync(marker + '.old', marker, 'file');
        } else fs.linkSync(marker, marker + '.alias');
        let opened = 0;
        const open = fs.openSync;
        t.mock.method(fs, 'openSync', function (...args) {
          opened++;
          return Reflect.apply(open, fs, args);
        });
        assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
        assert.equal(opened, 0);
      });
    }
  });

  test(`${name} transport rejects replaced ancestors even for a missing marker`, (t) => {
    const f = fixture(t, ack);
    assert.equal(f.files.read(f.kind, 1), null);
    fs.renameSync(f.directory, f.directory + '.old');
    fs.mkdirSync(f.directory);
    assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
    assert.throws(() => f.files.write(f.kind, 1, '{}'), /n09_publication_files_rejected/);
  });

  test(`${name} transport rejects path replacement during the descriptor read`, (t) => {
    const f = fixture(t, ack);
    f.files.write(f.kind, 1, '{"value":1}');
    const original = fs.readSync;
    let changed = false;
    t.mock.method(fs, 'readSync', function (...args) {
      const count = Reflect.apply(original, fs, args);
      if (!changed) {
        changed = true;
        const file = path.join(f.directory, f.kind + '-1.json');
        fs.renameSync(file, file + '.old');
        fs.writeFileSync(file, '{"value":2}');
      }
      return count;
    });
    assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
    assert.equal(changed, true);
    assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
  });

  test(`${name} transport still refuses closure during its final physical boundary`, (t) => {
    const f = fixture(t, ack);
    f.files.write(f.kind, 1, '{}');
    const original = fs.readSync;
    t.mock.method(fs, 'readSync', function (...args) {
      const count = Reflect.apply(original, fs, args);
      f.files.close();
      return count;
    });
    assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
    t.mock.restoreAll();
    const writer = fixture(t, ack);
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', function (file, ...args) {
      const stat = Reflect.apply(lstat, fs, [file, ...args]);
      if (file === path.join(writer.directory, writer.kind + '-1.json.ready')) writer.files.close();
      return stat;
    });
    assert.throws(() => writer.files.write(writer.kind, 1, '{}'), /n09_publication_files_rejected/);
  });

  test(`${name} transport keeps the byte bound, canonical JSON and closed-state refusal`, (t) => {
    const f = fixture(t, ack);
    const value = JSON.stringify({ value: 'x'.repeat(4084) });
    assert.equal(Buffer.byteLength(value), 4096);
    f.files.write(f.kind, 1, value);
    assert.deepEqual(f.files.read(f.kind, 1), JSON.parse(value));
    f.files.close();
    assert.throws(() => f.files.read(f.kind, 1), /n09_publication_files_rejected/);
    assert.throws(() => f.files.write(f.kind, 1, '{}'), /n09_publication_files_rejected/);
    for (const invalid of ['', '{}\n', JSON.stringify({ value: 'x'.repeat(4085) })]) {
      const other = fixture(t, ack);
      assert.throws(
        () => other.files.write(other.kind, 1, invalid),
        /n09_publication_files_rejected/
      );
    }
  });
}
