'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createRecoverySqliteStore,
  inspectRecoverySqliteSnapshot: inspect,
} = require('../lib/proxy/context-recovery-storage-sqlite');
const { createStorageCipher } = require('../lib/proxy/context-recovery-storage-cipher');
const { BLOB_SQL } = require('../lib/proxy/context-recovery-storage-schema');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const { referenceStateFromCheckpoint } = require('../lib/proxy/context-recovery-reference-state');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../lib/proxy/context-recovery-sessions');

const scope = 'a'.repeat(64);
function safe(error) {
  assert.equal(error.message, 'context_recovery_storage_unavailable');
  assert.equal(error.code, error.message);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
function fixture(t) {
  const database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64');
  const store = createRecoverySqliteStore({ database, dataKey, now: () => 100 });
  const cipher = createStorageCipher(dataKey);
  t.after(() => {
    store.close();
    cipher.close();
    database.close();
  });
  return { database, dataKey, store, cipher };
}
function save(f, state = { text: 'synthetic inspection payload' }) {
  return f.store.execute({
    operation: 'save',
    scope,
    expectedRevision: 0,
    expiresAt: state.root?.expiresAt ?? 1000,
    state,
  });
}
function persisted(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  return {
    schema: database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
    header: database.prepare('SELECT * FROM recovery_header').all(),
    rows: database.prepare('SELECT * FROM recovery_state ORDER BY scope').all(),
    blobs:
      version === 2
        ? database.prepare('SELECT * FROM recovery_blob ORDER BY scope,blob_id').all()
        : [],
    changes: database.prepare('SELECT total_changes() AS count').get().count,
    journal: database.prepare('PRAGMA journal_mode').get(),
    synchronous: database.prepare('PRAGMA synchronous').get(),
    maxPages: database.prepare('PRAGMA max_page_count').get(),
    secureDelete: database.prepare('PRAGMA secure_delete').get(),
  };
}
function readOnlyBridge(database, failCommit = false, overridePages) {
  const sql = [];
  return {
    sql,
    database: {
      exec(command) {
        sql.push(command);
        assert.ok(
          [
            'PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY',
            'BEGIN',
            'COMMIT',
            'ROLLBACK',
          ].includes(command)
        );
        if (command === 'COMMIT' && failCommit) throw new Error('synthetic commit failure');
        return database.exec(command);
      },
      prepare(command) {
        assert.match(
          command,
          /^(SELECT|PRAGMA (user_version|application_id|page_size|page_count)$)/
        );
        const statement = database.prepare(command);
        return {
          get(...args) {
            if (command === 'PRAGMA page_count' && overridePages !== undefined)
              return { page_count: overridePages };
            return statement.get(...args);
          },
          all: (...args) => statement.all(...args),
          run() {
            assert.fail('inspection attempted a write');
          },
        };
      },
    },
  };
}
function rowContext(f, row) {
  return {
    storeId: f.database.prepare('SELECT store_id FROM recovery_header').get().store_id,
    scope: row.scope,
    revision: row.revision,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    kind: row.kind,
    version: 1,
  };
}
function checkpoint() {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  try {
    const request = {
      principal: 'owner',
      protocol: 'chat',
      target: 'target',
      history: [{ role: 'user', content: 'q' }],
    };
    const tool = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    };
    const session = runtime.begin(request);
    assert.equal(
      session.complete(
        [tool],
        [{ callId: 'call', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
        'r-1'
      ).ok,
      true
    );
    const next = runtime.begin(
      {
        ...request,
        history: [
          ...request.history,
          tool,
          { role: 'tool', tool_call_id: 'call', content: 'synthetic blob output' },
        ],
      },
      [{ callId: 'call', output: 'synthetic blob output' }]
    );
    assert.equal(next.complete([{ role: 'assistant', content: 'done' }], [], 'r-2').ok, true);
    return createRootCheckpoint(exportContextRecoveryRoot(runtime, session.snapshotId), []);
  } finally {
    runtime.close();
  }
}

test('offline inspection commits authenticated immutable v1 metadata without clock or durable changes', (t) => {
  const f = fixture(t);
  save(f);
  const expected = f.store.snapshot();
  f.store.close();
  const before = persisted(f.database);
  const bridge = readOnlyBridge(f.database);
  t.mock.method(Date, 'now', () => {
    assert.fail('inspection read wall clock');
  });
  const result = inspect({ database: bridge.database, dataKey: f.dataKey });
  assert.deepEqual(result, expected);
  assert.ok(
    Object.isFrozen(result) && Object.isFrozen(result.scopes) && Object.isFrozen(result.scopes[0])
  );
  assert.deepEqual(Object.keys(result), ['storeId', 'maxTime', 'scopes']);
  assert.equal(bridge.sql.at(-1), 'COMMIT');
  assert.deepEqual(persisted(f.database), before);
});

test('offline inspection accepts existing empty v1/v2 schema but never initializes blank databases', (t) => {
  const f = fixture(t);
  f.store.close();
  assert.deepEqual(inspect({ database: f.database, dataKey: f.dataKey }).scopes, []);
  const header = f.database.prepare('SELECT * FROM recovery_header').get();
  f.database.exec(BLOB_SQL);
  f.database.exec('PRAGMA user_version=2');
  f.database.prepare('UPDATE recovery_header SET envelope=?').run(
    f.cipher.seal(
      {
        storeId: header.store_id,
        scope: '0'.repeat(64),
        revision: 1,
        createdAt: 0,
        expiresAt: 1,
        kind: 'header',
        version: 1,
      },
      { schema: 2, lastTime: 100 }
    )
  );
  const before = persisted(f.database);
  assert.deepEqual(inspect({ database: f.database, dataKey: f.dataKey }).scopes, []);
  assert.deepEqual(persisted(f.database), before);
  const blank = new DatabaseSync(':memory:');
  try {
    assert.throws(() => inspect({ database: blank, dataKey: f.dataKey }), safe);
    assert.equal(blank.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count, 0);
    assert.equal(blank.prepare('PRAGMA user_version').get().user_version, 0);
  } finally {
    blank.close();
  }
});

test('offline inspection preserves and authenticates expired and revoked rows', (t) => {
  const f = fixture(t);
  save(f);
  f.store.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  const revoked = inspect({ database: f.database, dataKey: f.dataKey });
  assert.equal(revoked.scopes[0].kind, 'revoked');
  const old = f.database.prepare('SELECT * FROM recovery_state').get();
  const expired = { ...old, created_at: 0, expires_at: 50 };
  f.database
    .prepare('UPDATE recovery_state SET created_at=0,expires_at=50,envelope=?')
    .run(f.cipher.seal(rowContext(f, expired), { revoked: true }));
  const before = persisted(f.database);
  const result = inspect({ database: f.database, dataKey: f.dataKey });
  assert.equal(result.scopes[0].expiresAt, 50);
  assert.equal(result.maxTime, 100);
  assert.deepEqual(persisted(f.database), before);
  f.database
    .prepare('UPDATE recovery_state SET envelope=?')
    .run(f.cipher.seal(rowContext(f, expired), { revoked: false }));
  assert.throws(() => inspect({ database: f.database, dataKey: f.dataKey }), safe);
});

test('offline inspection authenticates v2 blobs and rejects missing, altered and orphan payloads', (t) => {
  const f = fixture(t);
  save(f, checkpoint());
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 2);
  assert.ok(f.database.prepare('SELECT count(*) AS count FROM recovery_blob').get().count > 0);
  const before = persisted(f.database);
  assert.equal(inspect({ database: f.database, dataKey: f.dataKey }).scopes.length, 1);
  assert.deepEqual(persisted(f.database), before);
  for (const sql of [
    'UPDATE recovery_blob SET envelope=zeroblob(length(envelope))',
    'DELETE FROM recovery_blob',
    "UPDATE recovery_blob SET scope='" + 'b'.repeat(64) + "'",
    "UPDATE recovery_blob SET blob_id='" + 'b'.repeat(64) + "'",
  ]) {
    const changed = fixture(t);
    save(changed, checkpoint());
    changed.database.exec(sql);
    const damaged = persisted(changed.database);
    assert.throws(() => inspect({ database: changed.database, dataKey: changed.dataKey }), safe);
    assert.deepEqual(persisted(changed.database), damaged);
  }
});

test('offline inspection never returns success on schema, authentication, physical quota or commit failure', (t) => {
  const f = fixture(t);
  save(f);
  const before = persisted(f.database);
  for (const sql of [
    'UPDATE recovery_header SET envelope=zeroblob(length(envelope))',
    'UPDATE recovery_state SET envelope=zeroblob(length(envelope))',
    'UPDATE recovery_state SET revision=revision+1',
    'CREATE TABLE unexpected(value TEXT)',
    'PRAGMA application_id=0',
  ]) {
    const changed = fixture(t);
    save(changed);
    changed.database.exec(sql);
    const damaged = persisted(changed.database);
    assert.throws(() => inspect({ database: changed.database, dataKey: changed.dataKey }), safe);
    assert.deepEqual(persisted(changed.database), damaged);
  }
  assert.throws(
    () => inspect({ database: f.database, dataKey: randomBytes(32).toString('base64') }),
    safe
  );
  for (const bridge of [
    readOnlyBridge(f.database, true),
    readOnlyBridge(f.database, false, Number.MAX_SAFE_INTEGER),
  ]) {
    assert.throws(() => inspect({ database: bridge.database, dataKey: f.dataKey }), safe);
    assert.equal(bridge.sql.at(-1), 'ROLLBACK');
  }
  assert.deepEqual(persisted(f.database), before);
  assert.equal(inspect({ database: f.database, dataKey: f.dataKey }).scopes.length, 1);
});

test('offline inspection authenticates reference manifests and every retained source payload', (t) => {
  const f = fixture(t);
  const state = checkpoint();
  const reference = referenceStateFromCheckpoint(state);
  f.store.execute({
    operation: 'save-reference-state',
    scope,
    expectedRevision: 0,
    expiresAt: reference.metadata.expiresAt,
    reference,
    payloads: [...state.root.ledger.sources, ...state.stagedSources].map(
      ({ sourceId, output }) => ({ sourceId, output })
    ),
  });
  const expected = f.store.snapshot();
  const before = persisted(f.database);
  assert.deepEqual(inspect({ database: f.database, dataKey: f.dataKey }), expected);
  assert.deepEqual(persisted(f.database), before);
  f.database.exec('UPDATE recovery_blob SET envelope=zeroblob(length(envelope))');
  const damaged = persisted(f.database);
  assert.throws(() => inspect({ database: f.database, dataKey: f.dataKey }), safe);
  assert.deepEqual(persisted(f.database), damaged);
});

test('offline inspection rejects excessive authenticated live scopes without pruning', (t) => {
  const f = fixture(t);
  save(f);
  const original = f.database.prepare('SELECT * FROM recovery_state').get();
  for (let index = 1; index < 5; index++) {
    const item = { ...original, scope: index.toString(16).padStart(64, '0') };
    f.database
      .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
      .run(
        item.scope,
        item.revision,
        item.created_at,
        item.expires_at,
        item.kind,
        f.cipher.seal(rowContext(f, item), { text: 'synthetic quota state' })
      );
  }
  const before = persisted(f.database);
  assert.throws(() => inspect({ database: f.database, dataKey: f.dataKey }), safe);
  assert.deepEqual(persisted(f.database), before);
});

test('inspection accepts only exact data options and never evaluates getters or Proxy traps', (t) => {
  const f = fixture(t);
  let hits = 0;
  const getter = { database: f.database };
  Object.defineProperty(getter, 'dataKey', {
    enumerable: true,
    get() {
      hits++;
      throw new Error('synthetic private');
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        hits++;
      },
      ownKeys() {
        hits++;
      },
      getPrototypeOf() {
        hits++;
      },
    }
  );
  for (const input of [
    undefined,
    null,
    [],
    {},
    getter,
    proxy,
    {
      database: f.database,
      dataKey: f.dataKey,
      now() {
        hits++;
      },
    },
    { database: f.database, dataKey: f.dataKey, skipStartup: true },
  ])
    assert.throws(() => inspect(input), safe);
  assert.equal(hits, 0);
  const input = Object.assign(Object.create(null), { database: f.database, dataKey: f.dataKey });
  assert.equal(inspect(input).maxTime, 100);
});
