'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');

const filename = require.resolve('../lib/proxy/context-recovery-storage-paths');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const identity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
};

function fixture(t, native) {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-dir-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const loaded = { exports: {} };
  vm.runInNewContext(
    source,
    {
      module: loaded,
      require(name) {
        return name === './context-recovery-private-path'
          ? {
              secureRecoveryStoragePath(file, kind) {
                calls.push({ file, kind });
              },
              prepareRecoveryStorageDirectory: native,
            }
          : localRequire(name);
      },
      Buffer,
      TextDecoder,
      process,
    },
    { filename }
  );
  return {
    root,
    directory: path.join(root, 'store'),
    calls,
    create: loaded.exports.createStoragePaths,
  };
}

function prepared(directory, dispatch) {
  dispatch();
  const writer = path.join(directory, '.writer.sqlite');
  if (!fs.existsSync(writer)) fs.writeFileSync(writer, '');
  return { directory: identity(directory), writer: identity(writer) };
}

test('the compound writer proof is consumed once and cannot authorize another file', (t) => {
  const value = fixture(t, prepared);
  const events = [];
  const paths = value.create(value.directory, ({ phase }) => events.push(phase));
  assert.deepEqual(events, [
    'directory_writer_prepare_started',
    'directory_writer_prepare_finished',
  ]);
  const writer = paths.prepare('.writer.sqlite');
  assert.equal(value.calls.length, 0);
  assert.equal(writer, path.join(value.directory, '.writer.sqlite'));
  paths.prepare('.writer.sqlite');
  paths.prepare('checkpoint.sqlite');
  paths.writeKey('wrapped fixture');
  assert.deepEqual(
    value.calls.map(({ file }) => path.basename(file)),
    ['.writer.sqlite', 'checkpoint.sqlite', '.data-key']
  );
  paths.verify();
});

test('a replaced writer cannot inherit or renew the consumed native admission', (t) => {
  const value = fixture(t, prepared);
  const paths = value.create(value.directory);
  const writer = path.join(value.directory, '.writer.sqlite');
  fs.renameSync(writer, path.join(value.root, 'original-writer'));
  fs.writeFileSync(writer, 'replacement');
  assert.throws(() => paths.prepare('.writer.sqlite'), {
    code: 'context_recovery_storage_unavailable',
  });
  assert.equal(value.calls.length, 0);
});

test('a failed compound operation retains its residue and never retries the legacy ACL route', (t) => {
  const phases = [];
  const value = fixture(t, (directory, dispatch) => {
    prepared(directory, dispatch);
    throw Error('private fixture error');
  });
  assert.throws(() => value.create(value.directory, ({ phase }) => phases.push(phase)), {
    code: 'context_recovery_storage_unavailable',
    message: 'context_recovery_storage_unavailable',
  });
  assert.deepEqual(phases, ['directory_writer_prepare_started']);
  assert.equal(value.calls.length, 0);
  assert.equal(fs.statSync(path.join(value.directory, '.writer.sqlite')).size, 0);
  assert.equal(fs.existsSync(path.join(value.directory, '.data-key')), false);
  assert.equal(fs.existsSync(path.join(value.directory, 'checkpoint.sqlite')), false);
});

test('both returned identities remain required before any writer capability is adopted', (t) => {
  for (const target of ['directory', 'writer']) {
    const value = fixture(t, (directory, dispatch) => {
      const proof = prepared(directory, dispatch);
      proof[target].ino++;
      return proof;
    });
    const phases = [];
    assert.throws(() => value.create(value.directory, ({ phase }) => phases.push(phase)), {
      code: 'context_recovery_storage_unavailable',
    });
    assert.deepEqual(phases, ['directory_writer_prepare_started']);
    assert.equal(value.calls.length, 0);
  }
});

test('absent compound capability preserves the complete original ACL order', (t) => {
  for (const native of [undefined, () => null]) {
    const value = fixture(t, native);
    const phases = [];
    const paths = value.create(value.directory, ({ phase }) => phases.push(phase));
    assert.deepEqual(phases, ['directory_acl_started', 'directory_acl_finished']);
    assert.deepEqual(
      value.calls.map(({ kind }) => kind),
      ['directory']
    );
    assert.equal(fs.existsSync(path.join(value.directory, '.writer.sqlite')), false);
    paths.prepare('.writer.sqlite');
    assert.deepEqual(
      value.calls.map(({ kind }) => kind),
      ['directory', 'file']
    );
  }
});

test('observer exceptions cannot suppress compound security or grant another admission', (t) => {
  let calls = 0;
  const value = fixture(t, (...args) => {
    calls++;
    return prepared(...args);
  });
  const paths = value.create(value.directory, () => {
    throw Error('private observer');
  });
  paths.prepare('.writer.sqlite');
  assert.equal(calls, 1);
  assert.equal(value.calls.length, 0);
});
