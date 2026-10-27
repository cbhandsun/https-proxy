'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { waitForFixtureSignal } = require('./helpers/fixture-phase-wait.cjs');
const {
  createPublicationSqlProgress,
  observePublicationSql,
} = require('./helpers/publication-sql-progress.cjs');
const CLOCK = 'UPDATE recovery_header SET envelope=? WHERE singleton=1';
const sample = (sequence = 1, status = 'started', elapsedMs = 0) => ({
  sequence,
  phase: 'commit',
  status,
  elapsedMs,
});
test('SQL progress retains a bounded pending/returned history without ACK or private values', () => {
  const progress = createPublicationSqlProgress();
  assert.deepEqual(progress.snapshot(), []);
  assert.equal(progress.describe(), null);
  for (let i = 1; i <= 512; i++) {
    progress.observe(sample(i, 'started', i));
    progress.observe(sample(i, 'returned', i));
  }
  assert.equal(progress.snapshot().length, 32);
  assert.equal(progress.describe().sequence, 512);
  progress.snapshot()[0].phase = 'PRIVATE';
  progress.describe().phase = 'PRIVATE';
  assert.equal(progress.describe().phase, 'commit');
  assert.throws(() => progress.observe(sample(513)));
  assert.equal(JSON.stringify(progress.snapshot()).includes('PRIVATE'), false);
});
test('SQL progress rejects invalid, hostile, duplicate, reordered and extreme metadata before hooks', () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('PRIVATE');
  };
  const accessor = Object.defineProperty(sample(), 'phase', { enumerable: true, get: trap });
  for (const input of [
    null,
    [],
    {},
    accessor,
    new Proxy({}, { ownKeys: trap }),
    Object.assign(Object.create({}), sample()),
    { ...sample(), raw: 'PRIVATE' },
    { ...sample(), [Symbol()]: 1 },
    { ...sample(), sequence: 0 },
    { ...sample(), sequence: Number.MAX_SAFE_INTEGER },
    { ...sample(), phase: 'PRIVATE' },
    { ...sample(), status: 'acknowledged' },
    ...[-1, NaN, Infinity, 60001].map((elapsedMs) => ({ ...sample(), elapsedMs })),
  ])
    assert.throws(
      () => createPublicationSqlProgress().observe(input),
      /publication_sql_progress_invalid/
    );
  const p = createPublicationSqlProgress();
  assert.throws(() => p.observe(sample(1, 'returned')));
  p.observe(sample());
  for (const input of [sample(), sample(2), { ...sample(1, 'returned'), phase: 'rollback' }])
    assert.throws(() => p.observe(input));
  p.observe(sample(1, 'threw', 4));
  assert.throws(() => p.observe(sample(2, 'started', 3)));
  assert.equal(hooks, 0);
});
test('SQL adapter preserves receivers, argument and return/error identities without forwarding SQL to diagnostics', () => {
  const events = [],
    calls = [],
    result = {},
    privateError = Error('PRIVATE');
  let clock = 0;
  const statement = {
    run(...args) {
      assert.equal(this, statement);
      calls.push(args);
      return result;
    },
  };
  const db = {
    exec(...args) {
      assert.equal(this, db);
      calls.push(args);
      if (args[0] === 'ROLLBACK') throw privateError;
      return result;
    },
    prepare(...args) {
      assert.equal(this, db);
      calls.push(args);
      return statement;
    },
  };
  const wrapped = observePublicationSql(
    db,
    (event) => events.push(event),
    () => clock++
  );
  assert.equal(wrapped.exec('COMMIT'), result);
  assert.equal(wrapped.prepare('PRIVATE SQL'), statement);
  const values = [Buffer.from('PRIVATE'), { secret: 'PRIVATE' }];
  assert.equal(wrapped.prepare(CLOCK).run(...values), result);
  assert.throws(
    () => wrapped.exec('ROLLBACK'),
    (error) => error === privateError
  );
  assert.deepEqual(calls[3], values);
  assert.deepEqual(
    events.map((e) => [e.phase, e.status]),
    [
      ['commit', 'started'],
      ['commit', 'returned'],
      ['clock-write', 'started'],
      ['clock-write', 'returned'],
      ['rollback', 'started'],
      ['rollback', 'threw'],
    ]
  );
  for (const event of events) {
    assert.deepEqual(Object.keys(event), ['sequence', 'phase', 'status', 'elapsedMs']);
    assert.ok(Object.isFrozen(event));
  }
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
});
test('actual file SQLite retains FULL/DELETE writes, COMMIT results and independent readback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-sql-progress-')),
    file = path.join(root, 'checkpoint.sqlite');
  const db = new DatabaseSync(file),
    events = [];
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    'PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;CREATE TABLE recovery_header(singleton INTEGER PRIMARY KEY,envelope BLOB);INSERT INTO recovery_header VALUES(1,NULL)'
  );
  const wrapped = observePublicationSql(
    { exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) },
    (event) => events.push(event)
  );
  wrapped.exec('BEGIN IMMEDIATE');
  assert.equal(wrapped.prepare(CLOCK).run(Buffer.from('PRIVATE')).changes, 1);
  wrapped.exec('COMMIT');
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      Buffer.from(reader.prepare('SELECT envelope FROM recovery_header').get().envelope).toString(),
      'PRIVATE'
    );
  } finally {
    reader.close();
  }
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.deepEqual(
    events.map((e) => e.phase),
    ['begin-write', 'begin-write', 'clock-write', 'clock-write', 'commit', 'commit']
  );
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
});
test('observer failure and a rejected native Promise never repeat, await or alter SQL', async () => {
  let hooks = 0;
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      hooks++;
      throw Error('PRIVATE');
    },
  });
  for (const emit of [
    () => {
      throw Error('PRIVATE');
    },
    () => Promise.reject(Error('PRIVATE')),
    () => thenable,
  ]) {
    let calls = 0;
    const result = {};
    const wrapped = observePublicationSql(
      {
        exec() {
          calls++;
          return result;
        },
        prepare() {
          return {
            run() {
              calls++;
              return result;
            },
          };
        },
      },
      emit
    );
    assert.equal(wrapped.exec('COMMIT'), result);
    assert.equal(wrapped.prepare(CLOCK).run('PRIVATE'), result);
    assert.equal(calls, 2);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks, 0);
});
test('invalid fixture capabilities and statement accessors are refused without executing hooks', () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('PRIVATE');
  };
  for (const db of [
    null,
    {},
    [],
    { exec: () => {}, prepare: () => {}, extra: true },
    new Proxy({}, { ownKeys: trap }),
    { exec: new Proxy(() => {}, { apply: trap }), prepare: () => {} },
    Object.defineProperty({ prepare() {} }, 'exec', { get: trap, enumerable: true }),
    {
      async exec() {
        hooks++;
      },
      prepare() {},
    },
  ])
    assert.throws(() => observePublicationSql(db, () => {}));
  const wrapped = observePublicationSql(
    {
      exec() {},
      prepare() {
        return Object.defineProperty({}, 'run', { get: trap });
      },
    },
    () => {}
  );
  assert.throws(() => wrapped.prepare(CLOCK));
  assert.equal(hooks, 0);
  for (const now of [() => NaN, () => Infinity, () => -1])
    assert.throws(() => observePublicationSql({ exec() {}, prepare() {} }, () => {}, now));
});
test('a later broken diagnostic clock cannot prevent the original SQL call or error', () => {
  let clock = 0,
    calls = 0;
  const result = {};
  const failure = Error('PRIVATE');
  const wrapped = observePublicationSql(
    {
      exec(sql) {
        calls++;
        if (sql === 'ROLLBACK') throw failure;
        return result;
      },
      prepare() {},
    },
    () => {},
    () => (clock++ === 0 ? 0 : NaN)
  );
  assert.equal(wrapped.exec('COMMIT'), result);
  assert.throws(
    () => wrapped.exec('ROLLBACK'),
    (error) => error === failure
  );
  assert.equal(calls, 2);
  let hooks = 0,
    sampled = false;
  const invalid = Object.defineProperty({}, Symbol.toPrimitive, {
    get() {
      hooks++;
      throw Error('PRIVATE');
    },
  });
  const other = observePublicationSql(
    { exec: () => result, prepare() {} },
    () => {},
    () => {
      if (!sampled) {
        sampled = true;
        return 0;
      }
      return invalid;
    }
  );
  assert.equal(other.exec('COMMIT'), result);
  assert.equal(hooks, 0);
});

test(
  'COMMIT-start observation arrives while an actual SQLite writer is blocked, before release or return',
  { timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-sql-progress-block-')),
      file = path.join(root, 'checkpoint.sqlite');
    const bootstrap = new DatabaseSync(file);
    bootstrap.exec(
      'PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;CREATE TABLE recovery_header(singleton INTEGER PRIMARY KEY,envelope BLOB);INSERT INTO recovery_header VALUES(1,NULL);CREATE TABLE recovery_state(revision INTEGER);INSERT INTO recovery_state VALUES(1)'
    );
    bootstrap.close();
    const probe = new DatabaseSync(file, { readOnly: true });
    probe.exec('PRAGMA busy_timeout=0');
    const owned = { child: null, exited: null };
    let terminal,
      spawnFailed = false;
    const reader = fork(path.join(__dirname, 'helpers/context-recovery-commit-reader.cjs'), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    reader.stderr.resume();
    const readerMessages = [];
    reader.on('message', (event) => readerMessages.push(event.phase));
    const track = (process) =>
      new Promise((resolve) => {
        process.once('exit', (code, signal) => resolve({ code, signal }));
        process.once('error', () => {
          spawnFailed = true;
          resolve({ code: null, signal: 'spawn' });
        });
      });
    const readerExited = track(reader);
    t.after(async () => {
      if (owned.child && owned.child.exitCode === null && owned.child.signalCode === null)
        owned.child.kill('SIGKILL');
      if (reader.exitCode === null && reader.signalCode === null) reader.kill('SIGKILL');
      await Promise.all([readerExited, ...(owned.exited ? [owned.exited] : [])]);
      probe.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    reader.send({ file });
    let deadline = performance.now() + 5000;
    while (!readerMessages.includes('reader-held')) {
      assert.equal(spawnFailed, false);
      assert.equal(readerMessages.includes('reader-failed'), false);
      assert.equal(reader.exitCode, null);
      assert.equal(reader.signalCode, null);
      assert.ok(performance.now() < deadline);
      await waitForFixtureSignal(reader, Math.max(0, deadline - performance.now()));
    }
    const child = fork(path.join(__dirname, 'helpers/publication-sql-block.cjs'), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child.stderr.resume();
    const exited = track(child);
    owned.child = child;
    owned.exited = exited;
    const progress = createPublicationSqlProgress();
    child.on('message', (event) => {
      if (event.kind === 'progress') progress.observe(event.progress);
      else if (event.kind === 'done') terminal = event;
    });
    child.send({ file });
    deadline = performance.now() + 5000;
    while (
      !progress.snapshot().some((event) => event.phase === 'commit' && event.status === 'started')
    ) {
      assert.equal(spawnFailed, false);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.ok(
        performance.now() < deadline,
        'COMMIT start must arrive inside the original five-second readiness bound'
      );
      await waitForFixtureSignal(child, Math.max(0, deadline - performance.now()));
    }
    const pendingDeadline = performance.now() + 750;
    let blocked = false;
    while (!blocked && performance.now() < pendingDeadline) {
      try {
        probe.prepare('SELECT * FROM recovery_header').get();
      } catch (error) {
        if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 5) throw error;
        blocked = true;
      }
      if (!blocked) await nextTurn();
    }
    assert.equal(blocked, true, 'independent read admission proves actual PENDING before release');
    assert.equal(child.exitCode, null);
    assert.equal(terminal, undefined);
    assert.equal(progress.describe().status, 'started');
    assert.equal(progress.describe().phase, 'commit');
    reader.send({ operation: 'release' });
    let timeout;
    const results = await Promise.race([
      Promise.all([exited, readerExited]),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(Error('sql_progress_child_exit_deadline')), 5000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(results, [
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    assert.deepEqual(terminal, { kind: 'done', committed: true, busy: false });
    assert.equal(progress.describe().status, 'returned');
  }
);
