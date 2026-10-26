'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createRecoveryAnchorRepository } = require('../lib/proxy/context-recovery-anchor');

test('anchor path boundaries canonicalize complete targets without repeating every prefix resolution', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-anchor-path-'));
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('hpm-anchor-path-'));
    fs.rmSync(root, { recursive: true });
  });
  const directory = path.join(root, 'store');
  const executable = path.join(root, 'native.exe');
  fs.mkdirSync(directory);
  fs.writeFileSync(executable, 'synthetic-executable');
  const original = fs.realpathSync.native;
  const calls = [];
  let repository;
  try {
    fs.realpathSync.native = (...args) => {
      calls.push(args[0]);
      return Reflect.apply(original, fs.realpathSync, args);
    };
    repository = createRecoveryAnchorRepository(
      { directory, dataKey: randomBytes(32).toString('base64') },
      {
        platform: 'win32',
        nativeExecutable: executable,
        environment: { SystemRoot: 'C:\\Windows' },
        execute: () => '{"ok":true,"revision":0,"value":null}',
      }
    );
    assert.equal(repository.read(), null);
    // Constructor, pre-dispatch and post-dispatch each check both targets.
    assert.equal(calls.length, 12);
    assert.ok(calls.every((file) => [directory, executable].includes(file)));
  } finally {
    fs.realpathSync.native = original;
    repository?.close();
  }
});
