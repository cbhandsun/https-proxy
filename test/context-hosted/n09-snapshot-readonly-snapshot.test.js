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

function reference(withEvidence = false) {
  let time = 100;
  const runtime = createContextRecoverySessions({ now: () => time });
  try {
    runtime.configure(true);
    const session = runtime.begin({
      principal: 'fixture-owner',
      protocol: 'chat',
      target: 'fixture',
      history: [{ role: 'user', content: 'synthetic question' }],
    });
    if (withEvidence) {
      const output = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'original-call',
            type: 'function',
            function: { name: 'n09_original', arguments: '{}' },
          },
        ],
      };
      assert.equal(
        session.complete(
          [output],
          [
            {
              callId: 'original-call',
              toolName: 'n09_original',
              arguments: {},
              completed: true,
              output: '',
            },
          ],
          'fixture-call'
        ).ok,
        true
      );
      time++;
      const next = runtime.begin(
        {
          principal: 'fixture-owner',
          protocol: 'chat',
          target: 'fixture',
          history: [
            { role: 'user', content: 'synthetic question' },
            output,
            { role: 'tool', tool_call_id: 'original-call', content: 'synthetic original' },
          ],
        },
        [{ callId: 'original-call', output: 'synthetic original' }]
      );
      assert.equal(next.ok, true);
      assert.equal(
        next.complete([{ role: 'assistant', content: 'done' }], [], 'fixture-done').ok,
        true
      );
    } else
      assert.equal(
        session.complete(
          [{ role: 'assistant', content: 'synthetic answer' }],
          [],
          'fixture-response'
        ).ok,
        true
      );
    return referenceStateFromCheckpoint(
      createRootCheckpoint(exportContextRecoveryRoot(runtime, session.snapshotId), [])
    );
  } finally {
    runtime.close();
  }
}
function fixture(withEvidence = false, format = 2) {
  const key = Buffer.alloc(32, 7).toString('base64');
  const cipher = createStorageCipher(key);
  const state = {
    reference: reference(withEvidence),
    version: 3,
    kind: 'recovery-referenced-checkpoint',
  };
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
    version: format,
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
      { schema: format, lastTime: 100 }
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
            all(scope) {
              if (sql.includes('FROM sqlite_schema')) return layouts;
              if (sql.includes('FROM recovery_state'))
                return sql.includes('WHERE scope=?')
                  ? f.rows.filter((row) => row.scope === scope)
                  : f.rows;
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

test('readonly snapshot accepts only supported formats with a matching authenticated header', () => {
  for (const format of [2, 3]) {
    const f = fixture(true, format);
    const reader = f.reader();
    const result = reader.read();
    assert.equal(result.present, true);
    assert.equal(result.capturedEvidence.length, 1);
    assert.equal(result.hostDurableAck, false);
    reader.close();
    assert.equal(f.closed, 1);
    assert.ok(f.commands.every((sql) => sql.includes('query_only=ON') || sql === 'ROLLBACK'));
  }
  for (const [header, pragma] of [
    [2, 3],
    [3, 2],
    [4, 4],
    [3, 4],
    [3, '3'],
    [1, 1],
  ]) {
    const f = fixture(true, header);
    f.version = pragma;
    const reader = f.reader();
    assert.throws(() => reader.read(), bad);
    reader.close();
    assert.equal(f.closed, 1);
    assert.equal(f.commands.at(-1), 'ROLLBACK');
  }
});

test('readonly snapshot releases its read transaction before decrypting and projecting captured rows', () => {
  const f = fixture(true);
  const phases = [];
  f.trusted.onPhase = (phase) => {
    if ([181, 182, 183].includes(phase)) {
      assert.equal(f.closed, 1);
      assert.equal(f.commands.at(-1), 'ROLLBACK');
      phases.push(phase);
    }
  };
  const reader = f.reader();
  const value = reader.read();
  assert.equal(value.present, true);
  assert.equal(value.hostDurableAck, false);
  assert.equal(value.capturedEvidence.length, 1);
  assert.deepEqual(phases, [181, 182, 183]);
  assert.equal(f.closed, 1);
  reader.close();
});

test('snapshot projects authenticated captured receipts with branch-scoped identities and original source expiry', () => {
  const f = fixture(true);
  const reader = f.reader();
  const result = reader.read();
  assert.equal(result.capturedEvidence.length, 1);
  const receipt = result.capturedEvidence[0];
  assert.equal(receipt.capturedCallId, 'original-call');
  assert.match(receipt.source.callId, /^hpa_[a-f0-9]{64}$/);
  assert.notEqual(receipt.source.callId, receipt.capturedCallId);
  assert.equal(receipt.source.expiresAt, result.expiresAt + 1);
  assert.equal(
    receipt.source.digest,
    require('node:crypto').createHash('sha256').update('synthetic original').digest('hex')
  );
  assert.equal(JSON.stringify(receipt).includes('synthetic original'), false);
  assert.deepEqual(Object.keys(receipt.source).sort(), [
    'argumentsDigest',
    'bytes',
    'callId',
    'digest',
    'expiresAt',
    'sourceId',
    'toolName',
    'trust',
  ]);
  reader.close();
});

test('snapshot accepts first persistence after root creation without extending expiry', () => {
  const f = fixture();
  const metadata = f.state.reference.metadata;
  f.rows = [f.seal(f.state, { createdAt: metadata.createdAt + 25 })];
  const reader = f.reader();
  const result = reader.read();
  assert.equal(result.present, true);
  assert.equal(result.rootId, metadata.rootId);
  assert.equal(result.expiresAt, metadata.expiresAt);
  f.rows = [f.seal(f.state, { createdAt: metadata.createdAt + 25, revision: 2 })];
  assert.equal(reader.read().revision, 2);
  reader.close();
});

test('snapshot rejects authenticated rows predating root creation or changing absolute expiry', () => {
  for (const override of [
    { createdAt: 99, expiresAt: reference().metadata.expiresAt - 1 },
    { expiresAt: reference().metadata.expiresAt - 1 },
    { createdAt: 125, expiresAt: reference().metadata.expiresAt + 1 },
  ]) {
    const f = fixture();
    f.rows = [f.seal(f.state, override)];
    const reader = f.reader();
    assert.throws(() => reader.read(), bad);
    assert.equal(f.closed, 1);
    reader.close();
  }
});

test('authenticated committed metadata only, revision update and pinned root', () => {
  const f = fixture(),
    reader = f.reader();
  const first = reader.read();
  assert.deepEqual(
    Object.keys(first).sort(),
    [
      'calls',
      'capturedEvidence',
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
  assert.deepEqual(first.capturedEvidence, []);
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

test('snapshot observer emits only fixed metadata phases and preserves all resource cleanup on failure', () => {
  const phases = [];
  const success = fixture();
  const reader = createDurableSnapshotReader(options, {
    ...success.trusted,
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(reader.read().present, true);
  assert.deepEqual(
    phases,
    Array.from({ length: 11 }, (_, i) => 174 + i)
  );
  assert.equal(success.closed, 1);
  reader.close();
  for (let stop = 174; stop <= 184; stop++) {
    const f = fixture(),
      observed = [];
    assert.throws(() => {
      const r = createDurableSnapshotReader(options, {
        ...f.trusted,
        onPhase: (phase) => {
          observed.push(phase);
          if (phase === stop) throw Error('PRIVATE_SENTINEL');
        },
      });
      try {
        r.read();
      } finally {
        r.close();
      }
    }, bad);
    assert.equal(observed.at(-1), stop);
    assert.equal(f.closed, stop >= 179 ? 1 : 0);
    if (stop >= 179) assert.equal(f.commands.at(-1), 'ROLLBACK');
  }
});
test('snapshot observer rejects invalid callbacks, accessors and proxies before any callback trap runs', () => {
  let calls = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      calls++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  for (const onPhase of [null, 0, {}, proxy, async () => {}, function* () {}])
    assert.throws(() => createDurableSnapshotReader(options, { onPhase }), bad);
  const trusted = {
    get onPhase() {
      calls++;
      throw Error('PRIVATE_SENTINEL');
    },
  };
  assert.throws(() => createDurableSnapshotReader(options, trusted), bad);
  assert.throws(
    () =>
      createDurableSnapshotReader(
        options,
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              calls++;
              throw Error('PRIVATE_SENTINEL');
            },
          }
        )
      ),
    bad
  );
  assert.equal(calls, 0);
});

test('snapshot SQL reads authenticated metadata from actual in-memory SQLite without native or files', () => {
  const { DatabaseSync } = require('node:sqlite');
  const f = fixture(false, 3);
  const database = new DatabaseSync(':memory:');
  database.exec(
    schema.HEADER_SQL +
      ';' +
      schema.STATE_SQL +
      ';' +
      schema.BLOB_SQL +
      ';PRAGMA application_id=' +
      schema.APPLICATION_ID +
      ';PRAGMA user_version=3;'
  );
  database
    .prepare('INSERT INTO recovery_header(singleton,store_id,envelope) VALUES(1,?,?)')
    .run(f.header.store_id, f.header.envelope);
  const row = f.seal(f.state, { createdAt: f.state.reference.metadata.createdAt + 25 });
  database
    .prepare(
      'INSERT INTO recovery_state(scope,revision,created_at,expires_at,kind,envelope) VALUES(?,?,?,?,?,?)'
    )
    .run(row.scope, row.revision, row.created_at, row.expires_at, row.kind, row.envelope);
  const phases = [];
  const reader = createDurableSnapshotReader(options, {
    ...f.trusted,
    openReadonly: () => database,
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(reader.read().rootId, f.state.reference.metadata.rootId);
  assert.deepEqual(
    phases,
    Array.from({ length: 11 }, (_, i) => 174 + i)
  );
  reader.close();
});

test('actual readonly SQL contention is classified without waiting, replaying or accepting a snapshot', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const f = fixture(false, 3);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-readonly-lock-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  const writer = new DatabaseSync(file);
  writer.exec(
    schema.HEADER_SQL +
      ';' +
      schema.STATE_SQL +
      ';' +
      schema.BLOB_SQL +
      ';PRAGMA application_id=' +
      schema.APPLICATION_ID +
      ';PRAGMA user_version=3'
  );
  writer
    .prepare('INSERT INTO recovery_header VALUES(1,?,?)')
    .run(f.header.store_id, f.header.envelope);
  const row = f.rows[0];
  writer
    .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
    .run(row.scope, row.revision, row.created_at, row.expires_at, row.kind, row.envelope);
  const phases = [];
  let connections = 0;
  const reader = createDurableSnapshotReader(options, {
    ...f.trusted,
    createFiles: () => ({ databaseFile: file, readKey: () => 'wrapped-fixture', verify() {} }),
    openReadonly() {
      connections++;
      return new DatabaseSync(file, { readOnly: true, allowExtension: false });
    },
    onPhase: (phase) => phases.push(phase),
  });
  t.after(() => {
    reader.close();
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  writer.exec('BEGIN EXCLUSIVE');
  try {
    assert.throws(() => reader.read(), bad);
    assert.equal(connections, 1);
    assert.equal(phases.at(-1), 255, 'the original zero-wait SQL read failed with SQLITE_BUSY');
    assert.equal(phases.includes(180), false);
  } finally {
    writer.exec('ROLLBACK');
  }
  assert.equal(reader.read().rootId, f.state.reference.metadata.rootId);
  assert.equal(connections, 2, 'only the explicit later observation opens another connection');
});

test('schema failure classification never inspects hostile errors or changes cleanup', () => {
  let hooks = 0;
  const accessor = Object.defineProperties(
    {},
    {
      code: {
        get() {
          hooks++;
          throw Error('PRIVATE_CODE_SENTINEL');
        },
      },
      errcode: {
        get() {
          hooks++;
          throw Error('PRIVATE_NUMBER_SENTINEL');
        },
      },
    }
  );
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        hooks++;
        throw Error('PRIVATE_PROXY_SENTINEL');
      },
    }
  );
  for (const error of [
    null,
    undefined,
    '',
    5,
    {},
    [],
    accessor,
    proxy,
    Object.create({ code: 'ERR_SQLITE_ERROR', errcode: 5 }),
    { code: 'ERR_SQLITE_ERROR', errcode: '5' },
    { code: 'ERR_SQLITE_ERROR', errcode: 8 },
    { code: 'ERR_SQLITE_ERROR', errcode: Number.MAX_SAFE_INTEGER },
    { code: 'other', errcode: 5 },
  ]) {
    const f = fixture();
    const open = f.trusted.openReadonly;
    f.trusted.openReadonly = (...args) => {
      const database = open(...args);
      database.prepare = () => {
        throw error;
      };
      return database;
    };
    const phases = [];
    f.trusted.onPhase = (phase) => phases.push(phase);
    const reader = f.reader();
    try {
      assert.throws(() => reader.read(), bad);
      assert.equal(phases.at(-1), 179);
      assert.equal(f.closed, 1);
      assert.equal(f.commands.at(-1), 'ROLLBACK');
    } finally {
      reader.close();
    }
  }
  assert.equal(hooks, 0);
});

test('a failure in the bounded SQL contention observer cannot grant a snapshot or leak its error', () => {
  const f = fixture();
  const open = f.trusted.openReadonly;
  f.trusted.openReadonly = (...args) => {
    const database = open(...args);
    database.prepare = () => {
      throw Object.assign(new Error('PRIVATE_SQL_SENTINEL'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 5,
      });
    };
    return database;
  };
  const phases = [];
  f.trusted.onPhase = (phase) => {
    phases.push(phase);
    if (phase === 255) throw Error('PRIVATE_OBSERVER_SENTINEL');
  };
  const reader = f.reader();
  try {
    assert.throws(() => reader.read(), bad);
    assert.equal(phases.at(-1), 255);
    assert.equal(f.closed, 1);
    assert.equal(f.commands.at(-1), 'ROLLBACK');
  } finally {
    reader.close();
  }
});

test('bound snapshot SQL tolerates a later sibling root without adopting it or hiding original corruption', () => {
  const { DatabaseSync } = require('node:sqlite');
  const f = fixture(),
    sibling = fixture();
  const database = new DatabaseSync(':memory:');
  database.exec(
    schema.HEADER_SQL +
      ';' +
      schema.STATE_SQL +
      ';' +
      schema.BLOB_SQL +
      ';PRAGMA application_id=' +
      schema.APPLICATION_ID +
      ';PRAGMA user_version=2;'
  );
  database
    .prepare('INSERT INTO recovery_header(singleton,store_id,envelope) VALUES(1,?,?)')
    .run(f.header.store_id, f.header.envelope);
  const put = (row) =>
    database
      .prepare(
        'INSERT INTO recovery_state(scope,revision,created_at,expires_at,kind,envelope) VALUES(?,?,?,?,?,?)'
      )
      .run(row.scope, row.revision, row.created_at, row.expires_at, row.kind, row.envelope);
  const original = f.seal();
  put(original);
  const openReadonly = () => ({
    exec: (...args) => database.exec(...args),
    prepare: (...args) => database.prepare(...args),
    // Emulate disposing the read-only connection before the synthetic writer
    // reuses this one in-memory handle. No disk database or product owner.
    close() {
      database.exec('PRAGMA query_only=OFF');
    },
  });
  const reader = createDurableSnapshotReader(options, { ...f.trusted, openReadonly });
  try {
    const before = reader.read();
    const other = f.seal(sibling.state, { scope: 'd'.repeat(64) });
    put(other);
    const after = reader.read();
    assert.deepEqual(after, before);
    assert.notEqual(after.rootId, sibling.state.reference.metadata.rootId);
    // A first read still cannot pick an arbitrary root from two valid rows.
    const unbound = createDurableSnapshotReader(options, { ...f.trusted, openReadonly });
    assert.throws(() => unbound.read(), bad);
    unbound.close();
    database
      .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
      .run(Buffer.from('synthetic-corrupt'), original.scope);
    assert.throws(() => reader.read(), bad);
    database.prepare('DELETE FROM recovery_state WHERE scope=?').run(original.scope);
    assert.throws(() => reader.read(), bad);
  } finally {
    reader.close();
    database.close();
  }
});
