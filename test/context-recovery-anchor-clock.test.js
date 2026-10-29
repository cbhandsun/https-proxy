'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createRecoveryAnchorAdmission } = require('../lib/proxy/context-recovery-anchor-admission');
const {
  parseAnchorSnapshot,
  assertAnchorSuccessor,
} = require('../lib/proxy/context-recovery-anchor-contract');
const { createStorageCipher } = require('../lib/proxy/context-recovery-storage-cipher');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const { referenceStateFromCheckpoint } = require('../lib/proxy/context-recovery-reference-state');
const clone = (value) => globalThis.structuredClone(value);
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.cause === undefined;
const scope = 'a'.repeat(64);
const identity = { keyIdentity: 'b'.repeat(64), locationHash: 'c'.repeat(64) };
function checkpoint(output) {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  const binding = {
    principal: 'synthetic-owner',
    protocol: 'chat',
    target: 'synthetic',
    history: [{ role: 'user', content: 'q' }],
  };
  const first = runtime.begin(binding);
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  assert.equal(
    first.complete(
      [tool],
      [{ callId: 'call', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
      'first'
    ).ok,
    true
  );
  const next = runtime.begin(
    {
      ...binding,
      history: [...binding.history, tool, { role: 'tool', tool_call_id: 'call', content: output }],
    },
    [{ callId: 'call', output }]
  );
  assert.equal(next.complete([{ role: 'assistant', content: 'done' }], [], 'next').ok, true);
  const state = createRootCheckpoint(exportContextRecoveryRoot(runtime, first.snapshotId), []);
  runtime.close();
  return state;
}
function fixture(t, mode = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-anchor-clock-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  const key = randomBytes(32).toString('base64');
  let database,
    store,
    anchor,
    time = 100,
    held = null,
    revision = 0,
    failure,
    commitFailure = false,
    headerFailure = false,
    afterCommit;
  const commits = [];
  function close() {
    store?.close();
    anchor?.close();
    database?.close();
    store = anchor = database = undefined;
  }
  t.after(() => {
    close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function open(clockMode = mode) {
    database = new DatabaseSync(file);
    anchor = createRecoveryAnchorAdmission({
      repository: {
        identity,
        read: () => held,
        close() {},
        commit(value) {
          if (failure === 'before') throw Error('PRIVATE');
          held = clone(value);
          revision++;
          if (failure === 'after') throw Error('PRIVATE');
          return { revision };
        },
      },
      allowEnrollment: true,
      ...(clockMode ? { clockOnlyScans: true } : {}),
    });
    store = createRecoverySqliteStore({
      database: {
        prepare(sql) {
          if (sql === 'UPDATE recovery_header SET envelope=? WHERE singleton=1' && headerFailure) {
            return {
              run() {
                headerFailure = false;
                assert.equal(
                  database.prepare('SELECT count(*) AS n FROM recovery_state').get().n,
                  0
                );
                throw Error('PRIVATE');
              },
            };
          }
          return database.prepare(sql);
        },
        exec(sql) {
          if (sql === 'COMMIT') commits.push({ journalPresent: fs.existsSync(file + '-journal') });
          if (sql === 'COMMIT' && commitFailure) {
            commitFailure = false;
            throw Error('PRIVATE');
          }
          const result = database.exec(sql);
          if (sql === 'COMMIT' && afterCommit) {
            const callback = afterCommit;
            afterCommit = undefined;
            callback(database);
          }
          return result;
        },
      },
      dataKey: key,
      now: () => time,
      beforeStartup: anchor.validateStartup,
      initialStoreId: anchor.initialStoreId,
      anchoredStartup: true,
      ...(clockMode ? { anchorClockFloor: anchor.initialTime } : {}),
    });
    anchor.persist(store.snapshot());
  }
  function execute(request) {
    const result = store.execute(request);
    try {
      anchor.persist(store.snapshot());
      return result;
    } catch (error) {
      close();
      throw error;
    }
  }
  open();
  return {
    file,
    commits,
    open,
    close,
    execute,
    setTime: (value) => {
      time = value;
    },
    failAnchor: (value) => {
      failure = value;
    },
    failCommit: () => {
      commitFailure = true;
    },
    failHeader: () => {
      headerFailure = true;
    },
    afterCommit: (callback) => {
      afterCommit = callback;
    },
    held: () => clone(held),
    revision: () => revision,
    db: () => database,
    snapshot: () => store.snapshot(),
    bytes: () => fs.readFileSync(file),
    header: () => database.prepare('SELECT * FROM recovery_header').get(),
    sqlTime() {
      const row = database.prepare('SELECT * FROM recovery_header').get();
      const cipher = createStorageCipher(key);
      try {
        return cipher.open(
          {
            storeId: row.store_id,
            scope: '0'.repeat(64),
            revision: 1,
            createdAt: 0,
            expiresAt: 1,
            kind: 'header',
            version: 1,
          },
          row.envelope
        ).lastTime;
      } finally {
        cipher.close();
      }
    },
    save(output = 'synthetic original') {
      const state = checkpoint(output),
        reference = referenceStateFromCheckpoint(state);
      assert.deepEqual(
        execute({
          operation: 'save-reference-state',
          scope,
          expectedRevision: 0,
          expiresAt: state.root.expiresAt,
          reference,
          payloads: state.root.ledger.sources.map(({ sourceId, output }) => ({ sourceId, output })),
        }),
        { revision: 1 }
      );
      return state;
    },
  };
}

test('an unchanged anchored layout-three reopen advances the durable anchor without a clock-only SQL journal', (t) => {
  for (const populated of [false, true]) {
    const f = fixture(t);
    assert.equal(
      f.commits[0].journalPresent,
      true,
      'fresh initialization remains a durable SQL write'
    );
    const state = populated ? f.save('synthetic unchanged reopen') : null;
    const before = f.bytes(),
      header = f.header(),
      revision = f.revision();
    f.close();
    f.setTime(110);
    f.commits.length = 0;
    f.open();
    assert.deepEqual(f.bytes(), before);
    assert.deepEqual(f.header(), header);
    assert.equal(f.sqlTime(), 100);
    assert.equal(f.held().maxTime, 110);
    assert.equal(f.revision(), revision + 1);
    assert.equal(f.commits.length, 2);
    assert.equal(
      f.commits.some((value) => value.journalPresent),
      false
    );
    assert.equal(f.db().prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(f.db().prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(f.db().prepare('PRAGMA secure_delete').get().secure_delete, 1);
    if (state)
      assert.equal(f.execute({ operation: 'load', scope }).expiresAt, state.root.expiresAt);
  }
});

test('reopen expiry mutations retain the SQL clock and roll back on clock-write or COMMIT failure', (t) => {
  for (const failure of [null, 'header', 'commit']) {
    const f = fixture(t),
      state = f.save('synthetic expired reopen');
    const before = f.bytes(),
      revision = f.revision();
    f.close();
    f.setTime(state.root.expiresAt);
    f.commits.length = 0;
    if (failure === 'header') f.failHeader();
    if (failure === 'commit') f.failCommit();
    if (failure) {
      assert.throws(() => f.open(), safe);
      f.close();
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal(f.revision(), revision);
    } else {
      f.open();
      assert.equal(f.sqlTime(), state.root.expiresAt);
      assert.equal(f.held().maxTime, state.root.expiresAt);
      assert.equal(f.held().scopes.length, 0);
      assert.equal(f.commits[0].journalPresent, true);
      assert.equal(f.execute({ operation: 'load', scope }), null);
    }
  }
});

test('a reopened clock is not acknowledged until the independent anchor persists it', (t) => {
  for (const failure of ['before', 'after']) {
    const f = fixture(t);
    f.save();
    const before = f.bytes();
    f.close();
    f.setTime(110);
    f.failAnchor(failure);
    assert.throws(() => f.open(), safe);
    f.close();
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(f.held().maxTime, failure === 'before' ? 100 : 110);
    f.failAnchor(undefined);
    f.setTime(109);
    if (failure === 'after') {
      assert.throws(() => f.open(), safe);
      f.close();
    } else {
      f.open();
      assert.equal(f.held().maxTime, 109);
      f.close();
    }
    f.setTime(110);
    f.open();
    assert.equal(f.held().maxTime, 110);
    assert.equal(f.sqlTime(), 100);
  }
});

test('unchanged reopen still refuses invalid, backward and extreme clocks before SQL mutation or anchor ACK', (t) => {
  const f = fixture(t);
  f.save();
  const before = f.bytes(),
    revision = f.revision();
  f.close();
  for (const value of [-1, 99, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    f.setTime(value);
    assert.throws(() => f.open(), safe);
    f.close();
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(f.revision(), revision);
  }
  f.setTime(110);
  f.open();
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.held().maxTime, 110);
});

test('byte-unchanged anchored scan persists its exact clock in the OS anchor before ACK while retaining FULL/DELETE', (t) => {
  for (const output of ['', 'é🙂synthetic', 'x'.repeat(16384)]) {
    const f = fixture(t);
    const state = f.save(output),
      before = f.bytes(),
      header = f.header(),
      anchorBefore = f.revision();
    const changes = f.db().prepare('SELECT total_changes() AS n').get().n;
    f.setTime(110);
    const page = f.execute({ operation: 'scan-reference', after: null });
    assert.equal(page.record.revision, 1);
    assert.equal(page.record.reference.metadata.rootId, state.root.rootId);
    assert.deepEqual(f.bytes(), before);
    assert.deepEqual(f.header(), header);
    assert.equal(f.db().prepare('SELECT total_changes() AS n').get().n, changes);
    assert.equal(f.sqlTime(), 100);
    assert.equal(f.held().maxTime, 110);
    assert.equal(f.held().version, 2);
    assert.equal(f.held().headerTag, f.snapshot().headerTag);
    assert.equal(f.revision(), anchorBefore + 1);
    assert.equal(f.snapshot().maxTime, 110);
    assert.equal(f.db().prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(f.db().prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(f.db().prepare('PRAGMA secure_delete').get().secure_delete, 1);
    f.close();
    f.open();
    assert.equal(f.sqlTime(), 100);
    assert.equal(f.held().maxTime, 110);
    const restored = f.execute({ operation: 'load', scope });
    assert.equal(restored.expiresAt, state.root.expiresAt);
    assert.equal(restored.state.root.ledger.sources[0].output, output);
    f.close();
  }
});

test('the same scan no longer creates a DELETE rollback journal solely for the clock', (t) => {
  for (const mode of [false, true]) {
    const f = fixture(t, mode);
    f.save();
    f.setTime(110);
    f.commits.length = 0;
    f.execute({ operation: 'scan-reference', after: null });
    assert.equal(
      f.commits.length,
      2,
      'original scan COMMIT and independent snapshot COMMIT remain'
    );
    assert.equal(f.commits[0].journalPresent, !mode);
    assert.equal(f.commits[1].journalPresent, false);
    assert.equal(f.held().maxTime, 110);
  }
});

test('empty scans also retain a durable clock and reopen without extending a deadline', (t) => {
  const f = fixture(t),
    before = f.bytes();
  f.setTime(200);
  assert.deepEqual(f.execute({ operation: 'scan-reference', after: null }), {
    catalog: [],
    scope: null,
    record: null,
  });
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.held().maxTime, 200);
  f.close();
  f.open();
  assert.equal(f.sqlTime(), 100);
  assert.equal(f.held().maxTime, 200);
});

test('clock rollback is rejected both by the live floor and before any reopen mutation', (t) => {
  const f = fixture(t);
  f.save();
  f.setTime(110);
  f.execute({ operation: 'scan-reference', after: null });
  const before = f.bytes(),
    revision = f.revision();
  f.setTime(109);
  assert.throws(() => f.execute({ operation: 'scan-reference', after: null }), safe);
  assert.equal(f.revision(), revision);
  assert.deepEqual(f.bytes(), before);
  f.close();
  assert.throws(() => f.open(), safe);
  f.close();
  assert.deepEqual(f.bytes(), before);
  f.setTime(110);
  f.open();
  assert.equal(f.sqlTime(), 100);
  assert.equal(f.held().maxTime, 110);
});

test('expiry mutations persist their SQL clock atomically instead of using the read-only fast path', (t) => {
  const f = fixture(t),
    state = f.save();
  f.setTime(state.root.expiresAt);
  const before = f.bytes();
  assert.deepEqual(f.execute({ operation: 'scan-reference', after: null }), {
    catalog: [],
    scope: null,
    record: null,
  });
  assert.notDeepEqual(f.bytes(), before);
  assert.equal(f.sqlTime(), state.root.expiresAt);
  assert.equal(f.held().scopes.length, 0);
  f.close();
  f.open();
  assert.equal(f.execute({ operation: 'load', scope }), null);
});

test('failed SQL COMMIT does not advance the retained floor or create an anchor ACK', (t) => {
  const f = fixture(t);
  f.save();
  const before = f.bytes(),
    revision = f.revision();
  f.setTime(110);
  f.failCommit();
  assert.throws(() => f.execute({ operation: 'scan-reference', after: null }), safe);
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.revision(), revision);
  f.setTime(101);
  f.execute({ operation: 'scan-reference', after: null });
  assert.equal(f.held().maxTime, 101);
});

test('expiry deletion rolls back header, rows and payloads on late clock-write or COMMIT failure', (t) => {
  for (const mode of ['header', 'commit']) {
    const f = fixture(t),
      state = f.save('synthetic expiry rollback');
    const before = f.bytes(),
      revision = f.revision();
    f.setTime(state.root.expiresAt);
    if (mode === 'header') f.failHeader();
    else f.failCommit();
    assert.throws(() => f.execute({ operation: 'scan-reference', after: null }), safe);
    assert.deepEqual(f.bytes(), before);
    assert.equal(f.revision(), revision);
    f.setTime(101);
    assert.equal(
      f.execute({ operation: 'load', scope }).state.root.ledger.sources[0].output,
      'synthetic expiry rollback'
    );
    assert.equal(f.sqlTime(), 100);
    assert.equal(f.held().maxTime, 101);
  }
});

test('lost anchor ACK closes the owner; a persisted clock still guards catchup and rollback', (t) => {
  const f = fixture(t);
  f.save();
  f.setTime(110);
  f.failAnchor('after');
  assert.throws(() => f.execute({ operation: 'scan-reference', after: null }), safe);
  assert.equal(f.held().maxTime, 110);
  f.failAnchor(undefined);
  f.setTime(109);
  assert.throws(() => f.open(), safe);
  f.close();
  f.setTime(110);
  f.open();
  assert.equal(f.sqlTime(), 100);
  assert.equal(f.held().maxTime, 110);
});

test('an old authenticated header or a prior complete database cannot use clock catchup', (t) => {
  for (const attack of ['header', 'database']) {
    const f = fixture(t);
    f.save();
    const oldHeader = f.header(),
      oldBytes = f.bytes();
    f.setTime(105);
    f.execute({ operation: 'revoke', scope, expectedRevision: 1 });
    f.setTime(110);
    f.execute({ operation: 'scan-reference', after: null });
    f.close();
    if (attack === 'database') fs.writeFileSync(f.file, oldBytes);
    else {
      const db = new DatabaseSync(f.file);
      db.prepare('UPDATE recovery_header SET envelope=?').run(oldHeader.envelope);
      db.close();
    }
    const attacked = fs.readFileSync(f.file);
    assert.throws(() => f.open(), safe);
    f.close();
    assert.deepEqual(fs.readFileSync(f.file), attacked);
  }
});

test('legacy anchors upgrade only from an admitted SQL clock; their old time rollback gate remains strict', (t) => {
  const f = fixture(t, false);
  f.save();
  f.setTime(110);
  f.execute({ operation: 'scan-reference', after: null });
  assert.equal(f.held().version, 1);
  f.close();
  f.open(true);
  assert.equal(f.held().version, 2);
  const g = fixture(t, false);
  g.save();
  const old = g.bytes();
  g.setTime(110);
  g.execute({ operation: 'scan-reference', after: null });
  g.close();
  fs.writeFileSync(g.file, old);
  assert.throws(() => g.open(true), safe);
});

test('a legacy owner cannot write a version-two anchored database even when the wall clock advances', (t) => {
  const f = fixture(t);
  f.save();
  f.setTime(110);
  f.execute({ operation: 'load-reference', scope });
  const before = f.bytes();
  f.close();
  f.setTime(120);
  assert.throws(() => f.open(false), safe);
  f.close();
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('invalid, backward and extreme scan clocks cannot mutate SQLite or advance the anchor', (t) => {
  const f = fixture(t);
  f.save();
  const before = f.bytes(),
    revision = f.revision();
  for (const value of [-1, 99, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    f.setTime(value);
    assert.throws(() => f.execute({ operation: 'scan-reference', after: null }), safe);
    assert.equal(f.revision(), revision);
    assert.deepEqual(f.bytes(), before);
  }
  f.setTime(101);
  f.execute({ operation: 'scan-reference', after: null });
  assert.equal(f.held().maxTime, 101);
});

test('clock-only mode cannot be enabled without the anchored startup boundary or a valid floor', () => {
  let calls = 0;
  const options = {
    dataKey: randomBytes(32).toString('base64'),
    database: {
      prepare() {
        calls++;
        throw Error('PRIVATE');
      },
      exec() {
        calls++;
        throw Error('PRIVATE');
      },
    },
    anchoredStartup: true,
    beforeStartup() {},
  };
  for (const floor of [-1, false, '0', 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])
    assert.throws(() => createRecoverySqliteStore({ ...options, anchorClockFloor: floor }), safe);
  assert.throws(
    () => createRecoverySqliteStore({ ...options, anchoredStartup: false, anchorClockFloor: 0 }),
    safe
  );
  const getter = { ...options };
  Object.defineProperty(getter, 'anchorClockFloor', {
    enumerable: true,
    get() {
      calls++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => createRecoverySqliteStore(getter), safe);
  assert.equal(calls, 0);
});

test('new witness fields remain closed, non-executable and cannot authorize a format downgrade', () => {
  const value = {
    version: 2,
    ...identity,
    storeId: 'a'.repeat(32),
    maxTime: 100,
    scopes: [],
    headerTag: 'd'.repeat(64),
  };
  assert.equal(parseAnchorSnapshot(value).headerTag, value.headerTag);
  let calls = 0;
  const getter = { ...value };
  Object.defineProperty(getter, 'headerTag', {
    enumerable: true,
    get() {
      calls++;
      throw Error('PRIVATE');
    },
  });
  for (const bad of [
    { ...value, headerTag: '' },
    { ...value, headerTag: 'g'.repeat(64) },
    { ...value, headerTag: 1 },
    { ...value, extra: true },
    getter,
    new Proxy(value, {}),
  ])
    assert.throws(() => parseAnchorSnapshot(bad), safe);
  assert.equal(calls, 0);
  const { headerTag: _tag, ...old } = value;
  old.version = 1;
  assert.throws(() => assertAnchorSuccessor(value, old), safe);
  assert.equal(assertAnchorSuccessor(old, value).version, 2);
});

test('live authentic header replay cannot be masked by the retained scan clock', (t) => {
  for (const operation of [
    'scan',
    'snapshot',
    'load',
    'load-reference',
    'inspect',
    'catalog',
    'sweep',
  ]) {
    const f = fixture(t);
    f.save();
    const oldHeader = f.header();
    f.setTime(105);
    f.execute({ operation: 'revoke', scope, expectedRevision: 1 });
    f.setTime(110);
    f.execute({ operation: 'scan-reference', after: null });
    const revision = f.revision();
    f.db().prepare('UPDATE recovery_header SET envelope=?').run(oldHeader.envelope);
    const attacked = f.bytes();
    assert.throws(
      () =>
        operation === 'snapshot'
          ? f.snapshot()
          : f.execute(
              operation === 'scan'
                ? { operation: 'scan-reference', after: null }
                : ['inspect', 'catalog', 'sweep'].includes(operation)
                  ? { operation }
                  : { operation, scope }
            ),
      safe
    );
    assert.equal(f.revision(), revision);
    assert.deepEqual(f.bytes(), attacked);
  }
});

test('post-COMMIT header replay fails the independent snapshot before anchor ACK and closes the owner', (t) => {
  const f = fixture(t);
  f.save();
  const oldHeader = f.header();
  f.setTime(105);
  f.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  const revision = f.revision();
  f.setTime(110);
  let injected = false;
  f.afterCommit((database) => {
    injected = true;
    database.prepare('UPDATE recovery_header SET envelope=?').run(oldHeader.envelope);
  });
  assert.throws(() => f.execute({ operation: 'scan-reference', after: null }), safe);
  assert.equal(injected, true);
  assert.equal(f.revision(), revision);
  assert.equal(f.db(), undefined);
  const attacked = fs.readFileSync(f.file);
  assert.throws(() => f.open(), safe);
  f.close();
  assert.deepEqual(fs.readFileSync(f.file), attacked);
});

test('anchored load, reference load and inspect do not journal a clock-only observation', (t) => {
  for (const operation of ['load', 'load-reference', 'inspect']) {
    for (const output of ['', 'synthetic-read\r\n中文🙂', 'x'.repeat(16384)]) {
      const f = fixture(t),
        state = f.save(output),
        before = f.bytes(),
        revision = f.revision();
      const request = operation === 'inspect' ? { operation } : { operation, scope };
      f.setTime(110);
      f.commits.length = 0;
      const result = f.execute(request);
      if (operation === 'load') assert.equal(result.state.root.ledger.sources[0].output, output);
      else if (operation === 'load-reference')
        assert.equal(result.reference.metadata.rootId, state.root.rootId);
      else assert.equal(result.records, 1);
      assert.deepEqual(f.bytes(), before);
      assert.equal(f.sqlTime(), 100);
      assert.equal(f.held().maxTime, 110);
      assert.equal(f.revision(), revision + 1);
      assert.equal(f.commits.length, 2);
      assert.equal(
        f.commits.some(({ journalPresent }) => journalPresent),
        false
      );
      f.close();
      f.open();
      assert.equal(f.sqlTime(), 100);
      assert.equal(f.held().maxTime, 110);
      assert.equal(f.execute({ operation: 'load', scope }).expiresAt, state.root.expiresAt);
    }
  }
});

test('empty and expired read observations keep the original deadline and reject backward clocks', (t) => {
  for (const operation of ['load', 'load-reference', 'inspect']) {
    for (const populated of [false, true]) {
      const f = fixture(t),
        state = populated ? f.save() : null;
      const time = state ? state.root.expiresAt : 110;
      const before = f.bytes();
      f.setTime(time);
      const request = operation === 'inspect' ? { operation } : { operation, scope };
      const result = f.execute(request);
      assert.deepEqual(result, operation === 'inspect' ? { records: 0, bytes: 0 } : null);
      assert.deepEqual(f.bytes(), before);
      assert.equal(f.held().maxTime, time);
      const revision = f.revision();
      f.setTime(time - 1);
      assert.throws(() => f.execute(request), safe);
      assert.equal(f.revision(), revision);
      assert.deepEqual(f.bytes(), before);
      f.close();
      assert.throws(() => f.open(), safe);
    }
  }
});

test('read-only observations cannot acknowledge failed COMMIT or lost anchor flush acknowledgement', (t) => {
  for (const operation of ['load', 'load-reference', 'inspect']) {
    for (const failure of ['commit', 'anchor']) {
      const f = fixture(t);
      f.save();
      const before = f.bytes(),
        revision = f.revision();
      f.setTime(110);
      if (failure === 'commit') f.failCommit();
      else f.failAnchor('after');
      assert.throws(
        () => f.execute(operation === 'inspect' ? { operation } : { operation, scope }),
        safe
      );
      assert.deepEqual(fs.readFileSync(f.file), before);
      if (failure === 'commit') {
        assert.equal(f.revision(), revision);
        f.setTime(101);
        f.execute({ operation: 'load', scope });
        assert.equal(f.held().maxTime, 101);
      } else {
        assert.equal(f.held().maxTime, 110);
        assert.equal(f.db(), undefined);
      }
    }
  }
});

test('read observations reject malformed and extreme clocks before any SQL change or anchor ACK', (t) => {
  for (const operation of ['load', 'load-reference', 'inspect']) {
    const f = fixture(t);
    f.save();
    const before = f.bytes(),
      revision = f.revision();
    for (const value of [-1, 99, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      f.setTime(value);
      assert.throws(
        () => f.execute(operation === 'inspect' ? { operation } : { operation, scope }),
        safe
      );
      assert.equal(f.revision(), revision);
      assert.deepEqual(f.bytes(), before);
    }
    f.setTime(110);
    assert.throws(() => f.execute({ operation, scope: 'invalid' }), safe);
    assert.equal(f.revision(), revision);
    assert.deepEqual(f.bytes(), before);
  }
});

test('read observations still authenticate corrupted records, including expired originals', (t) => {
  for (const operation of ['load', 'load-reference', 'inspect']) {
    for (const expired of [false, true]) {
      const f = fixture(t),
        state = f.save();
      f.db().prepare('UPDATE recovery_state SET envelope=zeroblob(length(envelope))').run();
      const attacked = f.bytes(),
        revision = f.revision();
      f.setTime(expired ? state.root.expiresAt : 110);
      assert.throws(
        () => f.execute(operation === 'inspect' ? { operation } : { operation, scope }),
        safe
      );
      assert.equal(f.revision(), revision);
      assert.deepEqual(fs.readFileSync(f.file), attacked);
      f.close();
      assert.throws(() => f.open(), safe);
      f.close();
      assert.deepEqual(fs.readFileSync(f.file), attacked);
    }
  }
});

for (const operation of ['catalog', 'sweep']) {
  test(
    'anchored no-op ' + operation + ' preserves SQL bytes while durably advancing the exact clock',
    (t) => {
      for (const output of ['', 'synthetic-maintenance中文🙂', 'x'.repeat(16384)]) {
        const f = fixture(t),
          state = f.save(output),
          before = f.bytes(),
          revision = f.revision();
        f.setTime(110);
        f.commits.length = 0;
        const result = f.execute({ operation });
        if (operation === 'catalog') {
          assert.equal(result.length, 1);
          assert.equal(result[0].expiresAt, state.root.expiresAt);
        } else assert.deepEqual(result, { removedRecords: 0, removedBytes: 0 });
        assert.equal(f.bytes().equals(before), true);
        assert.equal(f.sqlTime(), 100);
        assert.equal(f.held().maxTime, 110);
        assert.equal(f.revision(), revision + 1);
        assert.equal(f.commits.length, 2);
        assert.equal(
          f.commits.some((entry) => entry.journalPresent),
          false
        );
        assert.equal(f.db().prepare('PRAGMA synchronous').get().synchronous, 2);
        assert.equal(f.db().prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
        assert.equal(f.db().prepare('PRAGMA secure_delete').get().secure_delete, 1);
        f.close();
        f.open();
        assert.equal(f.sqlTime(), 100);
        assert.equal(f.held().maxTime, 110);
        assert.equal(f.execute({ operation: 'load', scope }).expiresAt, state.root.expiresAt);
      }
    }
  );
}

test('empty maintenance keeps its independent anchor ACK while legacy mode retains SQL clock persistence', (t) => {
  for (const operation of ['catalog', 'sweep'])
    for (const mode of [false, true]) {
      const f = fixture(t, mode),
        before = f.bytes(),
        revision = f.revision();
      f.setTime(110);
      f.commits.length = 0;
      assert.deepEqual(
        f.execute({ operation }),
        operation === 'catalog' ? [] : { removedRecords: 0, removedBytes: 0 }
      );
      assert.equal(f.bytes().equals(before), mode);
      assert.equal(f.sqlTime(), mode ? 100 : 110);
      assert.equal(f.held().maxTime, 110);
      assert.equal(f.revision(), revision + 1);
      assert.equal(f.commits[0].journalPresent, !mode);
      assert.equal(f.commits[1].journalPresent, false);
      f.close();
      f.open();
      assert.equal(f.sqlTime(), mode ? 100 : 110);
      assert.equal(f.held().maxTime, 110);
    }
});

test('maintenance expiry deletion and clock remain atomic under FULL/DELETE, including failed COMMIT', (t) => {
  for (const operation of ['catalog', 'sweep'])
    for (const commitFailure of [false, true]) {
      const f = fixture(t),
        state = f.save(),
        before = f.bytes(),
        revision = f.revision();
      f.setTime(state.root.expiresAt);
      f.commits.length = 0;
      if (commitFailure) {
        f.failCommit();
        assert.throws(() => f.execute({ operation }), safe);
        assert.equal(f.bytes().equals(before), true);
        assert.equal(f.sqlTime(), 100);
        assert.equal(f.revision(), revision);
        assert.equal(f.db().prepare('SELECT count(*) AS n FROM recovery_state').get().n, 1);
        assert.equal(f.db().prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 1);
        f.close();
        f.setTime(110);
        f.open();
        assert.equal(f.execute({ operation: 'load', scope }).expiresAt, state.root.expiresAt);
      } else {
        const result = f.execute({ operation });
        if (operation === 'catalog') assert.deepEqual(result, []);
        else {
          assert.equal(result.removedRecords, 1);
          assert.ok(result.removedBytes > 0);
        }
        assert.equal(f.bytes().equals(before), false);
        assert.equal(f.sqlTime(), state.root.expiresAt);
        assert.equal(f.held().maxTime, state.root.expiresAt);
        assert.equal(f.revision(), revision + 1);
        assert.equal(f.commits[0].journalPresent, true);
        assert.equal(f.db().prepare('SELECT count(*) AS n FROM recovery_state').get().n, 0);
        assert.equal(f.db().prepare('SELECT count(*) AS n FROM recovery_blob').get().n, 0);
        f.close();
        f.open();
        assert.deepEqual(f.execute({ operation: 'catalog' }), []);
      }
    }
});

test('no-op maintenance refuses failed COMMIT or lost native ACK without advancing an uncommitted floor', (t) => {
  for (const operation of ['catalog', 'sweep'])
    for (const failure of ['commit', 'before', 'after']) {
      const f = fixture(t);
      f.save();
      const before = f.bytes(),
        revision = f.revision();
      f.setTime(110);
      if (failure === 'commit') f.failCommit();
      else f.failAnchor(failure);
      assert.throws(() => f.execute({ operation }), safe);
      assert.equal(fs.readFileSync(f.file).equals(before), true);
      if (failure === 'commit') {
        assert.equal(f.revision(), revision);
        f.setTime(101);
        f.execute({ operation });
        assert.equal(f.held().maxTime, 101);
      } else {
        assert.equal(f.db(), undefined);
        assert.equal(f.revision(), revision + (failure === 'after' ? 1 : 0));
        assert.equal(f.held().maxTime, failure === 'after' ? 110 : 100);
      }
    }
});

test('maintenance rejects invalid, extreme and backward clocks without SQL changes or anchor ACK', (t) => {
  for (const operation of ['catalog', 'sweep']) {
    const f = fixture(t);
    f.save();
    const before = f.bytes(),
      revision = f.revision();
    for (const time of [-1, 99, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      f.setTime(time);
      assert.throws(() => f.execute({ operation }), safe);
      assert.equal(f.revision(), revision);
      assert.equal(f.bytes().equals(before), true);
    }
    f.setTime(110);
    f.execute({ operation });
    const anchoredRevision = f.revision();
    f.setTime(109);
    assert.throws(() => f.execute({ operation }), safe);
    assert.equal(f.revision(), anchoredRevision);
    assert.equal(f.bytes().equals(before), true);
    f.close();
    assert.throws(() => f.open(), safe);
  }
});

test('maintenance authenticates corrupt roots and blobs before mutation or acknowledgement, even at expiry', (t) => {
  for (const operation of ['catalog', 'sweep'])
    for (const expired of [false, true])
      for (const table of ['recovery_state', 'recovery_blob']) {
        const f = fixture(t),
          state = f.save();
        f.db().exec(
          table === 'recovery_state'
            ? 'UPDATE recovery_state SET envelope=zeroblob(length(envelope))'
            : 'UPDATE recovery_blob SET envelope=zeroblob(length(envelope))'
        );
        const attacked = f.bytes(),
          revision = f.revision();
        f.setTime(expired ? state.root.expiresAt : 110);
        assert.throws(() => f.execute({ operation }), safe);
        assert.equal(f.revision(), revision);
        assert.equal(fs.readFileSync(f.file).equals(attacked), true);
        f.close();
        assert.throws(() => f.open(), safe);
        f.close();
        assert.equal(fs.readFileSync(f.file).equals(attacked), true);
      }
});

for (const populated of [false, true])
  test(
    'anchored snapshots decrypt identical header bytes once per independent readonly transaction: populated=' +
      populated,
    (t) => {
      const f = fixture(t);
      if (populated) f.save('synthetic snapshot original');
      const decode = TextDecoder.prototype.decode;
      let headerOpens = 0;
      t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
        const text = Reflect.apply(decode, this, args);
        const value = JSON.parse(text);
        if (Object.keys(value).sort().join(',') === 'lastTime,schema') headerOpens++;
        return text;
      });
      const before = f.bytes();
      const first = f.snapshot();
      assert.equal(headerOpens, 1);
      assert.deepEqual(f.snapshot(), first);
      assert.equal(headerOpens, 2, 'a later snapshot authenticates independently');
      assert.deepEqual(f.bytes(), before);
      assert.equal(f.db().prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.equal(f.db().prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    }
  );

for (const change of ['envelope', 'store-id', 'schema', 'aliased-ciphertext']) {
  test('snapshot header reuse refuses changed locked bytes or AAD: ' + change, (t) => {
    const f = fixture(t);
    f.save('synthetic original');
    const expected = f.snapshot(),
      before = f.bytes();
    const db = f.db(),
      prepare = db.prepare.bind(db);
    let reads = 0,
      first;
    t.mock.method(db, 'prepare', (sql) => {
      const statement = prepare(sql);
      if (sql !== 'SELECT store_id, envelope FROM recovery_header WHERE singleton=1')
        return statement;
      return {
        get() {
          reads++;
          const row = statement.get();
          if (reads === 1) first = row;
          if (reads === 2) {
            if (change === 'schema') db.exec('PRAGMA user_version=2');
            else if (change === 'store-id') {
              prepare('UPDATE recovery_header SET store_id=? WHERE singleton=1').run(
                'f'.repeat(32)
              );
              return statement.get();
            } else {
              row.envelope[row.envelope.length - 1] ^= 1;
              if (change === 'aliased-ciphertext') {
                first.envelope.set(row.envelope);
                return first;
              }
              return row;
            }
          }
          return row;
        },
      };
    });
    assert.throws(() => f.snapshot(), safe);
    assert.equal(reads, 2);
    assert.deepEqual(f.bytes(), before, 'failed snapshot rolls back injected mutations');
    assert.deepEqual(
      f.snapshot(),
      expected,
      'no authentication result survives the failed transaction'
    );
  });
}

for (const operation of ['catalog', 'sweep', 'save'])
  for (const time of [100, 110])
    test(
      'anchored execution authenticates unchanged locked header once and a replacement independently: ' +
        operation +
        '/' +
        time,
      (t) => {
        const f = fixture(t);
        const decode = TextDecoder.prototype.decode;
        let opens = 0;
        t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
          const text = Reflect.apply(decode, this, args);
          if (Object.keys(JSON.parse(text)).sort().join(',') === 'lastTime,schema') opens++;
          return text;
        });
        f.setTime(time);
        const request =
          operation === 'save'
            ? {
                operation,
                scope,
                expectedRevision: 0,
                expiresAt: 1000,
                state: { text: 'synthetic locked-header' },
              }
            : { operation };
        const before = f.revision();
        f.execute(request);
        assert.equal(
          opens,
          operation === 'save' && time !== 100 ? 3 : 2,
          'execute authenticates its initial header and any replacement; independent snapshot authenticates again'
        );
        assert.equal(f.revision(), before + 1, 'the original anchor ACK remains required');
        const count = opens;
        f.snapshot();
        assert.equal(opens, count + 1, 'no proof survives into a later transaction');
        assert.equal(f.db().prepare('PRAGMA synchronous').get().synchronous, 2);
        assert.equal(f.db().prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      }
    );

for (const read of [2, 3])
  for (const change of ['envelope', 'store-id', 'schema', 'aliased-ciphertext'])
    test(
      'execution header proof refuses changed clock or commit witness: ' + read + '/' + change,
      (t) => {
        const f = fixture(t);
        const before = f.bytes(),
          expected = f.snapshot(),
          revision = f.revision();
        const db = f.db(),
          prepare = db.prepare.bind(db);
        let reads = 0,
          first;
        t.mock.method(db, 'prepare', (sql) => {
          const statement = prepare(sql);
          if (sql !== 'SELECT store_id, envelope FROM recovery_header WHERE singleton=1')
            return statement;
          return {
            get() {
              const row = statement.get();
              reads++;
              if (reads === 1) first = row;
              if (reads === read) {
                if (change === 'schema') db.exec('PRAGMA user_version=2');
                else if (change === 'store-id') {
                  prepare('UPDATE recovery_header SET store_id=? WHERE singleton=1').run(
                    'f'.repeat(32)
                  );
                  return statement.get();
                } else {
                  row.envelope[row.envelope.length - 1] ^= 1;
                  if (change === 'aliased-ciphertext') {
                    first.envelope.set(row.envelope);
                    return first;
                  }
                }
              }
              return row;
            },
          };
        });
        assert.throws(() => f.execute({ operation: 'catalog' }), safe);
        assert.equal(reads, read);
        assert.equal(f.revision(), revision, 'a rejected operation never reaches anchor ACK');
        assert.deepEqual(f.bytes(), before, 'injected mutations roll back');
        assert.deepEqual(f.snapshot(), expected, 'failed transaction proofs are discarded');
      }
    );
