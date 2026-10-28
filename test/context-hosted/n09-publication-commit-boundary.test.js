'use strict';
// Protocol composition only. Physical SQLite and actual hosted daemon have
// independent gates; these injectable fixtures never grant native qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const {
  createPublicationCommitWitness,
} = require('../../scripts/context-hosted/n09-business/publication-commit-witness');
const schema = require('../../lib/proxy/context-recovery-storage-schema');
const {
  createPreparedCommitBoundary,
} = require('../../scripts/context-hosted/n09-business/publication-commit-boundary');
const config = {
  ownedRoot: os.tmpdir(),
  runtimeDir: path.join(os.tmpdir(), 'runtime'),
  rootId: 'hbs_' + 'a'.repeat(32),
  expiresAt: 10000,
  revision: 4,
};
const baseline = { generation: 1, callOrdinal: 10, activeCount: 0, status: 'completed' };
const state = {
  ...baseline,
  callOrdinal: 11,
  activeCount: 1,
  status: 'pending',
  operation: 'save-reference-state',
  transition: 'prepared',
  rootId: config.rootId,
  expiresAt: config.expiresAt,
  expectedRevision: config.revision,
};
const lock = {
  readAdmissionBlocked: true,
  evidenceLevel: 'sqlite-read-admission-only',
  publicationQualified: false,
};
async function fixture(t, patch = {}, options = {}) {
  let calls = 0,
    closed = 0,
    released = 0;
  const deadlines = [];
  const boundary = await createPreparedCommitBoundary(
    config,
    async (timeout) => {
      deadlines.push(timeout);
      if (++calls === 1) return options.baseline ?? baseline;
      return Object.hasOwn(options, 'reply') ? options.reply : { ...state, ...patch };
    },
    () => ({
      async waitPending() {
        if (options.error) throw Error('PRIVATE');
        return options.lock ?? lock;
      },
      release() {
        released++;
        return { released: true };
      },
      close() {
        closed++;
        if (options.closeError) throw Error('PRIVATE');
      },
    })
  );
  t.after(() => {
    if (options.closeError) assert.throws(() => boundary.close());
    else boundary.close();
  });
  return {
    boundary,
    deadlines,
    calls: () => calls,
    closed: () => closed,
    released: () => released,
  };
}
test('one fresh prepared request plus read admission block uses one original 750ms budget', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.boundary.waitPending()).actualPreparedWritePending, true);
  assert.equal(f.deadlines[0], 750);
  assert.ok(f.deadlines[1] >= 1 && f.deadlines[1] <= 750);
  assert.deepEqual(f.boundary.release(), { released: true });
  assert.equal(f.released(), 1);
  await assert.rejects(f.boundary.waitPending());
  assert.throws(() => f.boundary.release());
});
test('BUSY without exact current target, owner, root, expiry and revision never qualifies', async (t) => {
  for (const patch of [
    { transition: 'withdrawn' },
    { transition: 'none' },
    { status: 'completed' },
    { activeCount: 2 },
    { callOrdinal: 10 },
    { generation: 2 },
    { operation: 'other' },
    { rootId: 'hbs_' + 'b'.repeat(32) },
    { expiresAt: 10001 },
    { expectedRevision: 5 },
  ]) {
    const f = await fixture(t, patch);
    await assert.rejects(f.boundary.waitPending());
    assert.equal(f.closed(), 1);
    assert.equal(f.released(), 0);
    await assert.rejects(f.boundary.waitPending());
  }
});
test('lock errors, forged lock scope and cleanup errors fail closed without more queries', async (t) => {
  for (const options of [
    { error: true },
    { lock: { ...lock, publicationQualified: true } },
    { lock: { ...lock, readAdmissionBlocked: false } },
    { error: true, closeError: true },
  ]) {
    const f = await fixture(t, {}, options);
    await assert.rejects(f.boundary.waitPending());
    assert.equal(f.calls(), 1);
    assert.equal(f.closed(), 1);
  }
});
test('empty, invalid and executable metadata reject before getters or thenable hooks', async (t) => {
  let hooks = 0;
  for (const reply of [
    null,
    {},
    new Proxy(state, {
      ownKeys() {
        hooks++;
      },
    }),
    Object.defineProperty({ ...state }, 'status', {
      get() {
        hooks++;
        throw Error('PRIVATE');
      },
    }),
  ]) {
    const f = await fixture(t, {}, { reply });
    await assert.rejects(f.boundary.waitPending());
  }
  const thenable = {
    then() {
      hooks++;
    },
  };
  await assert.rejects(
    createPreparedCommitBoundary(
      config,
      () => thenable,
      () => assert.fail('writer')
    )
  );
  for (const value of [
    null,
    {},
    { ...config, revision: -1 },
    { ...config, expiresAt: Infinity },
    Object.defineProperty({ ...config }, 'rootId', {
      get() {
        hooks++;
        throw Error('PRIVATE');
      },
    }),
  ])
    await assert.rejects(
      createPreparedCommitBoundary(
        value,
        async () => baseline,
        () => assert.fail('writer')
      )
    );
  assert.equal(hooks, 0);
});
test('early close and overlapping wait cannot produce a late successful receipt', async () => {
  let done,
    closed = 0;
  const boundary = await createPreparedCommitBoundary(
    config,
    async () => baseline,
    () => ({
      waitPending: () =>
        new Promise((resolve) => {
          done = resolve;
        }),
      release() {
        return { released: true };
      },
      close() {
        closed++;
      },
    })
  );
  const pending = assert.rejects(boundary.waitPending());
  boundary.close();
  done(lock);
  await pending;
  assert.equal(closed >= 1, true);
  assert.throws(() => boundary.release());
});

test('a late authenticated sample cannot extend the original witness deadline', async () => {
  let calls = 0,
    closed = 0;
  const boundary = await createPreparedCommitBoundary(
    config,
    async () => {
      if (++calls === 1) return baseline;
      await new Promise((resolve) => setTimeout(resolve, 760));
      return state;
    },
    () => ({
      waitPending: async () => lock,
      release() {
        assert.fail('late release');
      },
      close() {
        closed++;
      },
    })
  );
  await assert.rejects(boundary.waitPending());
  assert.equal(closed, 1);
  boundary.close();
});
test('baseline failure rejects before acquiring a physical read lock', async () => {
  for (const value of [
    null,
    {},
    { ...baseline, activeCount: 1 },
    { ...baseline, status: 'failed' },
    { ...baseline, generation: 0 },
    { ...baseline, callOrdinal: -1 },
  ])
    await assert.rejects(
      createPreparedCommitBoundary(
        config,
        async () => value,
        () => assert.fail('physical lock')
      )
    );
});

test('rejected witness shape releases its actual SQLite read lock before rejecting construction', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-rejected-witness-'));
  const runtimeDir = path.join(root, 'runtime'),
    directory = path.join(runtimeDir, 'context-recovery-v1');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.data-key'), 'synthetic-placeholder');
  const database = new DatabaseSync(path.join(directory, 'checkpoint.sqlite'));
  let witness,
    closed = 0;
  t.after(() => {
    witness?.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(
    schema.HEADER_SQL +
      ';' +
      schema.STATE_SQL +
      ';' +
      schema.BLOB_SQL +
      ';PRAGMA application_id=' +
      schema.APPLICATION_ID +
      ';PRAGMA user_version=3;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=0'
  );
  database
    .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
    .run('a'.repeat(64), 4, 1, 10000, 'state', Buffer.from('synthetic'));
  await assert.rejects(
    createPreparedCommitBoundary(
      { ...config, ownedRoot: root, runtimeDir },
      async () => baseline,
      (input) => {
        witness = createPublicationCommitWitness(input);
        return {
          ...witness,
          close() {
            closed++;
            witness.close();
          },
          unexpected: true,
        };
      }
    ),
    /n09_prepared_commit_boundary_failed/
  );
  database.exec('BEGIN IMMEDIATE; UPDATE recovery_state SET revision=5; COMMIT');
  assert.equal(closed, 1);
  assert.equal(database.prepare('SELECT revision FROM recovery_state').get().revision, 5);
});

test('overlapping rejected waits and explicit close invoke a witness close exactly once', async () => {
  let done,
    closed = 0;
  const boundary = await createPreparedCommitBoundary(
    config,
    async () => baseline,
    () => ({
      waitPending: () =>
        new Promise((resolve) => {
          done = resolve;
        }),
      release() {
        return { released: true };
      },
      close() {
        closed++;
      },
    })
  );
  const first = assert.rejects(boundary.waitPending(), /n09_prepared_commit_boundary_failed/);
  await assert.rejects(boundary.waitPending(), /n09_prepared_commit_boundary_failed/);
  done(lock);
  await first;
  boundary.close();
  boundary.close();
  assert.equal(closed, 1);
});

test('malformed witness cleanup never invokes accessors, proxies or inherited capabilities', async () => {
  let hooks = 0;
  const trapped = () => {
    hooks++;
    throw Error('PRIVATE');
  };
  for (const resource of [
    null,
    {},
    [],
    new Proxy({}, { ownKeys: trapped }),
    Object.create({ close: trapped }),
    { close: new Proxy(() => {}, { apply: trapped }) },
    Object.defineProperty({}, 'close', { enumerable: true, get: trapped }),
  ]) {
    await assert.rejects(
      createPreparedCommitBoundary(
        config,
        async () => baseline,
        () => resource
      ),
      /n09_prepared_commit_boundary_failed/
    );
  }
  for (const field of ['waitPending', 'release', 'unexpected']) {
    let closed = 0;
    const resource = {
      waitPending: async () => lock,
      release: () => ({ released: true }),
      close() {
        assert.equal(this, resource);
        closed++;
      },
    };
    Object.defineProperty(resource, field, { enumerable: true, get: trapped });
    await assert.rejects(
      createPreparedCommitBoundary(
        config,
        async () => baseline,
        () => resource
      ),
      /n09_prepared_commit_boundary_failed/
    );
    assert.equal(closed, 1);
  }
  assert.equal(hooks, 0);
});

test('invalid or rejected cleanup results are sticky failures and are never assimilated', async () => {
  let hooks = 0;
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      hooks++;
      throw Error('PRIVATE');
    },
  });
  for (const result of [
    () => false,
    () => null,
    () => 1,
    () => thenable,
    () => Promise.reject(Error('PRIVATE')),
  ]) {
    let closed = 0;
    const boundary = await createPreparedCommitBoundary(
      config,
      async () => baseline,
      () => ({
        waitPending: async () => lock,
        release: () => ({ released: true }),
        close() {
          closed++;
          return result();
        },
      })
    );
    assert.throws(() => boundary.close(), /n09_prepared_commit_boundary_failed/);
    assert.throws(() => boundary.close(), /n09_prepared_commit_boundary_failed/);
    await assert.rejects(boundary.waitPending(), /n09_prepared_commit_boundary_failed/);
    assert.equal(closed, 1);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks, 0);
});

test('validated witness methods keep their original receiver and do not reread mutable properties', async () => {
  for (const mode of ['close', 'release']) {
    let queries = 0,
      closed = 0,
      released = 0,
      hooks = 0;
    const resource = {
      async waitPending() {
        assert.equal(this, resource);
        return lock;
      },
      release() {
        assert.equal(this, resource);
        released++;
        return { released: true };
      },
      close() {
        assert.equal(this, resource);
        closed++;
      },
    };
    const boundary = await createPreparedCommitBoundary(
      config,
      async () => (++queries === 1 ? baseline : state),
      () => resource
    );
    for (const name of ['waitPending', 'release', 'close'])
      Object.defineProperty(resource, name, {
        get() {
          hooks++;
          throw Error('PRIVATE');
        },
      });
    if (mode === 'close') {
      boundary.close();
      boundary.close();
      assert.equal(closed, 1);
    } else {
      assert.equal((await boundary.waitPending()).actualPreparedWritePending, true);
      assert.deepEqual(boundary.release(), { released: true });
      assert.equal(released, 1);
      boundary.close();
    }
    assert.equal(hooks, 0);
  }
});

test('COMMIT boundary rejects trailing-newline root IDs and a revision with no safe successor before querying or owning a lock', async () => {
  let queries = 0,
    resources = 0;
  for (const change of [
    { rootId: config.rootId + '\n' },
    { rootId: config.rootId + '\r\n' },
    { rootId: 'x'.repeat(100000) },
    { revision: Number.MAX_SAFE_INTEGER },
  ]) {
    await assert.rejects(
      createPreparedCommitBoundary(
        { ...config, ...change },
        async () => {
          queries++;
          return baseline;
        },
        () => {
          resources++;
          return {};
        }
      ),
      /n09_prepared_commit_boundary_failed/
    );
  }
  assert.equal(queries, 0);
  assert.equal(resources, 0);
});

const {
  createPublicationCommitBoundary,
} = require('../../scripts/context-hosted/n09-business/publication-commit-boundary');
for (const transition of ['sending', 'transport-finished', 'withdrawn', 'uncertain']) {
  test(
    transition +
      ' COMMIT observation binds only its exact pending transition and predecessor revision',
    async () => {
      for (const patch of [
        undefined,
        { transition: 'prepared' },
        { expectedRevision: 3 },
        { expectedRevision: 5 },
        { activeCount: 2 },
        { status: 'completed' },
        { generation: 2 },
        { rootId: 'hbs_' + 'b'.repeat(32) },
        { expiresAt: 10001 },
      ]) {
        let queries = 0,
          closed = 0,
          released = 0;
        const observedTimeouts = [];
        const boundary = await createPublicationCommitBoundary(
          config,
          async (timeout) => {
            observedTimeouts.push(timeout);
            return ++queries === 1 ? baseline : { ...state, transition, ...patch };
          },
          () => ({
            async waitPending() {
              return lock;
            },
            release() {
              released++;
              return { released: true };
            },
            close() {
              closed++;
            },
          }),
          transition
        );
        if (patch) {
          await assert.rejects(boundary.waitPending(), /n09_prepared_commit_boundary_failed/);
          assert.throws(() => boundary.release());
          assert.equal(closed, 1);
          assert.equal(released, 0);
        } else {
          assert.deepEqual(await boundary.waitPending(), {
            boundary: transition + '-save-reference-state-commit-pending',
            readAdmissionBlocked: true,
            actualPreparedWritePending: false,
            actualTransitionWritePending: true,
            transition,
            expectedRevision: 4,
          });
          assert.deepEqual(boundary.release(), { released: true });
          assert.equal(released, 1);
        }
        boundary.close();
        assert.ok(observedTimeouts.every((value) => value >= 1 && value <= 750));
      }
    }
  );
}
test('invalid COMMIT transition cannot query or acquire a witness, including executable and extreme input', async () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('private');
  };
  for (const transition of [
    null,
    '',
    'finished',
    '__proto__',
    'withdrawn\n',
    'x'.repeat(100000),
    1,
    new Proxy({}, { get: trap }),
  ]) {
    await assert.rejects(
      createPublicationCommitBoundary(config, trap, trap, transition),
      /n09_prepared_commit_boundary_failed/
    );
  }
  assert.equal(hooks, 0);
});
test('malformed rejected native promises are consumed without executing their then overrides or granting a COMMIT witness', async () => {
  let hooks = 0,
    closed = 0;
  const malformed = () => {
    const result = Promise.reject(Error('private'));
    Object.defineProperty(result, 'then', {
      value() {
        hooks++;
        throw Error('private');
      },
    });
    return result;
  };
  await assert.rejects(
    createPublicationCommitBoundary(
      config,
      malformed,
      () => {
        throw Error('not reached');
      },
      'sending'
    ),
    /n09_prepared_commit_boundary_failed/
  );
  const boundary = await createPublicationCommitBoundary(
    config,
    async () => baseline,
    () => ({
      waitPending: malformed,
      release() {
        throw Error('not reached');
      },
      close() {
        closed++;
      },
    }),
    'uncertain'
  );
  await assert.rejects(boundary.waitPending(), /n09_prepared_commit_boundary_failed/);
  boundary.close();
  assert.equal(closed, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks, 0);
});
