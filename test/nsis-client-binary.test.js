'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { digestInstalledClient } = require('../scripts/lib/nsis-client-binary');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'cli-binary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('native client hashing preserves exact bytes across streaming blocks for both fixed clients', (t) => {
  const root = fixture(t);
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0xa5);
  const expected = createHash('sha256').update(bytes).digest('hex');
  for (const client of ['codex', 'claude']) {
    const file = path.join(root, client + '.exe');
    fs.writeFileSync(file, bytes);
    assert.equal(digestInstalledClient(file, client), expected);
    fs.writeFileSync(file, Buffer.from([0]));
    assert.equal(
      digestInstalledClient(file, client),
      createHash('sha256')
        .update(Buffer.from([0]))
        .digest('hex')
    );
  }
});
test('native hashing rejects empty, missing, wrong kind/name, unknown clients and per-client oversized files', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'codex.exe');
  fs.writeFileSync(file, '');
  for (const [target, client] of [
    [file, 'codex'],
    [root, 'codex'],
    [file, 'claude'],
    [file, 'unknown'],
    [file, null],
    [null, 'codex'],
    [path.join(root, 'missing.exe'), 'codex'],
  ])
    assert.throws(() => digestInstalledClient(target, client), {
      message: 'installed_client_binary_rejected',
    });
  for (const [client, limit] of [
    ['codex', 326875440],
    ['claude', 254858400],
  ]) {
    const target = path.join(root, client + '.exe');
    fs.writeFileSync(target, 'x');
    fs.truncateSync(target, limit + 1);
    assert.throws(() => digestInstalledClient(target, client), {
      message: 'installed_client_binary_rejected',
    });
  }
});
test('native hashing refuses linked files and symlinked parents without exposing paths', (t) => {
  const root = fixture(t);
  const original = path.join(root, 'source');
  const binary = path.join(root, 'codex.exe');
  fs.writeFileSync(original, 'synthetic');
  fs.linkSync(original, binary);
  assert.throws(() => digestInstalledClient(binary, 'codex'), {
    message: 'installed_client_binary_rejected',
  });
  fs.unlinkSync(binary);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(binary, 'synthetic');
  assert.throws(() => digestInstalledClient(path.join(linked, 'codex.exe'), 'codex'), {
    message: 'installed_client_binary_rejected',
  });
});

for (const mode of ['changed-during-read', 'unexpected-eof', 'read-failed'])
  test('native hashing fails closed on ' + mode + ' and closes its descriptor', (t) => {
    const root = fixture(t);
    const binary = path.join(root, 'codex.exe');
    fs.writeFileSync(binary, 'synthetic');
    const read = fs.readSync;
    let descriptor;
    t.mock.method(fs, 'readSync', (...args) => {
      descriptor = args[0];
      if (mode === 'read-failed') throw Error('private-path-or-content');
      if (mode === 'unexpected-eof') return 0;
      const count = read(...args);
      fs.appendFileSync(binary, 'changed');
      return count;
    });
    assert.throws(() => digestInstalledClient(binary, 'codex'), {
      message: 'installed_client_binary_rejected',
    });
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  });
