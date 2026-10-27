'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { storageFailureDiagnostic } = require('../lib/proxy/context-recovery-storage-failure');
const {
  createRecoveryAnchorRepository,
  createRecoveryAnchorSession,
} = require('../lib/proxy/context-recovery-anchor');

const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.cause === undefined;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, overrides = {}) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-anchor-session-'));
  const directory = path.join(root, 'store'),
    executable = path.join(root, 'native.exe');
  fs.mkdirSync(directory);
  fs.writeFileSync(executable, 'synthetic-only');
  const input = { directory, dataKey: randomBytes(32).toString('base64') };
  let row = { revision: 0, value: null },
    launches = 0,
    closes = 0;
  const calls = [],
    owners = [];
  let beforeReply = async () => {},
    beforeClose = async () => {},
    transform = (value) => value;
  function execute(text) {
    const request = JSON.parse(text);
    calls.push(request.operation);
    if (request.operation === 'read') return JSON.stringify({ ok: true, ...row });
    assert.equal(request.expectedRevision, row.revision);
    row = { revision: row.revision + 1, value: request.value };
    return JSON.stringify({ ok: true, ...row });
  }
  const dependencies = {
    platform: 'win32',
    nativeExecutable: executable,
    environment: { SystemRoot: 'C:\\Windows' },
    execute: (_file, _args, options) => execute(options.input),
    createChannel(options) {
      launches++;
      assert.deepEqual(options, { executable, systemRoot: 'C:\\Windows' });
      return {
        async execute(text) {
          const reply = execute(text);
          await beforeReply();
          return transform(reply);
        },
        async close() {
          closes++;
          await beforeClose();
        },
      };
    },
    ...overrides,
  };
  function open() {
    const session = createRecoveryAnchorSession(input, dependencies);
    owners.push(session);
    const repository = session.repository;
    assert.deepEqual(Object.keys(repository), ['identity', 'read', 'commit', 'close']);
    const prior = repository.read();
    const state = prior ?? {
      version: 1,
      ...repository.identity,
      storeId: 'a'.repeat(32),
      maxTime: 100,
      scopes: [],
    };
    if (prior === null) repository.commit(state);
    return { session, repository, state };
  }
  t.after(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    assert.equal(fs.realpathSync.native(root), root);
    assert.equal(path.dirname(root), temporary);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    open,
    input,
    dependencies,
    directory,
    executable,
    calls,
    launches: () => launches,
    closes: () => closes,
    replyAfter(action) {
      beforeReply = action;
    },
    closeAfter(action) {
      beforeClose = action;
    },
    transform(action) {
      transform = action;
    },
    reopen() {
      return createRecoveryAnchorRepository(input, dependencies);
    },
  };
}

test('synchronous durable startup and async commits share the exact codec, key and CAS revision', async (t) => {
  const f = fixture(t),
    { session, state } = f.open();
  assert.equal(f.launches(), 0);
  assert.deepEqual(f.calls, ['read', 'compare']);
  const next = {
    ...state,
    maxTime: 101,
    scopes: [
      {
        scope: 'b'.repeat(64),
        revision: 1,
        createdAt: 100,
        expiresAt: 1000,
        kind: 'state',
        tag: 'c'.repeat(64),
      },
    ],
  };
  const waiting = deferred();
  f.replyAfter(() => waiting.promise);
  const pending = session.commit(next);
  let acknowledged = false;
  void pending.then(() => {
    acknowledged = true;
  });
  await turn();
  assert.equal(acknowledged, false);
  waiting.resolve();
  assert.deepEqual(await pending, { revision: 2 });
  f.replyAfter(async () => {});
  assert.deepEqual(await session.commit({ ...next, maxTime: 102 }), { revision: 3 });
  assert.equal(f.launches(), 1);
  await session.close();
  const reopened = f.reopen();
  assert.deepEqual(reopened.read(), { ...next, maxTime: 102 });
  reopened.close();
});

test('async anchor failures preserve the actual fixed boundary after mandatory cleanup', async (t) => {
  for (const [phase, setup] of [
    ['anchor-prepare', () => ({ invalid: true })],
    [
      'anchor-identity-before',
      (f) => {
        fs.renameSync(f.directory, f.directory + '-old');
        fs.mkdirSync(f.directory);
      },
    ],
    [
      'anchor-channel-open',
      (f) => {
        f.dependencies.createChannel = () => {
          throw Error('PRIVATE_FACTORY');
        };
      },
    ],
    [
      'anchor-request',
      (f) => {
        f.replyAfter(async () => {
          throw Error('PRIVATE_NATIVE');
        });
      },
    ],
    [
      'anchor-reply',
      (f) => {
        f.transform(() => '{"ok":false}');
      },
    ],
    [
      'anchor-receipt',
      (f) => {
        f.transform((text) => JSON.stringify({ ...JSON.parse(text), revision: 99 }));
      },
    ],
    [
      'anchor-identity-after',
      (f) => {
        f.replyAfter(async () => {
          fs.renameSync(f.directory, f.directory + '-old');
          fs.mkdirSync(f.directory);
        });
      },
    ],
  ]) {
    const f = fixture(t),
      { session, state } = f.open();
    const invalid = setup(f);
    await assert.rejects(session.commit(invalid ?? { ...state, maxTime: 101 }), (error) => {
      assert.ok(safe(error));
      assert.deepEqual(storageFailureDiagnostic(error), { phase, cleanupFailed: false });
      assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
      return true;
    });
    assert.equal(
      f.closes(),
      ['anchor-prepare', 'anchor-identity-before', 'anchor-channel-open'].includes(phase) ? 0 : 1
    );
    await assert.rejects(session.commit(state), safe);
  }
});

test('a private request rejection and failed cleanup keep the first phase and secondary failure separately', async (t) => {
  let accessed = 0;
  const privateError = new Proxy(
    {},
    {
      get() {
        accessed++;
        throw Error('PRIVATE');
      },
    }
  );
  const f = fixture(t),
    { session, state } = f.open();
  f.replyAfter(async () => {
    throw privateError;
  });
  f.closeAfter(async () => {
    throw Error('PRIVATE_CLOSE');
  });
  await assert.rejects(session.commit({ ...state, maxTime: 101 }), (error) => {
    assert.ok(safe(error));
    assert.deepEqual(storageFailureDiagnostic(error), {
      phase: 'anchor-request',
      cleanupFailed: true,
    });
    return true;
  });
  assert.equal(accessed, 0);
  assert.equal(f.closes(), 1);
  await assert.rejects(session.commit(state), safe);
  assert.equal(f.closes(), 1);
});

test('overlapping commit and old synchronous capabilities cannot disturb an in-flight async ACK', async (t) => {
  const f = fixture(t),
    { session, repository, state } = f.open(),
    waiting = deferred();
  f.replyAfter(() => waiting.promise);
  const pending = session.commit({ ...state, maxTime: 101 });
  await assert.rejects(session.commit({ ...state, maxTime: 102 }), safe);
  assert.throws(() => repository.commit(state), safe);
  assert.throws(() => repository.read(), safe);
  assert.throws(() => repository.close(), safe);
  assert.equal(f.closes(), 0);
  waiting.resolve();
  assert.deepEqual(await pending, { revision: 2 });
  await session.close();
  repository.close();
});

test('wrong revision, wrong ciphertext, invalid and negative ACKs remain terminal without retry', async (t) => {
  for (const transform of [
    () => '{"ok":false}',
    () => '{}',
    (text) => JSON.stringify({ ...JSON.parse(text), revision: 3 }),
    (text) => JSON.stringify({ ...JSON.parse(text), value: Buffer.alloc(29).toString('base64') }),
  ]) {
    const f = fixture(t),
      { session, state } = f.open(),
      waiting = deferred();
    f.transform(transform);
    f.closeAfter(() => waiting.promise);
    const pending = session.commit({ ...state, maxTime: 101 });
    const rejected = assert.rejects(pending, safe);
    let settled = false;
    void rejected.then(() => {
      settled = true;
    });
    await turn();
    assert.equal(settled, false);
    assert.equal(f.closes(), 1);
    waiting.resolve();
    await rejected;
    await assert.rejects(session.commit(state), safe);
    assert.equal(f.calls.length, 3);
    assert.equal(f.launches(), 1);
  }
});

test('fresh directory and executable identities are checked before dispatch and after async ACK', async (t) => {
  for (const target of ['directory', 'executable']) {
    for (const boundary of ['before', 'after']) {
      const f = fixture(t),
        { session, state } = f.open();
      const replace = () => {
        fs.renameSync(f[target], f[target] + '-old');
        if (target === 'directory') fs.mkdirSync(f.directory);
        else fs.writeFileSync(f.executable, 'replacement');
      };
      if (boundary === 'before') replace();
      else f.replyAfter(async () => replace());
      await assert.rejects(session.commit({ ...state, maxTime: 101 }), safe);
      assert.equal(f.launches(), boundary === 'before' ? 0 : 1);
      await assert.rejects(session.commit(state), safe);
    }
  }
});

test('invalid, rollback and wrong-identity snapshots fail before starting the native channel', async (t) => {
  for (const invalid of [
    null,
    {},
    [],
    { maxTime: 99 },
    { keyIdentity: 'f'.repeat(64) },
    { locationHash: 'e'.repeat(64) },
    { scopes: [{ scope: 'a'.repeat(64), expiresAt: Infinity }] },
  ]) {
    const f = fixture(t),
      { session, state } = f.open();
    await assert.rejects(
      session.commit(
        invalid && !Array.isArray(invalid) && Object.keys(invalid).length
          ? { ...state, ...invalid }
          : invalid
      ),
      safe
    );
    assert.equal(f.launches(), 0);
  }
});

test('closing during a dispatched commit withholds cleanup until actual channel close and refuses its ACK', async (t) => {
  const f = fixture(t),
    { session, state } = f.open(),
    reply = deferred(),
    close = deferred();
  f.replyAfter(() => reply.promise);
  f.closeAfter(() => close.promise);
  const pending = session.commit({ ...state, maxTime: 101 });
  const rejected = assert.rejects(pending, safe);
  const closing = session.close();
  assert.equal(session.close(), closing);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  reply.resolve();
  await turn();
  assert.equal(closed, false);
  close.resolve();
  await closing;
  await rejected;
  assert.equal(f.closes(), 1);
});

test('native channel factories and result promises reject executable or malformed substitutes safely', async (t) => {
  for (const createChannel of [
    () => {
      throw Error('PRIVATE');
    },
    async () => {
      throw Error('must never run');
    },
    () => ({
      execute: () => ({
        then() {
          throw Error('must never run');
        },
      }),
      close: async () => {},
    }),
    () => ({
      execute: async () => {
        throw Error('PRIVATE');
      },
      close: async () => {},
    }),
    () => ({
      execute: async () => '{}',
      close: async () => {
        throw Error('PRIVATE');
      },
    }),
    () =>
      new Proxy(
        {},
        {
          ownKeys() {
            throw Error('must never run');
          },
        }
      ),
  ]) {
    const f = fixture(t, { createChannel }),
      { session, state } = f.open();
    await assert.rejects(session.commit({ ...state, maxTime: 101 }), safe);
    await assert.rejects(session.commit(state), safe);
  }
});

test('closing a startup-only session is idempotent and never creates a stream', async (t) => {
  const f = fixture(t),
    { session, repository, state } = f.open();
  const closing = session.close();
  assert.equal(session.close(), closing);
  await closing;
  repository.close();
  assert.equal(f.launches(), 0);
  assert.throws(() => repository.commit(state), safe);
  await assert.rejects(session.commit(state), safe);
});

test('Windows actual session commits survive original codec reopen; unsupported OS receives no registry credit', async (t) => {
  if (process.platform !== 'win32') {
    const f = fixture(t);
    assert.throws(() => createRecoveryAnchorSession(f.input), safe);
    return;
  }
  const temporary = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporary, 'hpm-anchor-native-session-'));
  const input = { directory, dataKey: randomBytes(32).toString('base64') };
  const session = createRecoveryAnchorSession(input),
    repository = session.repository;
  const resources = {};
  t.after(async () => {
    await session.close();
    resources.reopened?.close();
    assert.equal(fs.realpathSync.native(directory), directory);
    assert.equal(path.dirname(directory), temporary);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(repository.read(), null);
  const expiresAt = Date.now() + 86400000;
  const state = {
    version: 1,
    ...repository.identity,
    storeId: randomBytes(16).toString('hex'),
    maxTime: expiresAt - 86400000,
    scopes: [],
  };
  assert.deepEqual(repository.commit(state), { revision: 1 });
  const next = {
    ...state,
    maxTime: state.maxTime + 1,
    scopes: [
      {
        scope: 'b'.repeat(64),
        revision: 1,
        createdAt: state.maxTime,
        expiresAt,
        kind: 'state',
        tag: 'c'.repeat(64),
      },
    ],
  };
  assert.deepEqual(await session.commit(next), { revision: 2 });
  assert.deepEqual(await session.commit({ ...next, maxTime: next.maxTime + 1 }), { revision: 3 });
  await session.close();
  resources.reopened = createRecoveryAnchorRepository(input);
  assert.deepEqual(resources.reopened.read(), { ...next, maxTime: next.maxTime + 1 });
  t.diagnostic('actual_registry_async_session_and_original_codec_reopen_verified');
});

test('close failures and non-native close results never leak raw errors or claim cleanup', async (t) => {
  let hooks = 0;
  for (const close of [
    async () => {
      throw Error('PRIVATE close failure');
    },
    () => ({
      then() {
        hooks++;
      },
    }),
    () => undefined,
  ]) {
    const f = fixture(t, { createChannel: () => ({ execute: async () => '{}', close }) });
    const { session, repository, state } = f.open();
    await assert.rejects(session.commit({ ...state, maxTime: 101 }), safe);
    await assert.rejects(session.close(), safe);
    assert.throws(() => repository.close(), safe);
  }
  assert.equal(hooks, 0);
});
