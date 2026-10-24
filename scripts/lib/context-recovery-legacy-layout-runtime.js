'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { spawnSync } = require('node:child_process');
const { safePath } = require('./nsis-encrypted-contract');
const fail = () => new Error('context_recovery_legacy_layout_failed');

function createOwnedRoot() {
  const temporary = safePath(fs.realpathSync.native(os.tmpdir()), true);
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-legacy-layout-'));
  const store = path.join(root, 'store');
  fs.mkdirSync(store);
  const identity = (directory) => {
    safePath(directory, true);
    const { dev, ino, birthtimeMs } = fs.lstatSync(directory);
    return { dev, ino, birthtimeMs };
  };
  const rootIdentity = identity(root),
    storeIdentity = identity(store);
  for (const name of ['home', 'appdata', 'localappdata', 'tmp'])
    fs.mkdirSync(path.join(root, name));
  return {
    store,
    verify() {
      if (
        !isDeepStrictEqual(identity(root), rootIdentity) ||
        !isDeepStrictEqual(identity(store), storeIdentity)
      )
        throw fail();
    },
    environment() {
      const env = {};
      for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'])
        if (process.env[name]) env[name] = process.env[name];
      for (const [name, relative] of [
        ['HOME', 'home'],
        ['USERPROFILE', 'home'],
        ['APPDATA', 'appdata'],
        ['LOCALAPPDATA', 'localappdata'],
        ['TEMP', 'tmp'],
        ['TMP', 'tmp'],
      ])
        env[name] = path.join(root, relative);
      return env;
    },
  };
}

function executeDriver({ installation, install, operation, owned }, start = spawnSync) {
  try {
    const result = start(
      installation.node,
      [
        path.join(__dirname, 'nsis-installed-recovery-fixture.cjs'),
        operation,
        install,
        owned.store,
        installation.manifestSha256,
      ],
      {
        cwd: install,
        env: owned.environment(),
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 8192,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (
      result.error ||
      result.status !== 0 ||
      result.signal !== null ||
      typeof result.stdout !== 'string' ||
      Buffer.byteLength(result.stdout) > 4096
    )
      throw fail();
    // Native/SQLite stderr is deliberately discarded, including on failure.
    const reply = JSON.parse(result.stdout);
    if (result.stdout !== JSON.stringify(reply) + '\n') throw fail();
    return reply;
  } catch {
    throw fail();
  }
}

function inspectOwnedStore(owned) {
  try {
    owned.verify();
    const file = safePath(path.join(owned.store, 'checkpoint.sqlite'));
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try {
      const schemaVersion = database.prepare('PRAGMA user_version').get().user_version;
      const rows = database
        .prepare('SELECT revision, created_at, expires_at, kind FROM recovery_state LIMIT 2')
        .all();
      if (rows.length !== 1 || rows[0].kind !== 'state') throw fail();
      const hasBlobs = database
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='recovery_blob'")
        .get().n;
      const blobs = hasBlobs
        ? database.prepare('SELECT count(*) AS n FROM recovery_blob').get().n
        : 0;
      return {
        schemaVersion,
        hasBlobs,
        blobs,
        revision: rows[0].revision,
        createdAt: rows[0].created_at,
        expiresAt: rows[0].expires_at,
      };
    } finally {
      database.close();
      owned.verify();
    }
  } catch {
    throw fail();
  }
}

module.exports = { createOwnedRoot, executeDriver, inspectOwnedStore };
