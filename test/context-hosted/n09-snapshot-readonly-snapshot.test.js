'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  createDurableSnapshotReader,
} = require('../../scripts/context-hosted/n09-snapshot/readonly-snapshot.js');
const {
  optionsData,
  createReadonlyFiles,
} = require('../../scripts/context-hosted/n09-snapshot/readonly-files.js');
const { createStorageCipher } = require('../../lib/proxy/context-recovery-storage-cipher');
const { createRootCheckpoint } = require('../../lib/proxy/context-recovery-root-checkpoint');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../../lib/proxy/context-recovery-sessions');
const {
  referenceStateFromCheckpoint,
} = require('../../lib/proxy/context-recovery-reference-state');
const schema = require('../../lib/proxy/context-recovery-storage-schema');
const bad = { message: 'n09_readonly_snapshot_unavailable' };
const ownedRoot = path.resolve(os.tmpdir(), 'hpm-snapshot-pure-owned');
const options = { ownedRoot, runtimeDir: path.join(ownedRoot, 'runtime') };

function reference() {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  try {
    runtime.configure(true);
    const session = runtime.begin({
      principal: 'fixture-owner',
      protocol: 'chat',
      target: 'fixture',
      history: [{ role: 'user', content: 'synthetic question' }],
    });
    assert.equal(
      session.complete([{ role: 'assistant', content: 'synthetic answer' }], [], 'fixture-response')
        .ok,
      true
    );
    return referenceStateFromCheckpoint(
      createRootCheckpoint(exportContextRecoveryRoot(runtime, session.snapshotId), [])
    );
  } finally {
    runtime.close();
  }
}
function fixture() {
  const key = Buffer.alloc(32, 7).toString('base64');
  const cipher = createStorageCipher(key);
  const state = { reference: reference(), version: 3, kind: 'recovery-referenced-checkpoint' };
  const storeId = 'a'.repeat(32),
    scope = 'b'.repeat(64);
  const context = {
    storeId,
    scope,
    revision: 1,
    createdAt: state.reference.metadata.createdAt,
    expiresAt: state.reference.metadata.expiresAt,
    kind: 'state',
    version: 1,
  };
  const f = {
    rows: [],
    version: 2,
    application: schema.APPLICATION_ID,
    commands: [],
    closed: 0,
    verified: 0,
  };
  f.seal = (value = state, override = {}) => {
    const c = { ...context, ...override };
    return {
      scope: c.scope,
      revision: c.revision,
      created_at: c.createdAt,
      expires_at: c.expiresAt,
      kind: c.kind,
      envelope: cipher.seal(c, value),
    };
  };
  f.state = state;
  f.rows = [f.seal()];
  f.header = {
    store_id: storeId,
    envelope: cipher.seal(
      {
        storeId,
        scope: '0'.repeat(64),
        revision: 1,
        createdAt: 0,
        expiresAt: 1,
        kind: 'header',
        version: 1,
      },
      { schema: 2, lastTime: 100 }
    ),
  };
  const layouts = [
    ['table', 'recovery_header', 'recovery_header', schema.HEADER_SQL],
    ['table', 'recovery_state', 'recovery_state', schema.STATE_SQL],
    ['index', 'sqlite_autoindex_recovery_state_1', 'recovery_state', null],
    ['table', 'recovery_blob', 'recovery_blob', schema.BLOB_SQL],
    ['index', 'sqlite_autoindex_recovery_blob_1', 'recovery_blob', null],
  ].map(([type, name, tbl_name, sql]) => ({ type, name, tbl_name, sql }));
  f.trusted = {
    createFiles: () => ({
      databaseFile: 'fixed-readonly-fixture',
      readKey: () => 'wrapped-fixture',
      verify() {
        f.verified++;
        if (f.failVerify) throw f.privateError;
      },
    }),
    unprotect: () => key,
    openReadonly: (file) => {
      assert.equal(file, 'fixed-readonly-fixture');
      if (f.failOpen) throw f.privateError;
      return {
        exec(sql) {
          f.commands.push(sql);
          assert.ok(
            ['PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN', 'ROLLBACK'].includes(sql)
          );
          if ((f.failBegin && sql.includes('BEGIN')) || (f.failRollback && sql === 'ROLLBACK'))
            throw f.privateError;
        },
        prepare(sql) {
          assert.match(sql, /^(SELECT|PRAGMA)/);
          assert.doesNotMatch(sql, /FROM recovery_blob\b/);
          return {
            get() {
              if (sql === 'PRAGMA user_version') return { user_version: f.version };
              if (sql === 'PRAGMA application_id') return { application_id: f.application };
              if (sql.includes('sqlite_temp_schema')) return undefined;
              if (sql.includes('recovery_header WHERE')) return f.header;
              throw new Error('unexpected-fixture-query');
            },
            all() {
              if (sql.includes('FROM sqlite_schema')) return layouts;
              if (sql.includes('FROM recovery_state')) return f.rows;
              throw new Error('unexpected-fixture-query');
            },
          };
        },
        close() {
          f.closed++;
          if (f.failClose) throw f.privateError;
        },
      };
    },
  };
  f.reader = () => createDurableSnapshotReader(options, f.trusted);
  return f;
}

test('authenticated committed metadata only, revision update and pinned root', () => {
  const f = fixture(),
    reader = f.reader();
  const first = reader.read();
  assert.deepEqual(
    Object.keys(first).sort(),
    [
      'calls',
      'evidenceLevel',
      'expiresAt',
      'hostDurableAck',
      'present',
      'returnedBytes',
      'revision',
      'rootId',
    ].sort()
  );
  assert.equal(first.hostDurableAck, false);
  assert.equal(first.evidenceLevel, 'committed-metadata-only');
  assert.equal(first.rootId, f.state.reference.metadata.rootId);
  assert.equal(first.calls, f.state.reference.metadata.budget.calls);
  f.rows = [f.seal(undefined, { revision: 2 })];
  assert.equal(reader.read().revision, 2);
  assert.equal(f.closed, 2);
  reader.close();
  reader.close();
  assert.throws(() => reader.read(), bad);
});
test('empty and disappeared root omit all budget counters', () => {
  const f = fixture(),
    reader = f.reader();
  f.rows = [];
  const empty = reader.read();
  assert.equal(empty.reason, 'empty');
  assert.equal('calls' in empty, false);
  f.rows = [f.seal()];
  const present = reader.read();
  f.rows = [];
  const absent = reader.read();
  assert.equal(absent.rootId, present.rootId);
  assert.equal(absent.reason, 'absent');
  assert.equal('returnedBytes' in absent, false);
});
test('authenticated tombstone after binding is absence, never fabricated zero budget', () => {
  const f = fixture(),
    reader = f.reader();
  reader.read();
  f.rows = [f.seal({ revoked: true }, { kind: 'revoked', revision: 2 })];
  const value = reader.read();
  assert.equal(value.reason, 'revoked');
  assert.equal(value.revision, 2);
  assert.equal('calls' in value, false);
});
for (const kind of [
  'schema',
  'application',
  'multi-root',
  'oversize-envelope',
  'AAD',
  'digest',
  'legacy',
  'revision',
  'scope',
  'root',
]) {
  test(`reject ${kind} without content leakage`, () => {
    const f = fixture(),
      reader = f.reader();
    reader.read();
    if (kind === 'schema') f.version = 1;
    if (kind === 'application') f.application = 0;
    if (kind === 'multi-root') f.rows.push(f.rows[0]);
    if (kind === 'oversize-envelope') f.rows[0].envelope = Buffer.alloc(16 * 1024 * 1024 + 5000);
    if (kind === 'AAD') f.rows[0].revision++;
    if (kind === 'digest') {
      const s = globalThis.structuredClone(f.state);
      s.reference.digest = '0'.repeat(64);
      f.rows = [f.seal(s)];
    }
    if (kind === 'legacy') f.rows = [f.seal({ kind: 'PRIVATE', version: 1 })];
    if (kind === 'revision') {
      f.rows = [f.seal(undefined, { revision: 2 })];
      reader.read();
      f.rows = [f.seal()];
    }
    if (kind === 'scope') f.rows = [f.seal(undefined, { scope: 'c'.repeat(64) })];
    if (kind === 'root') {
      const s = globalThis.structuredClone(f.state);
      s.reference.metadata.rootId = 'PRIVATE';
      f.rows = [f.seal(s)];
    }
    assert.throws(() => reader.read(), bad);
  });
}
for (const fault of ['failOpen', 'failBegin', 'failRollback', 'failClose', 'failVerify']) {
  test(`safe fixed failure and cleanup for ${fault}`, () => {
    const f = fixture();
    let traps = 0;
    f.privateError = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('PRIVATE');
        },
      }
    );
    f[fault] = true;
    assert.throws(() => f.reader().read(), bad);
    assert.equal(traps, 0);
    if (['failBegin', 'failRollback', 'failClose'].includes(fault)) assert.equal(f.closed, 1);
  });
}
test('input getters and Proxy are never invoked', () => {
  let traps = 0;
  assert.throws(
    () =>
      optionsData(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              traps++;
              return null;
            },
            ownKeys() {
              traps++;
              return [];
            },
          }
        )
      ),
    bad
  );
  assert.throws(
    () =>
      optionsData({
        ownedRoot,
        get runtimeDir() {
          traps++;
          return options.runtimeDir;
        },
      }),
    bad
  );
  assert.equal(traps, 0);
  for (const runtimeDir of [ownedRoot, path.dirname(ownedRoot), '', '\0', 1])
    assert.throws(() => optionsData({ ownedRoot, runtimeDir }), bad);
});
function withFiles(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-ro-fixture-'));
  const runtimeDir = path.join(root, 'runtime'),
    dir = path.join(runtimeDir, 'context-recovery-v1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'checkpoint.sqlite'), 'fixture-not-a-db');
  fs.writeFileSync(path.join(dir, '.data-key'), 'fixture-wrapped-key');
  try {
    run({ root, runtimeDir, dir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('readonly file pins and key byte identity; no write or owner opening', () =>
  withFiles(({ root, runtimeDir, dir }) => {
    const files = createReadonlyFiles({ ownedRoot: root, runtimeDir });
    const db = path.join(dir, 'checkpoint.sqlite');
    const before = fs.readFileSync(db);
    assert.equal(files.readKey(), 'fixture-wrapped-key');
    files.verify();
    assert.deepEqual(fs.readFileSync(db), before);
    fs.writeFileSync(path.join(dir, '.data-key'), 'changed-wrapped-key');
    assert.throws(() => files.readKey(), bad);
  }));
test('hardlinked or replaced file fails pins', () =>
  withFiles(({ root, runtimeDir, dir }) => {
    const files = createReadonlyFiles({ ownedRoot: root, runtimeDir });
    files.verify();
    const db = path.join(dir, 'checkpoint.sqlite');
    fs.linkSync(db, path.join(dir, 'linked'));
    assert.throws(() => files.verify(), bad);
    fs.unlinkSync(path.join(dir, 'linked'));
    fs.renameSync(db, path.join(dir, 'previous'));
    fs.writeFileSync(db, 'replacement');
    assert.throws(() => files.verify(), bad);
  }));
test('symlink storage path fails closed', () =>
  withFiles(({ root, runtimeDir, dir }) => {
    const moved = path.join(root, 'moved');
    fs.renameSync(dir, moved);
    fs.symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createReadonlyFiles({ ownedRoot: root, runtimeDir }).verify(), bad);
  }));
