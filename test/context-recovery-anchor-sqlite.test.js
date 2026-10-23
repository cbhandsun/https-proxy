'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createStorageCipher } = require('../lib/proxy/context-recovery-storage-cipher');
const safeFailure = (error) => {
  assert.equal(error.message, 'context_recovery_storage_unavailable');
  assert.equal(error.code, error.message);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
};
const scope = 'a'.repeat(64);
function fixture(t) {
  const database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64');
  let time = 100;
  let calls = 0;
  const now = () => {
    calls++;
    return time;
  };
  const open = (extra = {}) => createRecoverySqliteStore({ database, dataKey, now, ...extra });
  t.after(() => database.close());
  return {
    database,
    dataKey,
    now,
    open,
    setTime(value) {
      time = value;
    },
    calls: () => calls,
  };
}
function save(store, revision = 0, expiresAt = 1000) {
  return store.execute({
    operation: 'save',
    scope,
    expectedRevision: revision,
    expiresAt,
    state: { text: 'PRIVATE original content', token: 'PRIVATE synthetic key' },
  });
}
function durable(database) {
  return {
    header: database.prepare('SELECT * FROM recovery_header').all(),
    rows: database.prepare('SELECT * FROM recovery_state ORDER BY scope').all(),
    changes: database.prepare('SELECT total_changes() AS count').get().count,
  };
}

test('empty startup snapshot and private snapshot expose only frozen authenticated metadata', (t) => {
  const f = fixture(t);
  let observed;
  const store = f.open({
    beforeStartup(value) {
      observed = value;
    },
  });
  assert.deepEqual(observed.scopes, []);
  assert.equal(observed.maxTime, 0);
  assert.equal(store.snapshot().maxTime, 100);
  assert.equal(f.calls(), 2);
  assert.match(observed.storeId, /^[a-f0-9]{32}$/);
  assert.ok(Object.isFrozen(observed));
  assert.ok(Object.isFrozen(observed.scopes));
  save(store);
  const value = store.snapshot();
  assert.deepEqual(Object.keys(value), ['storeId', 'maxTime', 'scopes']);
  assert.deepEqual(Object.keys(value.scopes[0]), [
    'scope',
    'revision',
    'createdAt',
    'expiresAt',
    'kind',
    'tag',
  ]);
  assert.match(value.scopes[0].tag, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(value.scopes[0]));
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.throws(() => {
    value.scopes[0].revision = 9;
  }, TypeError);
  store.close();
  assert.throws(() => store.snapshot(), safeFailure);
});

test('snapshot reads persisted time under BEGIN without reading clock, pruning or writing', (t) => {
  const f = fixture(t);
  const sql = [];
  let noWrites = false;
  const wrapper = {
    exec(command) {
      sql.push(command);
      return f.database.exec(command);
    },
    prepare(command) {
      const statement = f.database.prepare(command);
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run(...args) {
          assert.equal(noWrites, false);
          return statement.run(...args);
        },
      };
    },
  };
  const store = f.open({ database: wrapper });
  save(store);
  const before = durable(f.database);
  const calls = f.calls();
  f.setTime(1001);
  sql.length = 0;
  noWrites = true;
  const value = store.snapshot();
  assert.equal(value.maxTime, 100);
  assert.equal(value.scopes.length, 1);
  assert.equal(f.calls(), calls);
  assert.deepEqual(durable(f.database), before);
  assert.equal(sql[0], 'BEGIN');
  assert.equal(sql.at(-1), 'COMMIT');
  assert.equal(
    sql.some((command) => /UPDATE|DELETE|INSERT|BEGIN IMMEDIATE/.test(command)),
    false
  );
  store.close();
});

for (const callback of [
  null,
  true,
  1,
  'callback',
  {},
  [],
  new Proxy(() => {}, {
    apply() {
      throw Error('PRIVATE');
    },
  }),
])
  test('invalid startup callback is safely refused before touching database', (t) => {
    const f = fixture(t);
    assert.throws(() => f.open({ beforeStartup: callback }), safeFailure);
    assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(f.calls(), 0);
  });

test('option getters and Proxy traps never run', (t) => {
  const f = fixture(t);
  let touched = 0;
  const options = { database: f.database, dataKey: f.dataKey, now: f.now };
  const getter = { ...options };
  Object.defineProperty(getter, 'beforeStartup', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const proxy = new Proxy(options, {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
    getPrototypeOf() {
      touched++;
      throw Error('PRIVATE');
    },
    ownKeys() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => createRecoverySqliteStore(getter), safeFailure);
  assert.throws(() => createRecoverySqliteStore(proxy), safeFailure);
  assert.equal(touched, 0);
  assert.equal(f.calls(), 0);
});

test('existing startup rejection precedes clock and expiry pruning and leaves all durable bytes unchanged', (t) => {
  const f = fixture(t);
  const store = f.open();
  save(store);
  const captured = store.snapshot();
  store.close();
  const before = durable(f.database);
  const calls = f.calls();
  f.setTime(2000);
  assert.throws(
    () =>
      f.open({
        beforeStartup(value) {
          assert.deepEqual(value, captured);
          assert.equal(f.calls(), calls);
          throw new Error('PRIVATE anchor rejection');
        },
      }),
    safeFailure
  );
  assert.equal(f.calls(), calls);
  assert.deepEqual(durable(f.database), before);
  let admitted = false;
  const next = f.open({
    beforeStartup(value) {
      assert.deepEqual(value, captured);
      admitted = true;
    },
  });
  assert.equal(admitted, true);
  assert.deepEqual(next.snapshot().scopes, []);
  assert.equal(next.snapshot().maxTime, 2000);
  next.close();
});

test('startup callback runs while the writer transaction excludes another connection', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-anchor-sqlite-'));
  const file = path.join(folder, 'store.sqlite');
  const database = new DatabaseSync(file);
  const dataKey = randomBytes(32).toString('base64');
  const other = new DatabaseSync(file);
  t.after(() => {
    other?.close();
    database.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const first = createRecoverySqliteStore({ database, dataKey, now: () => 100 });
  first.close();
  const store = createRecoverySqliteStore({
    database,
    dataKey,
    now: () => 100,
    beforeStartup() {
      assert.throws(() => other.exec('BEGIN IMMEDIATE'), /locked/);
    },
  });
  store.close();
});

for (const tamper of ['revision', 'scope', 'expires', 'ciphertext', 'header'])
  test('snapshot and startup reject authenticated metadata tampering: ' + tamper, (t) => {
    const f = fixture(t);
    const store = f.open();
    save(store);
    if (tamper === 'revision') f.database.exec('UPDATE recovery_state SET revision=revision+1');
    if (tamper === 'scope')
      f.database.prepare('UPDATE recovery_state SET scope=?').run('b'.repeat(64));
    if (tamper === 'expires') f.database.exec('UPDATE recovery_state SET expires_at=999');
    if (tamper === 'ciphertext')
      f.database.exec('UPDATE recovery_state SET envelope=randomblob(length(envelope))');
    if (tamper === 'header')
      f.database.exec('UPDATE recovery_header SET envelope=randomblob(length(envelope))');
    assert.throws(() => store.snapshot(), safeFailure);
    store.close();
    const calls = f.calls();
    let callback = false;
    assert.throws(
      () =>
        f.open({
          beforeStartup() {
            callback = true;
          },
        }),
      safeFailure
    );
    assert.equal(callback, false);
    assert.equal(f.calls(), calls);
  });

test('snapshot authenticates semantic revoked shape and enforces the 256 scope boundary', (t) => {
  const f = fixture(t);
  const store = f.open();
  const id = store.snapshot().storeId;
  const cipher = createStorageCipher(f.dataKey);
  t.after(() => cipher.close());
  const insert = f.database.prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)');
  const add = (index, kind = 'state', state = { value: 'PRIVATE' }) => {
    const rowScope = index.toString(16).padStart(64, '0');
    const context = {
      storeId: id,
      scope: rowScope,
      revision: 1,
      createdAt: 100,
      expiresAt: 1000,
      kind,
      version: 1,
    };
    insert.run(rowScope, 1, 100, 1000, kind, cipher.seal(context, state));
  };
  for (let index = 0; index < 256; index++) add(index);
  const value = store.snapshot();
  assert.equal(value.scopes.length, 256);
  assert.deepEqual(
    value.scopes.map((entry) => entry.scope),
    value.scopes.map((entry) => entry.scope).toSorted()
  );
  add(256);
  assert.throws(() => store.snapshot(), safeFailure);
  f.database
    .prepare('DELETE FROM recovery_state WHERE scope=?')
    .run((256).toString(16).padStart(64, '0'));
  f.database.prepare('DELETE FROM recovery_state WHERE scope=?').run('0'.repeat(64));
  add(0, 'revoked', { revoked: false });
  assert.throws(() => store.snapshot(), safeFailure);
  store.close();
});

test('successful execute changes revision, tag, revoked state, shortened TTL and scope reuse after expiry', (t) => {
  const f = fixture(t);
  const store = f.open();
  save(store);
  const original = store.snapshot().scopes[0];
  f.setTime(200);
  save(store, 1, 900);
  const shorter = store.snapshot();
  assert.equal(shorter.maxTime, 200);
  assert.equal(shorter.scopes[0].revision, 2);
  assert.equal(shorter.scopes[0].createdAt, 100);
  assert.equal(shorter.scopes[0].expiresAt, 900);
  assert.notEqual(shorter.scopes[0].tag, original.tag);
  store.execute({ operation: 'revoke', scope, expectedRevision: 2 });
  const revoked = store.snapshot().scopes[0];
  assert.equal(revoked.kind, 'revoked');
  assert.equal(revoked.revision, 3);
  assert.notEqual(revoked.tag, shorter.scopes[0].tag);
  f.setTime(901);
  save(store, 0, 1200);
  const reused = store.snapshot().scopes[0];
  assert.equal(reused.revision, 1);
  assert.equal(reused.createdAt, 901);
  assert.equal(reused.kind, 'state');
  assert.notEqual(reused.tag, original.tag);
  store.close();
});

test('rejected first startup rolls back the new schema and exposes no persistent authority', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.open({
        beforeStartup() {
          throw new Error('PRIVATE');
        },
      }),
    safeFailure
  );
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(f.database.prepare('SELECT name FROM sqlite_schema').all(), []);
  assert.equal(f.calls(), 0);
  const store = f.open();
  assert.equal(store.snapshot().scopes.length, 0);
  store.close();
});

test('snapshot rejects an unknown schema before reading state or calling clock', (t) => {
  const f = fixture(t);
  const store = f.open();
  save(store);
  const calls = f.calls();
  f.database.exec('PRAGMA user_version=99');
  assert.throws(() => store.snapshot(), safeFailure);
  assert.equal(f.calls(), calls);
  store.close();
});

for (const rollbackFails of [false, true])
  test(`snapshot commit failure rolls back safely; rollback failure closes engine: ${rollbackFails}`, (t) => {
    const f = fixture(t);
    let failCommit = false;
    let rolledBack = false;
    const wrapper = {
      exec(sql) {
        if (sql === 'COMMIT' && failCommit) throw new Error('PRIVATE commit');
        if (sql === 'ROLLBACK') {
          rolledBack = true;
          f.database.exec(sql);
          if (rollbackFails) throw new Error('PRIVATE rollback');
          return;
        }
        return f.database.exec(sql);
      },
      prepare: (sql) => f.database.prepare(sql),
    };
    const store = f.open({ database: wrapper });
    save(store);
    const before = durable(f.database);
    const calls = f.calls();
    failCommit = true;
    assert.throws(() => store.snapshot(), safeFailure);
    assert.equal(rolledBack, true);
    failCommit = false;
    if (rollbackFails) assert.throws(() => store.snapshot(), safeFailure);
    else assert.equal(store.snapshot().scopes.length, 1);
    assert.equal(f.calls(), calls);
    assert.deepEqual(durable(f.database), before);
    store.close();
  });

for (const returnValue of [false, true, 0, 'accepted', null, {}, Promise.resolve()])
  test('startup requires an explicit synchronous undefined return', (t) => {
    const f = fixture(t);
    const first = f.open();
    save(first);
    first.close();
    const before = durable(f.database);
    const calls = f.calls();
    f.setTime(2000);
    assert.throws(() => f.open({ beforeStartup: () => returnValue }), safeFailure);
    assert.equal(f.calls(), calls);
    assert.deepEqual(durable(f.database), before);
  });

test('async startup callback is rejected before invocation or schema creation', (t) => {
  const f = fixture(t);
  let called = false;
  assert.throws(
    () =>
      f.open({
        beforeStartup: async () => {
          called = true;
          throw new Error('PRIVATE');
        },
      }),
    safeFailure
  );
  assert.equal(called, false);
  assert.equal(f.calls(), 0);
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
});

test('startup callback return Proxy/getters are never inspected', (t) => {
  const f = fixture(t);
  let touched = 0;
  const returned = new Proxy(
    {},
    {
      get() {
        touched++;
        throw new Error('PRIVATE');
      },
      getPrototypeOf() {
        touched++;
        throw new Error('PRIVATE');
      },
      ownKeys() {
        touched++;
        throw new Error('PRIVATE');
      },
    }
  );
  assert.throws(() => f.open({ beforeStartup: () => returned }), safeFailure);
  const getter = Object.defineProperty({}, 'then', {
    get() {
      touched++;
      throw new Error('PRIVATE');
    },
  });
  assert.throws(() => f.open({ beforeStartup: () => getter }), safeFailure);
  assert.equal(touched, 0);
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
});

test('snapshot validates blob ownership before exposing any metadata', (t) => {
  const f = fixture(t);
  const store = f.open();
  const id = store.snapshot().storeId;
  const cipher = createStorageCipher(f.dataKey);
  t.after(() => cipher.close());
  const { BLOB_SQL } = require('../lib/proxy/context-recovery-storage-schema');
  f.database.exec(BLOB_SQL);
  f.database.exec('PRAGMA user_version=2');
  f.database.prepare('UPDATE recovery_header SET envelope=?').run(
    cipher.seal(
      {
        storeId: id,
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
  f.database
    .prepare('INSERT INTO recovery_blob VALUES(?,?,?,?,?)')
    .run('c'.repeat(64), 'b'.repeat(64), 100, 1000, Buffer.alloc(30));
  const before = durable(f.database);
  const calls = f.calls();
  assert.throws(() => store.snapshot(), safeFailure);
  assert.deepEqual(durable(f.database), before);
  assert.equal(f.calls(), calls);
  store.close();
  let called = false;
  assert.throws(
    () =>
      f.open({
        beforeStartup() {
          called = true;
        },
      }),
    safeFailure
  );
  assert.equal(called, false);
});

for (const initialStoreId of [
  null,
  false,
  1,
  '',
  'a'.repeat(31),
  'a'.repeat(33),
  'A'.repeat(32),
  'g'.repeat(32),
  'a'.repeat(32) + '\n',
  [],
  {},
  () => 'a'.repeat(32),
])
  test('initial store ID must be a canonical lowercase 32 character hex string', (t) => {
    const f = fixture(t);
    assert.throws(() => f.open({ initialStoreId }), safeFailure);
    assert.equal(f.calls(), 0);
    assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
  });

test('initial store ID getters and Proxy values fail without reading user fields or coercion', (t) => {
  const f = fixture(t);
  let touched = 0;
  const options = { database: f.database, dataKey: f.dataKey, now: f.now };
  Object.defineProperty(options, 'initialStoreId', {
    get() {
      touched++;
      throw new Error('PRIVATE');
    },
  });
  assert.throws(() => createRecoverySqliteStore(options), safeFailure);
  const proxy = new Proxy(
    {},
    {
      get() {
        touched++;
        throw new Error('PRIVATE');
      },
      getPrototypeOf() {
        touched++;
        throw new Error('PRIVATE');
      },
    }
  );
  assert.throws(() => f.open({ initialStoreId: proxy }), safeFailure);
  assert.equal(touched, 0);
  assert.equal(f.calls(), 0);
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
});

test('empty schema uses the supplied identity and reports genuine initialization before either clock', (t) => {
  const f = fixture(t);
  const initialStoreId = 'c'.repeat(32);
  let called = 0;
  const store = f.open({
    initialStoreId,
    beforeStartup(value, initializing) {
      called++;
      assert.equal(initializing, true);
      assert.equal(value.storeId, initialStoreId);
      assert.equal(value.maxTime, 0);
      assert.deepEqual(value.scopes, []);
      assert.equal(f.calls(), 0);
    },
  });
  assert.equal(called, 1);
  assert.equal(f.calls(), 2);
  assert.equal(store.snapshot().storeId, initialStoreId);
  assert.equal(
    f.database.prepare('SELECT store_id FROM recovery_header').get().store_id,
    initialStoreId
  );
  store.close();
});

test('ready schema preserves identity, accepts the same supplied identity and rejects replacement before clock', (t) => {
  const f = fixture(t);
  const initialStoreId = 'd'.repeat(32);
  const first = f.open({ initialStoreId });
  save(first);
  first.close();
  const before = durable(f.database);
  const calls = f.calls();
  let called = false;
  assert.throws(
    () =>
      f.open({
        initialStoreId: 'e'.repeat(32),
        beforeStartup() {
          called = true;
        },
      }),
    safeFailure
  );
  assert.equal(called, false);
  assert.equal(f.calls(), calls);
  assert.deepEqual(durable(f.database), before);
  const same = f.open({
    initialStoreId,
    beforeStartup(value, initializing) {
      assert.equal(initializing, false);
      assert.equal(value.storeId, initialStoreId);
    },
  });
  assert.equal(same.snapshot().storeId, initialStoreId);
  assert.deepEqual(durable(f.database), before);
  same.close();
});

test('initializing flag derives from schema even when a ready empty store still has time zero', (t) => {
  const f = fixture(t);
  f.setTime(0);
  const seen = [];
  const first = f.open({
    beforeStartup(value, initializing) {
      seen.push(initializing);
      assert.equal(value.maxTime, 0);
      assert.deepEqual(value.scopes, []);
    },
  });
  const initialStoreId = first.snapshot().storeId;
  first.close();
  const next = f.open({
    initialStoreId,
    initializing: true,
    beforeStartup(value, initializing) {
      seen.push(initializing);
      assert.equal(value.maxTime, 0);
      assert.deepEqual(value.scopes, []);
    },
  });
  assert.deepEqual(seen, [true, false]);
  next.close();
});

test('rejected initialization with a supplied identity leaves no header or schema', (t) => {
  const f = fixture(t);
  const initialStoreId = 'f'.repeat(32);
  assert.throws(
    () =>
      f.open({
        initialStoreId,
        beforeStartup(value, initializing) {
          assert.equal(initializing, true);
          assert.equal(value.storeId, initialStoreId);
          throw new Error('PRIVATE enrollment rejection');
        },
      }),
    safeFailure
  );
  assert.equal(f.calls(), 0);
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(f.database.prepare('SELECT name FROM sqlite_schema').all(), []);
  const retry = f.open({ initialStoreId });
  assert.equal(retry.snapshot().storeId, initialStoreId);
  retry.close();
});
