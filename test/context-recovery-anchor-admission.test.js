'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecoveryAnchorAdmission } = require('../lib/proxy/context-recovery-anchor-admission');

const identity = Object.freeze({ keyIdentity: 'b'.repeat(64), locationHash: 'c'.repeat(64) });
const metadata = (overrides = {}) => ({
  storeId: 'a'.repeat(32),
  maxTime: 100,
  scopes: [],
  ...overrides,
});
const row = (overrides = {}) => ({
  scope: 'd'.repeat(64),
  revision: 1,
  createdAt: 50,
  expiresAt: 1000,
  kind: 'state',
  tag: 'e'.repeat(64),
  ...overrides,
});
const anchored = (value) => ({ version: 1, ...identity, ...value });
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503 &&
  error.cause === undefined;

function fixture(prior, allowEnrollment = false, commit = () => {}) {
  const writes = [];
  let closes = 0;
  const repository = {
    identity,
    read: () => prior,
    commit(value) {
      commit(value);
      writes.push(value);
      return { revision: writes.length };
    },
    close() {
      closes++;
    },
  };
  const create = () => createRecoveryAnchorAdmission({ repository, allowEnrollment });
  return { create, writes, closes: () => closes };
}

test('only genuine schema initialization enrolls a durable empty intent before normal startup ACK', () => {
  const f = fixture(null, true),
    admission = f.create();
  assert.equal(admission.initialStoreId, undefined);
  assert.equal(admission.validateStartup(metadata({ maxTime: 0 }), true), undefined);
  assert.equal(f.writes.length, 1);
  assert.equal(admission.persist(metadata()), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes)), [
    anchored(metadata({ maxTime: 0 })),
    anchored(metadata()),
  ]);
  admission.close();
  admission.close();
  assert.equal(f.closes(), 1);
  assert.throws(() => admission.persist(metadata()), safe);
});

test('an existing ready schema cannot create missing enrollment even from an old empty snapshot', () => {
  const f = fixture(null, true),
    admission = f.create();
  assert.throws(() => admission.validateStartup(metadata({ maxTime: 0 }), false), safe);
  assert.equal(f.writes.length, 0);
});

test('retained empty initialization intent supplies the original storeId after initial transaction rollback', () => {
  const initial = metadata({ maxTime: 0 });
  const f = fixture(anchored(initial)),
    admission = f.create();
  assert.equal(admission.initialStoreId, initial.storeId);
  admission.validateStartup(initial, true);
  admission.persist(metadata());
  assert.equal(f.writes.length, 1);
  for (const previous of [metadata(), metadata({ maxTime: 0, scopes: [row()] })]) {
    const other = fixture(anchored(previous)),
      reopened = other.create();
    assert.throws(() => reopened.validateStartup(initial, true), safe);
    assert.equal(other.writes.length, 0);
  }
});

test('missing anchor never silently enrolls an existing database', () => {
  const f = fixture(null);
  assert.throws(f.create, safe);
  assert.equal(f.closes(), 1);
  assert.equal(f.writes.length, 0);
  for (const state of [metadata(), metadata({ maxTime: 0, scopes: [row()] })]) {
    const other = fixture(null, true),
      admission = other.create();
    assert.throws(() => admission.validateStartup(state), safe);
    assert.equal(other.writes.length, 0);
  }
});

test('rollback, revoked revival, time rollback and store substitution fail before startup mutation', () => {
  const original = metadata({ scopes: [row({ revision: 2, kind: 'revoked' })] });
  const candidates = [
    metadata({ scopes: [row()] }),
    metadata({ scopes: [row({ revision: 3 })] }),
    { ...original, maxTime: 99 },
    { ...original, storeId: 'f'.repeat(32) },
    metadata(),
    metadata({ scopes: [row({ revision: 2, kind: 'revoked', tag: 'f'.repeat(64) })] }),
  ];
  for (const state of candidates) {
    const f = fixture(anchored(original)),
      admission = f.create();
    assert.throws(() => admission.validateStartup(state), safe);
    assert.equal(f.writes.length, 0);
    assert.equal(f.closes(), 1);
  }
});

test('authenticated database ahead after unacknowledged crash can advance but never lower retained floors', () => {
  const old = metadata({ scopes: [row()] });
  const current = metadata({ maxTime: 101, scopes: [row({ revision: 2, tag: 'f'.repeat(64) })] });
  const f = fixture(anchored(old)),
    admission = f.create();
  admission.validateStartup(current);
  admission.persist(current);
  assert.equal(f.writes.length, 1);
  assert.throws(() => admission.persist(old), safe);
  assert.equal(f.writes.length, 1);
});

test('post-commit anchor failure prevents acknowledgement and permanently closes admission', () => {
  const f = fixture(anchored(metadata()), false, () => {
    throw new Error('synthetic-private-error');
  });
  const admission = f.create();
  admission.validateStartup(metadata());
  assert.throws(() => admission.persist(metadata({ maxTime: 101 })), safe);
  assert.throws(() => admission.persist(metadata({ maxTime: 102 })), safe);
  assert.equal(f.writes.length, 0);
  assert.equal(f.closes(), 1);
});

test('persist before validation and repeated startup validation refuse all further operations', () => {
  for (const operation of ['early', 'repeated']) {
    const f = fixture(anchored(metadata())),
      admission = f.create();
    if (operation === 'repeated') admission.validateStartup(metadata());
    assert.throws(
      () =>
        operation === 'early'
          ? admission.persist(metadata())
          : admission.validateStartup(metadata()),
      safe
    );
    assert.equal(f.writes.length, 0);
    assert.equal(f.closes(), 1);
  }
});

test('metadata getters, proxies, unknown and malformed fields fail without executing hostile accessors', () => {
  let hits = 0;
  const getter = metadata();
  Object.defineProperty(getter, 'scopes', {
    enumerable: true,
    get() {
      hits++;
      throw new Error('private');
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        hits++;
        throw new Error('private');
      },
    }
  );
  for (const input of [
    null,
    [],
    getter,
    proxy,
    { ...metadata(), extra: true },
    metadata({ maxTime: NaN }),
    metadata({ scopes: new Array(257) }),
  ]) {
    const f = fixture(anchored(metadata())),
      admission = f.create();
    assert.throws(() => admission.validateStartup(input), safe);
    assert.equal(f.writes.length, 0);
  }
  assert.equal(hits, 0);
});

test('expired lifecycle may be pruned only after authenticated forward time', () => {
  const f = fixture(anchored(metadata({ scopes: [row()] }))),
    admission = f.create();
  const swept = metadata({ maxTime: 1000 });
  admission.validateStartup(swept);
  admission.persist(swept);
  assert.equal(f.writes.length, 1);
});

test('durable ACK requires an exact synchronous monotonically advancing revision receipt', () => {
  let hits = 0;
  const getter = {};
  Object.defineProperty(getter, 'revision', {
    enumerable: true,
    get() {
      hits++;
      throw new Error('private');
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        hits++;
        throw new Error('private');
      },
    }
  );
  const receipts = [
    undefined,
    null,
    {},
    Promise.resolve({ revision: 1 }),
    getter,
    proxy,
    { revision: 0 },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 1, extra: true },
  ];
  for (const receipt of receipts) {
    let closes = 0,
      calls = 0;
    const admission = createRecoveryAnchorAdmission({
      allowEnrollment: false,
      repository: {
        identity,
        read: () => anchored(metadata()),
        commit() {
          calls++;
          return receipt;
        },
        close() {
          closes++;
        },
      },
    });
    admission.validateStartup(metadata());
    assert.throws(() => admission.persist(metadata()), safe);
    assert.throws(() => admission.persist(metadata()), safe);
    assert.equal(calls, 1);
    assert.equal(closes, 1);
  }
  let revision = 0;
  const admission = createRecoveryAnchorAdmission({
    allowEnrollment: false,
    repository: {
      identity,
      read: () => anchored(metadata()),
      commit: () => ({ revision: ++revision * 2 }),
      close() {},
    },
  });
  admission.validateStartup(metadata());
  admission.persist(metadata());
  assert.throws(() => admission.persist(metadata()), safe);
  assert.equal(hits, 0);
});

test('constructor captures only validated data capabilities without triggering getters or proxy traps', () => {
  let hits = 0;
  const base = () => ({
    identity,
    read: () => anchored(metadata()),
    commit: () => ({ revision: 1 }),
    close() {},
  });
  for (const name of ['identity', 'read', 'commit', 'close']) {
    const repository = base();
    Object.defineProperty(repository, name, {
      enumerable: true,
      get() {
        hits++;
        throw new Error('private');
      },
    });
    assert.throws(
      () => createRecoveryAnchorAdmission({ repository, allowEnrollment: false }),
      safe
    );
  }
  const input = {};
  Object.defineProperty(input, 'repository', {
    enumerable: true,
    get() {
      hits++;
      throw new Error('private');
    },
  });
  input.allowEnrollment = false;
  assert.throws(() => createRecoveryAnchorAdmission(input), safe);
  assert.throws(
    () =>
      createRecoveryAnchorAdmission(
        new Proxy(
          {},
          {
            get() {
              hits++;
              throw new Error('private');
            },
          }
        )
      ),
    safe
  );
  const repository = base();
  const admission = createRecoveryAnchorAdmission({ repository, allowEnrollment: false });
  repository.commit = () => {
    throw new Error('mutated-private');
  };
  admission.validateStartup(metadata());
  admission.persist(metadata());
  assert.equal(hits, 0);
});

test('async admission preserves synchronous intent and exact successor receipts through delayed ACK', async () => {
  const {
    createRecoveryAsyncAnchorAdmission,
  } = require('../lib/proxy/context-recovery-anchor-admission');
  let revision = 0,
    closed = 0,
    release;
  const repository = {
    identity,
    read: () => null,
    commit: () => ({ revision: ++revision }),
    close: () => {
      closed++;
    },
  };
  const session = {
    repository,
    async commit(value) {
      await new Promise((resolve) => {
        release = resolve;
      });
      return repository.commit(value);
    },
    async close() {},
  };
  const admission = createRecoveryAsyncAnchorAdmission(
    { repository, allowEnrollment: true },
    session
  );
  admission.validateStartup(metadata({ maxTime: 0 }), true);
  admission.persist(metadata());
  assert.equal(revision, 2);
  const pending = admission.persistAsync(metadata({ maxTime: 101 }));
  await assert.rejects(admission.persistAsync(metadata({ maxTime: 102 })), safe);
  assert.throws(() => admission.persist(metadata()), safe);
  assert.throws(() => admission.close(), safe);
  release();
  await pending;
  assert.equal(revision, 3);
  await admission.closeAsync();
  assert.equal(closed, 1);
});

test('async admission rejects wrong/overflow/unsafe receipt before granting another durable revision', async () => {
  const {
    createRecoveryAsyncAnchorAdmission,
  } = require('../lib/proxy/context-recovery-anchor-admission');
  for (const receipt of [
    { revision: 2 },
    { revision: 4 },
    { revision: 0 },
    { revision: Infinity },
    { revision: 3, extra: true },
    null,
  ]) {
    let revision = 0,
      closed = 0;
    const repository = {
      identity,
      read: () => null,
      commit: () => ({ revision: ++revision }),
      close: () => {
        closed++;
      },
    };
    const session = {
      repository,
      async commit() {
        return receipt;
      },
      async close() {},
    };
    const admission = createRecoveryAsyncAnchorAdmission(
      { repository, allowEnrollment: true },
      session
    );
    admission.validateStartup(metadata({ maxTime: 0 }), true);
    admission.persist(metadata());
    await assert.rejects(admission.persistAsync(metadata({ maxTime: 101 })), safe);
    assert.equal(closed, 1);
    await assert.rejects(admission.persistAsync(metadata({ maxTime: 102 })), safe);
  }
});

test('async capability shapes reject executable input and non-native promises without invoking hooks', async () => {
  const {
    createRecoveryAsyncAnchorAdmission,
  } = require('../lib/proxy/context-recovery-anchor-admission');
  const repository = { identity, read: () => null, commit: () => ({ revision: 1 }), close() {} };
  let hooks = 0;
  for (const value of [
    undefined,
    null,
    {},
    new Proxy(
      {},
      {
        ownKeys() {
          hooks++;
        },
      }
    ),
    {
      repository,
      commit: async () => {},
      get close() {
        hooks++;
        return undefined;
      },
    },
  ])
    assert.throws(
      () => createRecoveryAsyncAnchorAdmission({ repository, allowEnrollment: true }, value),
      safe
    );
  const session = {
    repository,
    commit: () => ({
      then() {
        hooks++;
      },
    }),
    close: async () => {},
  };
  const admission = createRecoveryAsyncAnchorAdmission(
    { repository, allowEnrollment: true },
    session
  );
  admission.validateStartup(metadata({ maxTime: 0 }), true);
  await assert.rejects(admission.persistAsync(metadata()), safe);
  assert.equal(hooks, 0);
});
