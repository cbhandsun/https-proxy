'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  runLegacyAnchorEnrollment: enroll,
} = require('../lib/proxy/context-recovery-anchor-legacy-owner');
const { createStoragePaths } = require('../lib/proxy/context-recovery-storage-paths');
const { createStorageOwner } = require('../lib/proxy/context-recovery-storage-owner');
const {
  createRecoverySqliteStore,
  inspectRecoverySqliteSnapshot,
} = require('../lib/proxy/context-recovery-storage-sqlite');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');
const {
  createSyntheticRetainedAnchorFactory,
} = require('./helpers/recovery-anchor-repository.cjs');
const scope = 'a'.repeat(64);
const {
  executeLegacyEnrollmentCommand,
} = require('../lib/proxy/context-recovery-enrollment-command');
function safe(error) {
  assert.equal(error.message, 'context_recovery_storage_unavailable');
  assert.equal(error.code, error.message);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
function fixture(t, time = 100, ttl = 900) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-legacy-anchor-'));
  const directory = path.join(root, 'store');
  const paths = createStoragePaths(directory);
  const dataKey = randomBytes(32).toString('base64');
  paths.prepare('.writer.sqlite');
  paths.writeKey(KEY_PREFIX + dataKey);
  const file = paths.prepare('checkpoint.sqlite');
  const database = new DatabaseSync(file);
  const store = createRecoverySqliteStore({ database, dataKey, now: () => time });
  store.execute({
    operation: 'save',
    scope,
    expectedRevision: 0,
    expiresAt: time + ttl,
    state: { original: 'PRIVATE legacy content', token: 'PRIVATE synthetic value' },
  });
  store.close();
  database.close();
  const factory = createSyntheticRetainedAnchorFactory();
  const events = [];
  const trusted = {
    protectKey(request) {
      assert.equal(request.operation, 'unprotect');
      events.push('unprotect');
      return request.value.slice(KEY_PREFIX.length);
    },
    createAnchorRepository(input) {
      events.push('repository');
      return factory(input);
    },
    inspectSnapshot(input) {
      events.push('inspect');
      return inspectRecoverySqliteSnapshot(input);
    },
  };
  t.after(() => {
    assert.equal(path.dirname(root), temporary);
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('hpm-legacy-anchor-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    directory,
    paths,
    file,
    dataKey,
    factory,
    trusted,
    events,
    run: (input = { directory }, extra = {}) => enroll(input, { ...trusted, ...extra }),
    mutate(sql) {
      const db = new DatabaseSync(file);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    },
  };
}

test('offline command previews and enrolls the real encrypted SQLite snapshot without changing its bytes', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const run = (input) => f.run(input);
  const args = ['preview', '--directory', f.directory];
  const preview = executeLegacyEnrollmentCommand(args, run);
  assert.equal(preview.exitCode, 0);
  const receipt = JSON.parse(preview.stdout);
  assert.deepEqual(Object.keys(receipt), ['fingerprint', 'scopeCount', 'maxTime']);
  assert.equal(receipt.scopeCount, 1);
  assert.equal(preview.stdout.includes('PRIVATE'), false);
  assert.equal(preview.stdout.includes(f.directory), false);
  const result = executeLegacyEnrollmentCommand(
    ['enroll', '--directory', f.directory, '--fingerprint', receipt.fingerprint],
    run
  );
  assert.deepEqual(result, { exitCode: 0, stdout: '{"enrolled":true}\n', stderr: '' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(executeLegacyEnrollmentCommand(args, run).exitCode, 1);
});

test('enrolled legacy checkpoint reopens through the production owner and retains revision, expiry and revocation floors', (t) => {
  const time = Date.now();
  const f = fixture(t, time, 60000);
  const run = (input) => f.run(input);
  const preview = executeLegacyEnrollmentCommand(['preview', '--directory', f.directory], run);
  assert.equal(preview.exitCode, 0);
  const fingerprint = JSON.parse(preview.stdout).fingerprint;
  assert.equal(
    executeLegacyEnrollmentCommand(
      ['enroll', '--directory', f.directory, '--fingerprint', fingerprint],
      run
    ).exitCode,
    0
  );
  const owners = [];
  const open = () => {
    const owner = createStorageOwner(
      { directory: f.directory, protectKey: f.trusted.protectKey },
      {
        createAnchorRepository: f.trusted.createAnchorRepository,
      }
    );
    owners.push(owner);
    return owner;
  };
  try {
    const first = open();
    const record = first.execute({ operation: 'load', scope });
    assert.equal(record.revision, 1);
    assert.equal(record.expiresAt, time + 60000);
    assert.deepEqual(
      { ...record.state },
      {
        original: 'PRIVATE legacy content',
        token: 'PRIVATE synthetic value',
      }
    );
    assert.deepEqual(
      first.execute({
        operation: 'save',
        scope,
        expectedRevision: 1,
        expiresAt: record.expiresAt,
        state: record.state,
      }),
      { revision: 2 }
    );
    first.close();
    const second = open();
    const updated = second.execute({ operation: 'load', scope });
    assert.equal(updated.revision, 2);
    assert.equal(updated.expiresAt, record.expiresAt);
    assert.deepEqual({ ...updated.state }, { ...record.state });
    const beforeRevocation = fs.readFileSync(f.file);
    second.execute({ operation: 'revoke', scope, expectedRevision: 2 });
    second.close();
    const revoked = open();
    assert.equal(revoked.execute({ operation: 'load', scope }), null);
    revoked.close();
    fs.writeFileSync(f.file, beforeRevocation);
    assert.throws(open, safe);
    assert.deepEqual(fs.readFileSync(f.file), beforeRevocation);
  } finally {
    for (const owner of owners) owner.close();
  }
});

test('enrolling an expired legacy checkpoint cannot renew its lifetime on normal owner startup', (t) => {
  const f = fixture(t);
  const preview = f.run();
  assert.deepEqual(f.run({ directory: f.directory, expectedFingerprint: preview.fingerprint }), {
    enrolled: true,
  });
  const owner = createStorageOwner(
    { directory: f.directory, protectKey: f.trusted.protectKey },
    {
      createAnchorRepository: f.trusted.createAnchorRepository,
    }
  );
  try {
    assert.equal(owner.execute({ operation: 'load', scope }), null);
    assert.deepEqual(owner.execute({ operation: 'catalog' }), []);
  } finally {
    owner.close();
  }
});

test('a sealed modern store with a missing anchor cannot be re-enrolled through legacy preview or approval', (t) => {
  const f = fixture(t);
  const prior = f.run();
  const database = new DatabaseSync(f.file);
  const store = createRecoverySqliteStore({ database, dataKey: f.dataKey, now: () => 100 });
  try {
    store.prepareAnchoredFormat();
  } finally {
    store.close();
    database.close();
  }
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.run(), safe);
  assert.throws(
    () => f.run({ directory: f.directory, expectedFingerprint: prior.fingerprint }),
    safe
  );
  assert.deepEqual(fs.readFileSync(f.file), before);
  const repository = f.factory({ directory: f.directory, dataKey: f.dataKey });
  try {
    assert.equal(repository.read(), null);
  } finally {
    repository.close();
  }
});

test('legacy preview exposes exactly four frozen fields and apply requires a fresh locked inspection', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const preview = f.run();
  assert.deepEqual(Object.keys(preview), ['fingerprint', 'storeId', 'scopeCount', 'maxTime']);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(preview.scopeCount, 1);
  assert.equal(preview.maxTime, 100);
  assert.ok(Object.isFrozen(preview));
  assert.equal(JSON.stringify(preview).includes('PRIVATE'), false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const result = f.run({ directory: f.directory, expectedFingerprint: preview.fingerprint });
  assert.deepEqual(result, { enrolled: true });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.events, [
    'unprotect',
    'repository',
    'inspect',
    'unprotect',
    'repository',
    'inspect',
  ]);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.throws(() => f.run(), safe);
});

test('changed authenticated snapshot invalidates a prior preview without committing', (t) => {
  const f = fixture(t);
  const preview = f.run();
  const db = new DatabaseSync(f.file);
  const store = createRecoverySqliteStore({ database: db, dataKey: f.dataKey, now: () => 200 });
  store.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  store.close();
  db.close();
  assert.throws(
    () => f.run({ directory: f.directory, expectedFingerprint: preview.fingerprint }),
    safe
  );
  const fresh = f.run();
  assert.notEqual(fresh.fingerprint, preview.fingerprint);
  assert.deepEqual(f.run({ directory: f.directory, expectedFingerprint: fresh.fingerprint }), {
    enrolled: true,
  });
});

test('lifetime writer contention refuses inspection then releases cleanly for retry', (t) => {
  const f = fixture(t);
  const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  mutex.exec('BEGIN EXCLUSIVE');
  try {
    assert.throws(() => f.run(), safe);
  } finally {
    mutex.exec('ROLLBACK');
    mutex.close();
  }
  assert.deepEqual(f.events, []);
  assert.equal(f.run().scopeCount, 1);
});

for (const missing of ['checkpoint.sqlite', '.data-key', '.writer.sqlite'])
  test('missing existing legacy file is refused without replacement: ' + missing, (t) => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.directory, missing));
    assert.throws(() => f.run(), safe);
    assert.equal(fs.existsSync(path.join(f.directory, missing)), false);
    assert.deepEqual(f.events, []);
  });

test('missing legacy directory is refused without creating a runtime directory', (t) => {
  const f = fixture(t);
  const directory = path.join(f.root, 'absent');
  assert.throws(() => f.run({ directory }), safe);
  assert.equal(fs.existsSync(directory), false);
});

for (const sql of [
  'UPDATE recovery_state SET revision=revision+1',
  'UPDATE recovery_header SET envelope=randomblob(length(envelope))',
  'UPDATE recovery_state SET envelope=randomblob(length(envelope))',
])
  test('tampered legacy state is refused with no enrollment', (t) => {
    const f = fixture(t);
    f.mutate(sql);
    const before = fs.readFileSync(f.file);
    assert.throws(() => f.run(), safe);
    assert.deepEqual(fs.readFileSync(f.file), before);
    const repository = f.factory({ directory: f.directory, dataKey: f.dataKey });
    assert.equal(repository.read(), null);
    repository.close();
  });

test('input and trusted dependencies reject getters, proxies, async functions and caller snapshots', (t) => {
  const f = fixture(t);
  let touched = 0;
  const getter = Object.defineProperty({ directory: f.directory }, 'expectedFingerprint', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        throw Error('PRIVATE');
      },
      getPrototypeOf() {
        touched++;
        throw Error('PRIVATE');
      },
    }
  );
  for (const input of [
    getter,
    proxy,
    { directory: f.directory, snapshot: {} },
    ...[undefined, null, 1, '', 'A'.repeat(64), 'a'.repeat(64) + '\n'].map(
      (expectedFingerprint) => ({ directory: f.directory, expectedFingerprint })
    ),
  ])
    assert.throws(() => f.run(input), safe);
  for (const name of ['protectKey', 'createAnchorRepository', 'inspectSnapshot']) {
    assert.throws(() => f.run({ directory: f.directory }, { [name]: async () => {} }), safe);
    const trustedGetter = Object.defineProperty({ ...f.trusted }, name, {
      enumerable: true,
      get() {
        touched++;
        throw Error('PRIVATE');
      },
    });
    assert.throws(() => enroll({ directory: f.directory }, trustedGetter), safe);
  }
  assert.equal(touched, 0);
  assert.deepEqual(f.events, []);
});

for (const receipt of [
  null,
  {},
  { revision: 0 },
  { revision: 2 },
  { revision: 1, extra: true },
  Promise.resolve({ revision: 1 }),
])
  test('apply requires a strict synchronous CAS zero revision-one receipt', (t) => {
    const f = fixture(t);
    const preview = f.run();
    assert.throws(
      () =>
        f.run(
          { directory: f.directory, expectedFingerprint: preview.fingerprint },
          {
            createAnchorRepository(input) {
              const repository = f.factory(input);
              return {
                ...repository,
                commit() {
                  return receipt;
                },
              };
            },
          }
        ),
      safe
    );
  });

test('receipt getters and proxies never execute', (t) => {
  const f = fixture(t);
  const preview = f.run();
  let touched = 0;
  for (const receipt of [
    Object.defineProperty({}, 'revision', {
      enumerable: true,
      get() {
        touched++;
        return 1;
      },
    }),
    new Proxy(
      {},
      {
        ownKeys() {
          touched++;
          return [];
        },
      }
    ),
  ])
    assert.throws(
      () =>
        f.run(
          { directory: f.directory, expectedFingerprint: preview.fingerprint },
          {
            createAnchorRepository(input) {
              const repository = f.factory(input);
              return {
                ...repository,
                commit() {
                  return receipt;
                },
              };
            },
          }
        ),
      safe
    );
  assert.equal(touched, 0);
});

test('repository close failure prevents success but retains a committed anchor and releases writer lock', (t) => {
  const f = fixture(t);
  const preview = f.run();
  assert.throws(
    () =>
      f.run(
        { directory: f.directory, expectedFingerprint: preview.fingerprint },
        {
          createAnchorRepository(input) {
            const repository = f.factory(input);
            return {
              ...repository,
              close() {
                repository.close();
                throw new Error('PRIVATE cleanup');
              },
            };
          },
        }
      ),
    safe
  );
  const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  try {
    mutex.exec('BEGIN EXCLUSIVE; ROLLBACK');
  } finally {
    mutex.close();
  }
  const repository = f.factory({ directory: f.directory, dataKey: f.dataKey });
  assert.notEqual(repository.read(), null);
  repository.close();
  assert.throws(() => f.run(), safe);
});

test('database cleanup failure still closes repository and releases the lifetime writer', (t) => {
  const f = fixture(t);
  let repositoryClosed = false;
  assert.throws(
    () =>
      f.run(
        { directory: f.directory },
        {
          createAnchorRepository(input) {
            const repository = f.factory(input);
            return {
              ...repository,
              close() {
                repositoryClosed = true;
                repository.close();
              },
            };
          },
          inspectSnapshot(input) {
            const metadata = inspectRecoverySqliteSnapshot(input);
            const close = input.database.close.bind(input.database);
            input.database.close = () => {
              close();
              throw new Error('PRIVATE database cleanup');
            };
            return metadata;
          },
        }
      ),
    safe
  );
  assert.equal(repositoryClosed, true);
  assert.equal(f.run().scopeCount, 1);
});

test('existing-only pins never create and detect replacement of the secured inode', (t) => {
  const f = fixture(t);
  const paths = createStoragePaths(f.directory);
  assert.throws(() => paths.pinExisting('checkpoint.sqlite-journal'), safe);
  assert.equal(fs.existsSync(path.join(f.directory, 'checkpoint.sqlite-journal')), false);
  const pinned = paths.pinExisting('checkpoint.sqlite');
  const backup = path.join(f.root, 'backup.sqlite');
  fs.renameSync(pinned, backup);
  fs.copyFileSync(backup, pinned);
  assert.throws(() => paths.verify(), safe);
});

test('inspection uses a readonly database while the lifetime writer stays locked', (t) => {
  const f = fixture(t);
  const preview = f.run(
    { directory: f.directory },
    {
      inspectSnapshot(input) {
        assert.throws(
          () => input.database.exec('UPDATE recovery_state SET revision=2'),
          /readonly/i
        );
        const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
        try {
          assert.throws(() => mutex.exec('BEGIN EXCLUSIVE'), /locked/i);
        } finally {
          mutex.close();
        }
        return inspectRecoverySqliteSnapshot(input);
      },
    }
  );
  assert.equal(preview.scopeCount, 1);
});
