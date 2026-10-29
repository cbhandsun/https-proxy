'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRecoveryStartupSqlProgress,
} = require('../lib/proxy/context-recovery-startup-sql-progress');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const CLOCK_SQL = 'UPDATE recovery_header SET envelope=? WHERE singleton=1';

function fixture(onPhase) {
  const events = [];
  const calls = [];
  const result = {};
  const statement = {
    run(...args) {
      assert.equal(this, statement);
      calls.push(['run', args]);
      return result;
    },
    all(...args) {
      assert.equal(this, statement);
      calls.push(['all', args]);
      return result;
    },
    get(...args) {
      assert.equal(this, statement);
      calls.push(['get', args]);
      return result;
    },
    iterate(...args) {
      assert.equal(this, statement);
      calls.push(['iterate', args]);
      return result;
    },
    setReadBigInts(...args) {
      assert.equal(this, statement);
      calls.push(['setReadBigInts', args]);
      return result;
    },
    columns(...args) {
      assert.equal(this, statement);
      calls.push(['columns', args]);
      return result;
    },
  };
  const database = {
    exec(...args) {
      assert.equal(this, database);
      calls.push(['exec', args]);
      return result;
    },
    prepare(...args) {
      assert.equal(this, database);
      calls.push(['prepare', args]);
      return statement;
    },
    close(...args) {
      assert.equal(this, database);
      calls.push(['close', args]);
      return result;
    },
  };
  const observer = createRecoveryStartupSqlProgress(
    database,
    onPhase ?? ((phase) => events.push(phase))
  );
  return { observer, database, statement, result, calls, events };
}

test('only the armed startup interval reports fixed header writes and the first COMMIT', () => {
  const f = fixture();
  const db = f.observer.database;
  assert.equal(db.prepare(CLOCK_SQL), f.statement);
  db.exec('COMMIT');
  assert.deepEqual(f.events, []);
  f.observer.start();
  db.prepare('SELECT 1').run('PRIVATE_SELECT');
  db.prepare(CLOCK_SQL).run('PRIVATE_KEY');
  db.exec('COMMIT');
  db.exec('COMMIT');
  f.observer.finish();
  f.observer.start();
  db.prepare(CLOCK_SQL).run('PRIVATE_LATE');
  db.exec('COMMIT');
  assert.deepEqual(f.events, [
    'engine_sql_clock_write_1_started',
    'engine_sql_clock_write_1_finished',
    'engine_sql_commit_started',
    'engine_sql_commit_finished',
  ]);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|SELECT|envelope/);
});

test('clock writes are capped at four, overflow is reported once, and all SQL still executes', () => {
  const f = fixture();
  f.observer.start();
  const statement = f.observer.database.prepare(CLOCK_SQL);
  for (let i = 0; i < 1000; i++) statement.run(i);
  assert.equal(f.calls.filter(([name]) => name === 'run').length, 1000);
  assert.equal(f.events.length, 9);
  assert.equal(f.events.at(-1), 'engine_sql_clock_write_overflow');
  assert.equal(f.events.filter((phase) => phase.endsWith('_started')).length, 4);
});

test('database and statement operations forward the original receiver, exact arguments and result', () => {
  const f = fixture();
  const args = [{ private: true }, undefined, Buffer.from('PRIVATE')];
  f.observer.start();
  const statement = f.observer.database.prepare(CLOCK_SQL, ...args);
  for (const name of ['run', 'all', 'get', 'iterate', 'setReadBigInts', 'columns']) {
    assert.equal(statement[name](...args), f.result);
    assert.deepEqual(f.calls.at(-1), [name, args]);
  }
  assert.equal(f.observer.database.exec('COMMIT', ...args), f.result);
  assert.equal(f.observer.database.close(...args), f.result);
  f.observer.finish();
  const count = f.events.length;
  assert.equal(statement.run(...args), f.result);
  assert.equal(f.events.length, count);
});

test('SQL exceptions keep their identity and never produce a finished phase or ACK', () => {
  for (const operation of ['exec', 'run']) {
    const events = [];
    const error = Error('PRIVATE_SQL_FAILURE');
    const statement = {
      run() {
        throw error;
      },
    };
    const observer = createRecoveryStartupSqlProgress(
      {
        exec() {
          throw error;
        },
        prepare() {
          return statement;
        },
      },
      (phase) => events.push(phase)
    );
    observer.start();
    assert.throws(
      () =>
        operation === 'exec'
          ? observer.database.exec('COMMIT')
          : observer.database.prepare(CLOCK_SQL).run(),
      (value) => value === error
    );
    assert.equal(events.length, 1);
    assert.match(events[0], /_started$/);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|ACK/);
  }
});

test('diagnostic throws, rejected promises and unsafe return hooks never change SQL or execute hooks', async () => {
  let traps = 0;
  for (const callback of [
    () => {
      throw Error('PRIVATE_OBSERVER');
    },
    () => Promise.reject(Error('PRIVATE_REJECTION')),
    () =>
      Object.defineProperty(Promise.reject(Error('PRIVATE_OWN_THEN')), 'then', {
        get() {
          traps++;
          throw Error('PRIVATE_PROMISE_GETTER');
        },
      }),
    () => ({
      get then() {
        traps++;
        throw Error('PRIVATE_GETTER');
      },
    }),
    undefined,
  ]) {
    const f = fixture(callback);
    if (callback === undefined) {
      const broken = createRecoveryStartupSqlProgress(f.database, undefined);
      broken.start();
      assert.equal(broken.database.exec('COMMIT'), f.result);
    } else {
      f.observer.start();
      assert.equal(f.observer.database.exec('COMMIT'), f.result);
      assert.equal(f.calls.length, 1);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(traps, 0);
});

test('real fresh SQLite keeps both clock checks, one FULL DELETE COMMIT and exact engine results', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hpm-startup-sql-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = new DatabaseSync(path.join(root, 'checkpoint.sqlite'));
  const events = [];
  const observer = createRecoveryStartupSqlProgress(database, (phase) => events.push(phase));
  let time = 100;
  let engine;
  try {
    engine = createRecoverySqliteStore({
      database: observer.database,
      dataKey: Buffer.alloc(32, 4).toString('base64'),
      now: () => time++,
      beforeStartup() {
        observer.start();
      },
    });
  } finally {
    observer.finish();
  }
  try {
    assert.equal(time, 102);
    assert.deepEqual(events, [
      'engine_sql_clock_write_1_started',
      'engine_sql_clock_write_1_finished',
      'engine_sql_clock_write_2_started',
      'engine_sql_clock_write_2_finished',
      'engine_sql_commit_started',
      'engine_sql_commit_finished',
    ]);
    assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(database.prepare('PRAGMA secure_delete').get().secure_delete, 1);
    assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    const count = events.length;
    assert.deepEqual(engine.snapshot().scopes, []);
    assert.equal(events.length, count);
  } finally {
    engine?.close();
    database.close();
  }
});

test('finish is permanent even during a callback, and harmless properties and empty prepare results pass through', () => {
  const database = {
    label: 'initial',
    exec() {
      return 3;
    },
    prepare() {
      return null;
    },
  };
  const events = [];
  const observer = createRecoveryStartupSqlProgress(database, (phase) => {
    events.push(phase);
    observer.finish();
  });
  assert.equal(observer.database.label, 'initial');
  observer.database.label = 'updated';
  assert.equal(database.label, 'updated');
  observer.start();
  observer.start();
  assert.equal(observer.database.prepare(CLOCK_SQL), null);
  assert.equal(observer.database.exec('COMMIT'), 3);
  assert.deepEqual(events, ['engine_sql_commit_started']);
  observer.start();
  observer.finish();
  assert.equal(observer.database.exec('COMMIT'), 3);
  assert.equal(events.length, 1);
  const f = fixture();
  f.observer.start();
  const statement = f.observer.database.prepare(CLOCK_SQL);
  statement.label = 'safe';
  assert.equal(statement.label, 'safe');
  assert.equal(f.statement.label, 'safe');
});

test('prepare and unobserved operation failures remain the original exception without fabricated phases', () => {
  const error = Error('PRIVATE_PREPARE_FAILURE');
  const phases = [];
  const observer = createRecoveryStartupSqlProgress(
    {
      prepare() {
        throw error;
      },
      exec() {
        throw error;
      },
    },
    (phase) => phases.push(phase)
  );
  observer.start();
  assert.throws(
    () => observer.database.prepare(CLOCK_SQL),
    (value) => value === error
  );
  assert.throws(
    () => observer.database.exec('BEGIN IMMEDIATE'),
    (value) => value === error
  );
  assert.deepEqual(phases, []);
});
