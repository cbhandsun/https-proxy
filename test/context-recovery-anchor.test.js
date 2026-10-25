'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHmac, createCipheriv } = require('node:crypto');
const { createRecoveryAnchorRepository } = require('../lib/proxy/context-recovery-anchor');
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503 &&
  error.cause === undefined;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-anchor-codec-'));
  const directory = path.join(root, 'store'),
    executable = path.join(root, 'native.exe');
  fs.mkdirSync(directory);
  fs.writeFileSync(executable, 'synthetic-non-executable');
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('hpm-anchor-codec-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rows = new Map(),
    calls = [];
  function execute(program, args, options) {
    calls.push({ program, args, options });
    assert.equal(program, executable);
    assert.deepEqual(args, ['--hpm-context-anchor-v1']);
    assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxBuffer, 131072);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    const request = JSON.parse(options.input);
    assert.match(request.slot, /^[a-f0-9]{64}$/);
    const prior = rows.get(request.slot) || { revision: 0, value: null };
    if (request.operation === 'read') {
      assert.deepEqual(Object.keys(request), ['operation', 'slot']);
      return JSON.stringify({ ok: true, ...prior });
    }
    assert.deepEqual(Object.keys(request), ['operation', 'slot', 'expectedRevision', 'value']);
    if (request.expectedRevision !== prior.revision) throw new Error('private native error');
    const next = { revision: prior.revision + 1, value: request.value };
    rows.set(request.slot, next);
    return JSON.stringify({ ok: true, ...next });
  }
  const dataKey = randomBytes(32).toString('base64');
  const dependencies = {
    platform: 'win32',
    nativeExecutable: executable,
    execute,
    environment: { SystemRoot: 'C:\\Windows', token: 'synthetic-secret' },
  };
  const create = (overrides = {}, deps = {}) =>
    createRecoveryAnchorRepository(
      { directory, dataKey, ...overrides },
      { ...dependencies, ...deps }
    );
  const snapshot = (repository, overrides = {}) => ({
    version: 1,
    storeId: 'a'.repeat(32),
    ...repository.identity,
    maxTime: 100,
    scopes: [],
    ...overrides,
  });
  return { root, directory, executable, dataKey, rows, calls, create, snapshot };
}

test('encrypted native CAS roundtrip binds store, key, location and revision without disclosing metadata', (t) => {
  const f = fixture(t),
    repository = f.create();
  assert.equal(repository.read(), null);
  const state = f.snapshot(repository, {
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
  });
  assert.deepEqual(repository.commit(state), { revision: 1 });
  const native = [...f.rows.values()][0];
  const envelope = Buffer.from(native.value, 'base64').toString('utf8');
  assert.equal(envelope.includes(state.storeId), false);
  assert.equal(envelope.includes(state.scopes[0].scope), false);
  assert.equal(
    f.calls.some((call) => call.options.input.includes(f.dataKey)),
    false
  );
  assert.equal(
    f.calls.some((call) => call.args.includes(f.directory)),
    false
  );
  repository.close();
  repository.close();
  assert.throws(() => repository.read(), safe);
  const reopened = f.create();
  assert.deepEqual(reopened.read(), state);
  assert.deepEqual(reopened.commit({ ...state, maxTime: 101 }), { revision: 2 });
  reopened.close();
});

test('missing native program never falls back and directory/program replacement fails before dispatch', (t) => {
  const f = fixture(t);
  assert.throws(() => f.create({}, { nativeExecutable: path.join(f.root, 'missing.exe') }), safe);
  assert.equal(f.calls.length, 0);
  for (const target of ['directory', 'executable']) {
    const other = fixture(t),
      repository = other.create();
    fs.renameSync(other[target], other[target] + '-old');
    if (target === 'directory') fs.mkdirSync(other.directory);
    else fs.writeFileSync(other.executable, 'replacement');
    assert.throws(() => repository.read(), safe);
    assert.equal(other.calls.length, 0);
  }
});

test('two owners cannot acknowledge a stale CAS; any dispatched failure closes the owner without retry', (t) => {
  const f = fixture(t),
    first = f.create(),
    second = f.create();
  assert.equal(first.read(), null);
  assert.equal(second.read(), null);
  first.commit(f.snapshot(first));
  assert.throws(() => second.commit(f.snapshot(second)), safe);
  const count = f.calls.length;
  assert.throws(() => second.read(), safe);
  assert.throws(() => second.commit(f.snapshot(second)), safe);
  assert.equal(f.calls.length, count);
  first.close();
});

test('authentication rejects ciphertext, revision, location and copied-store substitutions', (t) => {
  for (const mode of ['ciphertext', 'revision', 'location', 'wrong-store']) {
    const f = fixture(t),
      repository = f.create();
    repository.read();
    repository.commit(f.snapshot(repository));
    repository.close();
    const [slot, row] = [...f.rows][0];
    if (mode === 'ciphertext') {
      const bytes = Buffer.from(row.value, 'base64');
      bytes[bytes.length - 1] ^= 1;
      f.rows.set(slot, { ...row, value: bytes.toString('base64') });
    }
    if (mode === 'revision') f.rows.set(slot, { ...row, revision: row.revision + 1 });
    if (mode === 'location') {
      const otherDirectory = path.join(f.root, 'copy');
      fs.mkdirSync(otherDirectory);
      const copied = f.create({ directory: otherDirectory });
      assert.throws(() => copied.read(), safe);
      continue;
    }
    if (mode === 'wrong-store') {
      const reopened = f.create();
      reopened.read();
      assert.throws(() => reopened.commit(f.snapshot(reopened, { storeId: 'd'.repeat(32) })), safe);
      continue;
    }
    assert.throws(() => f.create().read(), safe);
  }
});

test('unread, repeated read and closed repositories fail without a write', (t) => {
  const f = fixture(t),
    fresh = f.create();
  assert.throws(() => fresh.commit(f.snapshot(fresh)), safe);
  assert.equal(f.calls.length, 0);
  const repository = f.create();
  repository.read();
  assert.throws(() => repository.read(), safe);
  const count = f.calls.length;
  assert.throws(() => repository.commit(f.snapshot(repository)), safe);
  assert.equal(f.calls.length, count);
  const closed = f.create();
  closed.close();
  assert.throws(() => closed.read(), safe);
});

test('an authenticated maximum native revision can be read but cannot overflow into another write', (t) => {
  const f = fixture(t),
    first = f.create();
  first.read();
  const snapshot = f.snapshot(first);
  first.commit(snapshot);
  first.close();
  const slot = [...f.rows.keys()][0],
    revision = Number.MAX_SAFE_INTEGER;
  const key = createHmac('sha256', Buffer.from(f.dataKey, 'base64'))
    .update('hpm.context.recovery.anchor.v1/envelope')
    .digest();
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['hpm.context.recovery.anchor.v1', slot, revision])));
  const payload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(snapshot))),
    cipher.final(),
  ]);
  f.rows.set(slot, {
    revision,
    value: Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString('base64'),
  });
  key.fill(0);
  const repository = f.create();
  assert.deepEqual(repository.read(), snapshot);
  const calls = f.calls.length;
  assert.throws(() => repository.commit(snapshot), safe);
  assert.equal(f.calls.length, calls);
});

test('malformed, duplicated, oversized and untrusted native failures never leak raw errors or retry', (t) => {
  const outputs = [
    null,
    '',
    '{}',
    '{"ok":false}',
    '{"ok":false,"ok":true,"revision":0,"value":null}',
    '{"ok":true,"revision":-1,"value":null}',
    '{"ok":true,"revision":0,"value":"AA=="}',
    '{"ok":true,"revision":1,"value":"AA=="}',
    '{"ok":true,"revision":1,"value":"!"}',
    '{"ok":true,"revision":9007199254740992,"value":null}',
    ' '.repeat(131073),
    JSON.stringify({ ok: true, revision: 0, value: null, extra: true }),
    JSON.stringify({ ok: true, revision: '0', value: null }),
  ];
  for (const output of outputs) {
    const f = fixture(t);
    let calls = 0;
    const repository = f.create(
      {},
      {
        execute: () => {
          calls++;
          return output;
        },
      }
    );
    assert.throws(() => repository.read(), safe);
    assert.throws(() => repository.read(), safe);
    assert.equal(calls, 1);
  }
  const f = fixture(t);
  let touched = 0;
  const hostile = Object.defineProperty({}, 'message', {
    get() {
      touched++;
      throw new Error('private');
    },
  });
  const repository = f.create(
    {},
    {
      execute() {
        throw hostile;
      },
    }
  );
  assert.throws(() => repository.read(), safe);
  assert.equal(touched, 0);
});

test('constructor validates external options without reading getters or proxy traps', (t) => {
  const f = fixture(t);
  let touched = 0;
  for (const value of [
    null,
    [],
    {},
    { directory: f.directory, dataKey: f.dataKey, extra: true },
    Object.defineProperty({ dataKey: f.dataKey }, 'directory', {
      enumerable: true,
      get() {
        touched++;
        return f.directory;
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
    assert.throws(() => createRecoveryAnchorRepository(value), safe);
  assert.equal(touched, 0);
  for (const options of [
    { dataKey: '' },
    { dataKey: 'x'.repeat(100000) },
    { directory: '' },
    { directory: 'relative' },
  ])
    assert.throws(() => f.create(options), safe);
  assert.throws(() => f.create({}, { platform: 'linux' }), safe);
  assert.equal(f.calls.length, 0);
});

test('invalid snapshot identity, rollback or corrupted readback cannot become a commit ACK', (t) => {
  const f = fixture(t),
    repository = f.create();
  repository.read();
  repository.commit(f.snapshot(repository));
  assert.throws(() => repository.commit(f.snapshot(repository, { maxTime: 99 })), safe);
  const before = f.calls.length;
  assert.throws(() => repository.commit(f.snapshot(repository)), safe);
  assert.equal(f.calls.length, before);
  const other = fixture(t);
  let count = 0;
  const lying = other.create(
    {},
    {
      execute() {
        count++;
        if (count === 1) return '{"ok":true,"revision":0,"value":null}';
        return '{"ok":true,"revision":0,"value":null}';
      },
    }
  );
  lying.read();
  assert.throws(() => lying.commit(other.snapshot(lying)), safe);
  assert.equal(count, 2);
});

test('all 256 supported scopes roundtrip through encrypted native transport at safe integer extremes', (t) => {
  const f = fixture(t),
    repository = f.create();
  assert.equal(repository.read(), null);
  const state = f.snapshot(repository, {
    maxTime: Number.MAX_SAFE_INTEGER,
    scopes: Array.from({ length: 256 }, (_, index) => ({
      scope: index.toString(16).padStart(64, '0'),
      revision: Number.MAX_SAFE_INTEGER,
      createdAt: Number.MAX_SAFE_INTEGER - 1000,
      expiresAt: Number.MAX_SAFE_INTEGER,
      kind: 'revoked',
      tag: 'f'.repeat(64),
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) + 28 <= 65536);
  assert.deepEqual(repository.commit(state), { revision: 1 });
  repository.close();
  const reopened = f.create();
  assert.deepEqual(reopened.read(), state);
  reopened.close();
});

test('header witnesses survive the real encrypted native CAS codec and reject format downgrade before dispatch', (t) => {
  const f = fixture(t),
    repository = f.create();
  assert.equal(repository.read(), null);
  const original = f.snapshot(repository);
  repository.commit(original);
  const witnessed = f.snapshot(repository, { version: 2, headerTag: 'd'.repeat(64) });
  assert.deepEqual(repository.commit(witnessed), { revision: 2 });
  repository.close();
  const reopened = f.create();
  assert.deepEqual(reopened.read(), witnessed);
  const before = JSON.stringify([...f.rows]);
  const calls = f.calls.length;
  assert.throws(() => reopened.commit(original), safe);
  assert.equal(f.calls.length, calls);
  assert.equal(JSON.stringify([...f.rows]), before);
  assert.equal(before.includes('headerTag'), false);
});
