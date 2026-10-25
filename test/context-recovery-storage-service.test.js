'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  openContextRecoveryStorage,
  validateStorageResult,
} = require('../lib/proxy/context-recovery-storage');
const { createStorageOwner } = require('../lib/proxy/context-recovery-storage-owner');
const {
  createSyntheticRetainedAnchorFactory,
} = require('./helpers/recovery-anchor-repository.cjs');
// This file's synthetic owner fixtures retain anchor history across reopen.
// Real Worker/openContextRecoveryStorage tests continue to use the real backend.
const syntheticAnchorDependencies = Object.freeze({
  createAnchorRepository: createSyntheticRetainedAnchorFactory(),
});
const {
  createStoragePaths,
  storageDirectory,
} = require('../lib/proxy/context-recovery-storage-paths');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');
const { createStorageStartupProgress } = require('../lib/proxy/context-recovery-storage-progress');

const scope = 'c'.repeat(64);
const state = {
  marker: 'fresh-' + randomBytes(16).toString('hex'),
  text: '原文\r\nélève🙂',
  budget: { calls: 17 },
};
const save = () => ({
  operation: 'save',
  scope,
  expectedRevision: 0,
  expiresAt: Date.now() + 60000,
  state,
});
const json = (value) => JSON.parse(JSON.stringify(value));
function safeFailure(error) {
  assert.equal(error.code, 'context_recovery_storage_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-context-service-test-'));
  return {
    root,
    directory: path.join(root, 'context'),
    clean() {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('hpm-context-service-test-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
// Injectable key backend for filesystem/ownership fixtures only. Real workers
// never receive this function and always use strict CurrentUser DPAPI.
const fixtureKey = ({ operation, value }) =>
  operation === 'protect' ? KEY_PREFIX + value : value.slice(KEY_PREFIX.length);

test('storage service options and paths reject malformed or executable inputs without effects', async () => {
  let invoked = 0;
  for (const options of [
    null,
    [],
    {},
    { directory: 'relative' },
    { directory: path.parse(process.cwd()).root },
    { directory: os.tmpdir(), timeoutMs: 99 },
    { directory: os.tmpdir(), timeoutMs: 60001 },
    { directory: os.tmpdir(), WorkerType: null },
    { directory: os.tmpdir(), extra: true },
    { directory: os.tmpdir(), onStartup: 'secret-value' },
    {
      directory: os.tmpdir(),
      get onStartup() {
        invoked++;
        return () => {};
      },
    },
    {
      get directory() {
        invoked++;
        return os.tmpdir();
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('secret-value');
        },
      }
    ),
  ]) {
    await assert.rejects(openContextRecoveryStorage(options), safeFailure);
  }
  for (const directory of [
    '',
    'relative',
    '\\\\remote\\share',
    '//remote/share',
    os.tmpdir() + '\0',
    os.tmpdir() + 'x'.repeat(5000),
  ])
    assert.throws(() => storageDirectory(directory), safeFailure);
  assert.equal(invoked, 0);
});

test('storage owner has an exclusive lifetime lock, persists a fixture key and detects key changes', (t) => {
  const fixture = temporary();
  let attempt = 0;
  const open = () => {
    const current = ++attempt;
    return createStorageOwner(
      {
        directory: fixture.directory,
        protectKey: fixtureKey,
        onStartup: (event) =>
          t.diagnostic('storage_owner_startup ' + JSON.stringify({ attempt: current, ...event })),
      },
      syntheticAnchorDependencies
    );
  };
  let first, second;
  try {
    first = open();
    assert.deepEqual(first.execute(save()), { revision: 1 });
    assert.throws(open, safeFailure);
    assert.deepEqual(json(first.execute({ operation: 'load', scope }).state), state);
    first.close();
    second = open();
    assert.equal(second.execute({ operation: 'load', scope }).state.budget.calls, 17);
    const keyFile = path.join(fixture.directory, '.data-key');
    const original = fs.readFileSync(keyFile, 'utf8');
    fs.writeFileSync(keyFile, original.slice(0, -1) + (original.endsWith('A') ? 'B' : 'A'));
    assert.throws(() => second.execute({ operation: 'load', scope }), safeFailure);
    assert.throws(() => second.execute({ operation: 'inspect' }), safeFailure);
    second.close();
    fs.unlinkSync(keyFile);
    let keyCalls = 0;
    assert.throws(
      () =>
        createStorageOwner(
          {
            directory: fixture.directory,
            protectKey() {
              keyCalls++;
            },
          },
          syntheticAnchorDependencies
        ),
      safeFailure
    );
    assert.equal(keyCalls, 0);
  } finally {
    first?.close();
    second?.close();
    fixture.clean();
  }
});

test('storage owner refuses unknown files, hard links, replaced files and unavailable key protection', () => {
  for (const mode of [
    'unknown',
    'hardlink',
    'replaced',
    'keyFailed',
    'oversize',
    'markerHardlink',
  ]) {
    const fixture = temporary();
    let owner;
    try {
      if (mode === 'unknown') {
        fs.mkdirSync(fixture.directory);
        fs.writeFileSync(path.join(fixture.directory, 'unexpected'), 'synthetic');
        assert.throws(
          () =>
            createStorageOwner(
              { directory: fixture.directory, protectKey: fixtureKey },
              syntheticAnchorDependencies
            ),
          safeFailure
        );
      } else if (mode === 'oversize') {
        fs.mkdirSync(fixture.directory);
        fs.writeFileSync(path.join(fixture.directory, '.data-key'), 'x'.repeat(17001));
        assert.throws(
          () =>
            createStorageOwner(
              { directory: fixture.directory, protectKey: fixtureKey },
              syntheticAnchorDependencies
            ),
          safeFailure
        );
      } else if (mode === 'markerHardlink') {
        fs.mkdirSync(fixture.directory);
        const target = path.join(fixture.root, 'marker-target');
        fs.writeFileSync(target, 'unchanged-synthetic-marker');
        fs.linkSync(target, path.join(fixture.directory, '.hpm-secured'));
        assert.throws(
          () =>
            createStorageOwner(
              { directory: fixture.directory, protectKey: fixtureKey },
              syntheticAnchorDependencies
            ),
          safeFailure
        );
        assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged-synthetic-marker');
      } else if (mode === 'keyFailed') {
        const phases = [];
        assert.throws(
          () =>
            createStorageOwner(
              {
                directory: fixture.directory,
                onStartup: ({ phase }) => phases.push(phase),
                protectKey() {
                  throw new Error('secret-value');
                },
              },
              syntheticAnchorDependencies
            ),
          safeFailure
        );
        assert.equal(fs.existsSync(path.join(fixture.directory, '.data-key')), false);
        assert.equal(fs.existsSync(path.join(fixture.directory, 'checkpoint.sqlite')), false);
        assert.deepEqual(phases, [
          'paths_started',
          'paths_ready',
          'ownership_started',
          'ownership_acquired',
          'key_protect_started',
        ]);
      } else {
        owner = createStorageOwner(
          { directory: fixture.directory, protectKey: fixtureKey },
          syntheticAnchorDependencies
        );
        if (mode === 'hardlink')
          fs.linkSync(
            path.join(fixture.directory, '.data-key'),
            path.join(fixture.root, 'linked-key')
          );
        else {
          fs.renameSync(
            path.join(fixture.directory, '.data-key'),
            path.join(fixture.root, 'prior-key')
          );
          fs.copyFileSync(
            path.join(fixture.root, 'prior-key'),
            path.join(fixture.directory, '.data-key')
          );
        }
        assert.throws(() => owner.execute({ operation: 'inspect' }), safeFailure);
      }
    } finally {
      owner?.close();
      fixture.clean();
    }
  }
});

test('storage paths reject directory junctions and pinned-root replacement before any subsequent write', () => {
  const fixture = temporary();
  try {
    const target = path.join(fixture.root, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, fixture.directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createStoragePaths(fixture.directory), safeFailure);
    assert.deepEqual(fs.readdirSync(target), []);
    fs.unlinkSync(fixture.directory);
    const paths = createStoragePaths(fixture.directory);
    fs.renameSync(fixture.directory, path.join(fixture.root, 'prior'));
    fs.mkdirSync(fixture.directory);
    assert.throws(() => paths.prepare('.writer.sqlite'), safeFailure);
    assert.deepEqual(fs.readdirSync(fixture.directory), []);
  } finally {
    fixture.clean();
  }
});

test('fresh key write returns only exact persisted bytes and keeps its identity and digest pinned', () => {
  const fixture = temporary();
  try {
    const paths = createStoragePaths(fixture.directory);
    for (const value of [undefined, null, 1, {}, Buffer.from('x'), 'x'.repeat(17001)]) {
      assert.throws(() => paths.writeKey(value), safeFailure);
      assert.equal(fs.existsSync(path.join(fixture.directory, '.data-key')), false);
    }
    const wrapped = fixtureKey({ operation: 'protect', value: randomBytes(32).toString('base64') });
    assert.equal(paths.writeKey(wrapped), wrapped);
    assert.equal(paths.read('.data-key').toString('utf8'), wrapped);
    paths.verify();
    assert.throws(() => paths.writeKey(wrapped), safeFailure);
    fs.writeFileSync(path.join(fixture.directory, '.data-key'), 'x'.repeat(wrapped.length));
    assert.throws(() => paths.verify(), safeFailure);
  } finally {
    fixture.clean();
  }
});

test('inventory rejects pinned files disappearing or changing during the descriptor read', (t) => {
  for (const mode of ['missing-pin', 'changed-inode', 'hardlink', 'changed-directory']) {
    const fixture = temporary();
    let intercepted;
    try {
      const paths = createStoragePaths(fixture.directory);
      const writer = paths.prepare('.writer.sqlite');
      const keyFile = path.join(fixture.directory, '.data-key');
      const wrapped = fixtureKey({
        operation: 'protect',
        value: randomBytes(32).toString('base64'),
      });
      paths.writeKey(wrapped);
      if (mode === 'missing-pin') fs.unlinkSync(writer);
      else {
        // Windows may forbid renaming a directory while a child handle is
        // open. Change it just after close, before the enclosing inventory's
        // final ancestor check, rather than passing on that OS rejection.
        const operation = mode === 'changed-directory' ? 'closeSync' : 'readSync';
        const original = fs[operation];
        let changed = false;
        intercepted = t.mock.method(fs, operation, function (...args) {
          const result = original.apply(this, args);
          if (!changed) {
            changed = true;
            if (mode === 'changed-directory') {
              fs.renameSync(fixture.directory, path.join(fixture.root, 'prior'));
              fs.mkdirSync(fixture.directory);
            } else if (mode === 'changed-inode') {
              fs.renameSync(keyFile, path.join(fixture.root, 'prior-key'));
              fs.writeFileSync(keyFile, wrapped);
            } else fs.linkSync(keyFile, path.join(fixture.root, 'linked-key'));
          }
          return result;
        });
      }
      assert.throws(
        () => paths.verify(),
        mode === 'changed-directory' ? undefined : safeFailure,
        mode
      );
      assert.throws(
        () => paths.prepare('checkpoint.sqlite'),
        mode === 'changed-directory' ? undefined : safeFailure,
        mode
      );
    } finally {
      intercepted?.mock.restore();
      fixture.clean();
    }
  }
});

test('fresh key write rejects a successful filesystem write whose persisted wrapping differs', (t) => {
  const fixture = temporary();
  try {
    const paths = createStoragePaths(fixture.directory);
    const wrapped = fixtureKey({ operation: 'protect', value: randomBytes(32).toString('base64') });
    const write = fs.writeFileSync;
    const intercepted = t.mock.method(fs, 'writeFileSync', function (file, data, ...args) {
      return write.call(
        this,
        file,
        typeof file === 'number' && data === wrapped ? 'x'.repeat(wrapped.length) : data,
        ...args
      );
    });
    try {
      assert.throws(() => paths.writeKey(wrapped), safeFailure);
    } finally {
      intercepted.mock.restore();
    }
  } finally {
    fixture.clean();
  }
});

function fakeWorkers() {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(file, options) {
      super();
      this.file = file;
      this.options = options;
      this.messages = [];
      this.terminations = 0;
      this.drained = 0;
      this.stdout = this.stderr = { resume: () => this.drained++ };
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
    }
    terminate() {
      this.terminations++;
      return Promise.resolve(1);
    }
  }
  return { FakeWorker, workers };
}
async function openedFixture(timeoutMs = 1000, open = openContextRecoveryStorage) {
  const fixture = fakeWorkers();
  const opened = open({
    directory: path.join(os.tmpdir(), 'synthetic-context'),
    WorkerType: fixture.FakeWorker,
    timeoutMs,
  });
  fixture.worker = fixture.workers[0];
  fixture.worker.emit('message', { id: 0, ok: true });
  fixture.service = await opened;
  return fixture;
}
function reply(worker, index, result) {
  worker.emit('message', { id: worker.messages[index].id, ok: true, result });
}
async function closeFixture(fixture) {
  const closed = fixture.service.close();
  reply(fixture.worker, fixture.worker.messages.length - 1, null);
  fixture.worker.emit('exit', 0);
  await closed;
}

test('worker scan reply validation binds its cursor on the first parse', () => {
  const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
  const record = { revision: 1, createdAt: 100, expiresAt: 1000, state };
  const page = { catalog: [entry], scope, record };
  assert.deepEqual(json(validateStorageResult('scan', page, null)), page);
  for (const after of ['', 0, {}, 'f'.repeat(64), scope])
    assert.throws(() => validateStorageResult('scan', page, after), safeFailure);
  const empty = { catalog: [], scope: null, record: null };
  assert.deepEqual(json(validateStorageResult('scan', empty, null)), empty);
  assert.throws(() => validateStorageResult('scan', empty, scope), safeFailure);
  let touched = 0;
  const hostile = Object.defineProperty({}, 'catalog', {
    enumerable: true,
    get() {
      touched++;
      return page.catalog;
    },
  });
  assert.throws(() => validateStorageResult('scan', hostile, null), safeFailure);
  assert.equal(touched, 0);
  const parsed = validateStorageResult('scan', page, null);
  parsed.record.state.budget.calls++;
  assert.equal(page.record.state.budget.calls, 17);
});

test('worker scan response crosses the semantic page parser once and revalidates later input', async () => {
  const file = require.resolve('../lib/proxy/context-recovery-storage');
  const cached = require.cache[file];
  const contract = require('../lib/proxy/context-recovery-storage-contract');
  const parse = contract.storageScanPage;
  let calls = 0;
  contract.storageScanPage = (...args) => {
    calls++;
    return parse(...args);
  };
  delete require.cache[file];
  const open = require(file).openContextRecoveryStorage;
  try {
    const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
    const page = {
      catalog: [entry],
      scope,
      record: { revision: 1, createdAt: 100, expiresAt: 1000, state: json(state) },
    };
    const f = await openedFixture(1000, open);
    const first = f.service.execute({ operation: 'scan', after: null });
    reply(f.worker, 0, page);
    assert.deepEqual(json(await first), page);
    const count = calls;
    await closeFixture(f);
    assert.equal(count, 1);
    const bad = await openedFixture(1000, open);
    const rejected = assert.rejects(
      bad.service.execute({ operation: 'scan', after: null }),
      safeFailure
    );
    page.record.revision++;
    reply(bad.worker, 0, page);
    await rejected;
    assert.equal(calls, 2);
    assert.equal(bad.worker.terminations, 1);
    await assert.rejects(bad.service.close(), safeFailure);
  } finally {
    contract.storageScanPage = parse;
    require.cache[file] = cached;
  }
});

test('worker scan replies are bounded and associated with the original request cursor', async () => {
  const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
  const record = { revision: 1, createdAt: 100, expiresAt: 1000, state };
  const page = { catalog: [entry], scope, record };
  const f = await openedFixture();
  const pending = f.service.execute({ operation: 'scan', after: null });
  assert.deepEqual(json(f.worker.messages[0].request), { operation: 'scan', after: null });
  reply(f.worker, 0, page);
  assert.deepEqual(json(await pending), page);
  await closeFixture(f);
  for (const malformed of [
    { ...page, extra: true },
    { ...page, record: { ...record, revision: 2 } },
    { ...page, scope: null, record: null },
    { ...page, catalog: [entry, { ...entry, scope: 'd'.repeat(64) }], scope: 'd'.repeat(64) },
  ]) {
    const bad = await openedFixture();
    const rejected = assert.rejects(
      bad.service.execute({ operation: 'scan', after: null }),
      safeFailure
    );
    reply(bad.worker, 0, malformed);
    await rejected;
    assert.equal(bad.worker.terminations, 1);
    await assert.rejects(bad.service.execute({ operation: 'catalog' }), safeFailure);
    await assert.rejects(bad.service.close(), safeFailure);
  }
});

test('startup progress is bounded, monotonic, content free and terminal', async () => {
  const observations = [];
  const progress = createStorageStartupProgress((value) => observations.push(value));
  for (const phase of [
    'worker_started',
    'paths_ready',
    'ownership_acquired',
    'key_unprotect_started',
  ])
    progress.advance(phase);
  for (const invalid of [
    undefined,
    null,
    {},
    '',
    'secret-value',
    'ready',
    'worker_started',
    'key_unprotect_started',
  ])
    assert.throws(() => progress.advance(invalid), safeFailure);
  progress.finish(false);
  progress.finish(true);
  assert.throws(() => progress.advance('engine_ready'), safeFailure);
  assert.deepEqual(
    observations.map((value) => value.phase),
    ['worker_started', 'paths_ready', 'ownership_acquired', 'key_unprotect_started', 'failed']
  );
  for (const value of observations) {
    assert.deepEqual(Object.keys(value).sort(), ['elapsedMs', 'phase']);
    assert.equal(Object.isFrozen(value), true);
    assert.ok(Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0);
  }
  for (const invalid of [null, {}, 'secret-value'])
    assert.throws(() => createStorageStartupProgress(invalid), safeFailure);
  let invoked = 0;
  for (const observer of [
    () => {
      throw new Error('secret-value');
    },
    async () => {
      throw new Error('secret-value');
    },
    () => ({
      get then() {
        invoked++;
        throw new Error('secret-value');
      },
    }),
  ]) {
    const quiet = createStorageStartupProgress(observer);
    quiet.advance('worker_started');
    quiet.finish(true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invoked, 0);
});

test('worker startup reports validated phases without granting readiness or changing results', async () => {
  const f = fakeWorkers();
  const observations = [];
  let admitted = false;
  const opening = openContextRecoveryStorage({
    directory: path.join(os.tmpdir(), 'synthetic-context'),
    WorkerType: f.FakeWorker,
    onStartup: (event) => observations.push(event),
  }).then((service) => {
    admitted = true;
    return service;
  });
  const worker = f.workers[0];
  for (const phase of [
    'worker_started',
    'paths_started',
    'paths_ready',
    'ownership_started',
    'ownership_acquired',
    'key_protect_started',
    'key_protect_finished',
    'key_write_started',
    'key_file_open_started',
    'key_file_opened',
    'key_acl_started',
    'key_acl_finished',
    'key_file_write_started',
    'key_file_write_finished',
    'key_file_flush_started',
    'key_file_flush_finished',
    'key_file_closed',
    'key_file_readback_started',
    'key_file_readback_finished',
    'key_write_finished',
    'key_unprotect_started',
    'key_unprotect_finished',
    'database_prepare_started',
    'database_prepared',
    'engine_ready',
  ])
    worker.emit('message', { id: 0, ok: true, phase });
  await Promise.resolve();
  assert.equal(admitted, false);
  worker.emit('message', { id: 0, ok: true });
  const service = await opening;
  assert.equal(admitted, true);
  assert.deepEqual(
    observations.map((event) => event.phase),
    [
      'worker_started',
      'paths_started',
      'paths_ready',
      'ownership_started',
      'ownership_acquired',
      'key_protect_started',
      'key_protect_finished',
      'key_write_started',
      'key_file_open_started',
      'key_file_opened',
      'key_acl_started',
      'key_acl_finished',
      'key_file_write_started',
      'key_file_write_finished',
      'key_file_flush_started',
      'key_file_flush_finished',
      'key_file_closed',
      'key_file_readback_started',
      'key_file_readback_finished',
      'key_write_finished',
      'key_unprotect_started',
      'key_unprotect_finished',
      'database_prepare_started',
      'database_prepared',
      'engine_ready',
      'ready',
    ]
  );
  assert.deepEqual(Object.keys(worker.options.workerData), ['directory']);
  await closeFixture({ service, worker });
});

test('invalid, duplicated, reordered or post-ready startup frames fail closed', async () => {
  let getter = 0;
  for (const input of [
    { id: 0, ok: true, phase: 'secret-value' },
    { id: 0, ok: true, phase: null },
    { id: 0, ok: false, phase: 'paths_ready' },
    { id: 1, ok: true, phase: 'paths_ready' },
    { id: 0, ok: true, phase: 'paths_ready', text: state.text },
    {
      id: 0,
      ok: true,
      get phase() {
        getter++;
        return 'paths_ready';
      },
    },
    { id: 0, ok: true, phase: 'worker_started' },
  ]) {
    const f = fakeWorkers();
    const phases = [];
    const failed = assert.rejects(
      openContextRecoveryStorage({
        directory: path.join(os.tmpdir(), 'synthetic-context'),
        WorkerType: f.FakeWorker,
        onStartup: ({ phase }) => phases.push(phase),
      }),
      safeFailure
    );
    f.workers[0].emit('message', { id: 0, ok: true, phase: 'worker_started' });
    f.workers[0].emit('message', input);
    await failed;
    assert.deepEqual(phases, ['worker_started', 'failed']);
    f.workers[0].emit('message', { id: 0, ok: true });
    assert.equal(f.workers[0].terminations, 1);
  }
  const reordered = fakeWorkers();
  const failed = assert.rejects(
    openContextRecoveryStorage({
      directory: path.join(os.tmpdir(), 'synthetic-context'),
      WorkerType: reordered.FakeWorker,
    }),
    safeFailure
  );
  reordered.workers[0].emit('message', { id: 0, ok: true, phase: 'key_unprotect_started' });
  reordered.workers[0].emit('message', { id: 0, ok: true, phase: 'paths_ready' });
  await failed;
  const ready = await openedFixture();
  ready.worker.emit('message', { id: 0, ok: true, phase: 'engine_ready' });
  await assert.rejects(ready.service.execute({ operation: 'inspect' }), safeFailure);
  assert.equal(getter, 0);
});

test('startup progress cannot reset the original deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeWorkers();
  const phases = [];
  const failed = assert.rejects(
    openContextRecoveryStorage({
      directory: path.join(os.tmpdir(), 'synthetic-context'),
      WorkerType: f.FakeWorker,
      timeoutMs: 100,
      onStartup: ({ phase }) => phases.push(phase),
    }),
    safeFailure
  );
  t.mock.timers.tick(80);
  f.workers[0].emit('message', { id: 0, ok: true, phase: 'worker_started' });
  t.mock.timers.tick(19);
  f.workers[0].emit('message', { id: 0, ok: true, phase: 'paths_ready' });
  assert.equal(f.workers[0].terminations, 0);
  t.mock.timers.tick(1);
  await failed;
  assert.equal(f.workers[0].terminations, 1);
  assert.deepEqual(phases, ['worker_started', 'paths_ready', 'failed']);
});

test('owner emits only fixed phases and observer failures preserve ownership and key failure', async () => {
  const fixture = temporary();
  let owner;
  const phases = [];
  try {
    owner = createStorageOwner(
      {
        directory: fixture.directory,
        protectKey: fixtureKey,
        onStartup: ({ phase }) => {
          phases.push(phase);
          throw new Error('secret-value');
        },
      },
      syntheticAnchorDependencies
    );
    assert.deepEqual(phases, [
      'paths_started',
      'paths_ready',
      'ownership_started',
      'ownership_acquired',
      'key_protect_started',
      'key_protect_finished',
      'key_write_started',
      'key_file_open_started',
      'key_file_opened',
      'key_acl_started',
      'key_acl_finished',
      'key_file_write_started',
      'key_file_write_finished',
      'key_file_flush_started',
      'key_file_flush_finished',
      'key_file_closed',
      'key_file_readback_started',
      'key_file_readback_finished',
      'key_write_finished',
      'anchor_open_started',
      'anchor_opened',
      'database_prepare_started',
      'database_prepared',
      'database_opened',
      'engine_prepare_started',
      'engine_prepared',
      'anchor_persist_started',
      'anchor_persist_finished',
      'engine_ready',
    ]);
    assert.deepEqual(owner.execute(save()), { revision: 1 });
    owner.close();
    owner = undefined;
    phases.length = 0;
    assert.throws(
      () =>
        createStorageOwner(
          {
            directory: fixture.directory,
            protectKey() {
              throw new Error('secret-value');
            },
            onStartup: ({ phase }) => phases.push(phase),
          },
          syntheticAnchorDependencies
        ),
      safeFailure
    );
    assert.deepEqual(phases, [
      'paths_started',
      'paths_ready',
      'ownership_started',
      'ownership_acquired',
      'key_unprotect_started',
    ]);
    owner = createStorageOwner(
      { directory: fixture.directory, protectKey: fixtureKey },
      syntheticAnchorDependencies
    );
    assert.equal(owner.execute({ operation: 'load', scope }).state.text, state.text);
  } finally {
    owner?.close();
    fixture.clean();
  }
});

test('anchor startup failures retain the exact bounded phase and release the writer without leaking errors', () => {
  for (const failure of ['construct', 'read', 'enroll', 'persist']) {
    const fixture = temporary();
    const phases = [];
    const factory = createSyntheticRetainedAnchorFactory();
    let commits = 0;
    try {
      assert.throws(
        () =>
          createStorageOwner(
            {
              directory: fixture.directory,
              protectKey: fixtureKey,
              onStartup: ({ phase }) => phases.push(phase),
            },
            {
              createAnchorRepository(options) {
                if (failure === 'construct') throw Error('PRIVATE_ANCHOR_SENTINEL');
                const repository = factory(options);
                return {
                  ...repository,
                  read() {
                    if (failure === 'read') throw Error('PRIVATE_ANCHOR_SENTINEL');
                    return repository.read();
                  },
                  commit(snapshot) {
                    commits++;
                    if (
                      (failure === 'enroll' && commits === 1) ||
                      (failure === 'persist' && commits === 2)
                    )
                      throw Error('PRIVATE_ANCHOR_SENTINEL');
                    return repository.commit(snapshot);
                  },
                };
              },
            }
          ),
        safeFailure
      );
      const last =
        failure === 'construct' || failure === 'read'
          ? 'anchor_open_started'
          : failure === 'enroll'
            ? 'engine_prepare_started'
            : 'anchor_persist_started';
      assert.equal(phases.at(-1), last, failure);
      assert.equal(phases.includes('engine_ready'), false);
      assert.equal(JSON.stringify(phases).includes('PRIVATE_ANCHOR_SENTINEL'), false);
      // A failed owner must release the same actual SQLite writer lock.
      const mutex = new DatabaseSync(path.join(fixture.directory, '.writer.sqlite'));
      try {
        mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
      } finally {
        mutex.close();
      }
    } finally {
      fixture.clean();
    }
  }
});

test('fresh storage uses one verified protect call and reopened storage must unprotect the persisted key', () => {
  const fixture = temporary();
  const operations = [];
  let owner;
  const protectKey = (request) => {
    operations.push(request.operation);
    return fixtureKey(request);
  };
  try {
    owner = createStorageOwner(
      { directory: fixture.directory, protectKey },
      syntheticAnchorDependencies
    );
    assert.deepEqual(operations, ['protect']);
    assert.deepEqual(owner.execute(save()), { revision: 1 });
    owner.close();
    owner = undefined;
    owner = createStorageOwner(
      { directory: fixture.directory, protectKey },
      syntheticAnchorDependencies
    );
    assert.deepEqual(operations, ['protect', 'unprotect']);
    assert.equal(owner.execute({ operation: 'load', scope }).state.text, state.text);
  } finally {
    owner?.close();
    fixture.clean();
  }
});

test('worker service validates replies, limits queued count and bytes, and closes only after acknowledged exit', async () => {
  const fixture = await openedFixture();
  const { service, worker } = fixture;
  assert.equal(worker.drained, 2);
  assert.deepEqual(Object.keys(worker.options).sort(), [
    'execArgv',
    'stderr',
    'stdout',
    'workerData',
  ]);
  assert.deepEqual(worker.options.execArgv, []);
  assert.deepEqual(Object.keys(worker.options.workerData), ['directory']);
  const pending = Array.from({ length: 8 }, () => service.execute({ operation: 'inspect' }));
  await assert.rejects(service.execute({ operation: 'inspect' }), safeFailure);
  pending.forEach((_, index) => reply(worker, index, { records: 0, bytes: 0 }));
  await Promise.all(pending);
  const large = service.execute({ ...save(), state: { text: 'x'.repeat(9 * 1024 * 1024) } });
  await assert.rejects(
    service.execute({ ...save(), state: { text: 'x'.repeat(9 * 1024 * 1024) } }),
    safeFailure
  );
  reply(worker, 8, { revision: 1 });
  await large;
  await assert.rejects(service.execute(null), safeFailure);
  let done = false;
  const close = service.close().then(() => {
    done = true;
  });
  assert.equal(service.close() instanceof Promise, true);
  await assert.rejects(service.execute({ operation: 'inspect' }), safeFailure);
  reply(worker, 9, null);
  await Promise.resolve();
  assert.equal(done, false);
  worker.emit('exit', 0);
  await close;
  await service.close();
  assert.equal(worker.terminations, 0);
});

test('worker queue accounts versioned bytes separately and releases capacity after replies', async () => {
  const fixture = await openedFixture(60000);
  const { service, worker } = fixture;
  // This fake worker isolates transport accounting. SQLite tests separately
  // reject synthetic checkpoints that do not satisfy the semantic codecs.
  const modern = {
    ...save(),
    state: {
      kind: 'recovery-write-ahead',
      root: { kind: 'recovery-root', version: 9 },
      synthetic: 'x'.repeat(44 * 1024 * 1024),
    },
  };
  const legacy = { ...save(), state: { text: 'x'.repeat(9 * 1024 * 1024) } };
  const first = service.execute(modern);
  const second = service.execute(modern);
  await assert.rejects(service.execute(modern), safeFailure);
  assert.equal(worker.messages.length, 2);
  const old = service.execute(legacy);
  await assert.rejects(service.execute(legacy), safeFailure);
  assert.equal(worker.messages.length, 3);
  reply(worker, 0, { revision: 1 });
  await first;
  const replacement = service.execute(modern);
  assert.equal(worker.messages.length, 4);
  reply(worker, 1, { revision: 1 });
  reply(worker, 2, { revision: 1 });
  reply(worker, 3, { revision: 1 });
  await Promise.all([second, old, replacement]);
  const oldAgain = service.execute(legacy);
  reply(worker, 4, { revision: 1 });
  await oldAgain;
  await closeFixture(fixture);
});

test('worker service validates exact atomic revocation acknowledgements without revision retry', async () => {
  const entry = { scope, createdAt: 100, expiresAt: 1000 };
  for (const operation of ['revoke-scopes', 'revoke-all']) {
    const request = operation === 'revoke-all' ? { operation } : { operation, entries: [entry] };
    const good = await openedFixture();
    const pending = good.service.execute(request);
    reply(good.worker, 0, { revoked: 1 });
    assert.equal((await pending).revoked, 1);
    await closeFixture(good);
    for (const value of [
      null,
      {},
      { revoked: '1' },
      { revoked: -1 },
      { revoked: 257 },
      { revoked: 1, secret: 'secret-value' },
      ...(operation === 'revoke-scopes' ? [{ revoked: 0 }, { revoked: 2 }] : []),
    ]) {
      const f = await openedFixture();
      const failed = assert.rejects(f.service.execute(request), safeFailure);
      reply(f.worker, 0, value);
      await failed;
      assert.equal(f.worker.messages.length, 1);
      await assert.rejects(f.service.close(), safeFailure);
    }
  }
});

test('worker startup catalog rejects malformed replies and never forwards content or selectors', async () => {
  const entry = { scope, revision: 1, createdAt: 100, expiresAt: 1000 };
  for (const value of [[], [entry]]) {
    const f = await openedFixture();
    const pending = f.service.execute({ operation: 'catalog' });
    assert.deepEqual(json(f.worker.messages[0].request), { operation: 'catalog' });
    reply(f.worker, 0, value);
    assert.deepEqual(json(await pending), value);
    await closeFixture(f);
  }
  for (const value of [
    null,
    {},
    [entry, entry],
    Array(5).fill(entry),
    [{ ...entry, state }],
    [{ ...entry, revision: 0 }],
    [
      {
        ...entry,
        get scope() {
          throw new Error('secret-value');
        },
      },
    ],
  ]) {
    const f = await openedFixture();
    const failed = assert.rejects(f.service.execute({ operation: 'catalog' }), safeFailure);
    reply(f.worker, 0, value);
    await failed;
    await assert.rejects(f.service.close(), safeFailure);
  }
});

test('worker service fails on startup, post errors, invalid/duplicate replies, early exit and timeout', async () => {
  for (const mode of [
    'startup',
    'readyFailed',
    'readyInvalid',
    'openTimeout',
    'post',
    'badReply',
    'duplicate',
    'error',
    'exit',
    'timeout',
    'closeNoExit',
  ]) {
    const fixture = fakeWorkers();
    class FailureWorker extends fixture.FakeWorker {
      constructor(...args) {
        if (mode === 'startup') throw new Error('secret-value');
        super(...args);
      }
      postMessage(message) {
        if (mode === 'post') throw new Error('secret-value');
        super.postMessage(message);
      }
    }
    const opening = openContextRecoveryStorage({
      directory: path.join(os.tmpdir(), 'synthetic-context'),
      WorkerType: FailureWorker,
      timeoutMs: 100,
    });
    const worker = fixture.workers[0];
    if (mode === 'startup') {
      await assert.rejects(opening, safeFailure);
      continue;
    }
    if (mode === 'openTimeout') {
      await assert.rejects(opening, safeFailure);
      continue;
    }
    if (mode === 'readyFailed' || mode === 'readyInvalid') {
      const failed = assert.rejects(opening, safeFailure);
      worker.emit(
        'message',
        mode === 'readyFailed' ? { id: 0, ok: false } : { id: 0, ok: true, result: null }
      );
      await failed;
      continue;
    }
    worker.emit('message', { id: 0, ok: true });
    const service = await opening;
    if (mode === 'closeNoExit') {
      const failed = assert.rejects(service.close(), safeFailure);
      reply(worker, 0, null);
      await failed;
    } else {
      const operation = service.execute({ operation: 'inspect' });
      const failed = mode === 'duplicate' ? operation : assert.rejects(operation, safeFailure);
      if (mode === 'badReply')
        worker.emit('message', { id: 1, ok: true, result: { records: 99, bytes: 0 } });
      if (mode === 'duplicate') {
        reply(worker, 0, { records: 0, bytes: 0 });
        worker.emit('message', { id: 1, ok: true, result: null });
      }
      if (mode === 'error') worker.emit('error', new Error('secret-value'));
      if (mode === 'exit') worker.emit('exit', 0);
      if (mode === 'duplicate') {
        assert.deepEqual(json(await operation), { records: 0, bytes: 0 });
        await assert.rejects(service.execute({ operation: 'inspect' }), safeFailure);
      } else await failed;
    }
    await assert.rejects(service.close(), safeFailure);
    worker.emit('message', { id: 999, ok: true });
    worker.emit('exit', 1);
  }
});

test('worker operation failures remain safe while valid load and mutation replies preserve their contract', async () => {
  const fixture = await openedFixture();
  const { service, worker } = fixture;
  const rejected = assert.rejects(service.execute(save()), safeFailure);
  worker.emit('message', { id: worker.messages[0].id, ok: false });
  await rejected;
  const missing = service.execute({ operation: 'load', scope });
  reply(worker, 1, null);
  assert.equal(await missing, null);
  const loaded = service.execute({ operation: 'load', scope });
  reply(worker, 2, { revision: 1, createdAt: 100, expiresAt: 1000, state });
  assert.deepEqual(json((await loaded).state), state);
  const revoked = service.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  reply(worker, 3, { revision: 2 });
  assert.equal((await revoked).revision, 2);
  await closeFixture(fixture);
  for (const result of [{ revision: 2 }, { revision: 1, secret: 'secret-value' }]) {
    const invalid = await openedFixture();
    const failure = assert.rejects(invalid.service.execute(save()), safeFailure);
    reply(invalid.worker, 0, result);
    await failure;
    await assert.rejects(invalid.service.close(), safeFailure);
  }
});

test(
  'real storage worker protects its key, isolates writers and reopens exact synthetic state',
  { timeout: 120000 },
  async (t) => {
    const fixture = temporary();
    let attempt = 0;
    const open = () => {
      const current = ++attempt;
      return openContextRecoveryStorage({
        directory: fixture.directory,
        onStartup: (event) =>
          t.diagnostic('storage_startup ' + JSON.stringify({ attempt: current, ...event })),
      });
    };
    let first, reopened;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(open(), safeFailure);
        return;
      }
      first = await open();
      assert.deepEqual(json(await first.execute(save())), { revision: 1 });
      await assert.rejects(open(), safeFailure);
      assert.deepEqual(json((await first.execute({ operation: 'load', scope })).state), state);
      const wrapped = fs.readFileSync(path.join(fixture.directory, '.data-key'), 'utf8');
      assert.ok(wrapped.startsWith(KEY_PREFIX));
      assert.equal(wrapped.includes(state.marker), false);
      assert.equal(
        fs
          .readFileSync(path.join(fixture.directory, 'checkpoint.sqlite'))
          .includes(Buffer.from(state.marker)),
        false
      );
      await first.close();
      first = undefined;
      reopened = await open();
      assert.deepEqual(json((await reopened.execute({ operation: 'load', scope })).state), state);
      const catalog = await reopened.execute({ operation: 'catalog' });
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0].scope, scope);
      assert.equal(catalog[0].revision, 1);
      await reopened.execute({ operation: 'revoke', scope, expectedRevision: 1 });
      await reopened.close();
      reopened = undefined;
      reopened = await open();
      assert.equal(await reopened.execute({ operation: 'load', scope }), null);
      assert.deepEqual(json(await reopened.execute({ operation: 'catalog' })), []);
    } finally {
      await first?.close();
      await reopened?.close();
      fixture.clean();
    }
  }
);

test(
  'storage worker isolates process preload while initializing and closing real storage',
  { skip: process.platform !== 'win32', timeout: 60000 },
  () => {
    const fixture = temporary();
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--require',
          path.join(__dirname, 'helpers/context-recovery-worker-preload.cjs'),
          path.join(__dirname, 'helpers/context-recovery-worker-entry.cjs'),
          'storage',
          fixture.directory,
        ],
        { input: '1', encoding: 'utf8', timeout: 55000, maxBuffer: 8192, windowsHide: true }
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, 'isolated storage child must close successfully');
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, closed: true });
      assert.doesNotMatch(result.stderr, /synthetic_worker_preload_replayed/);
      for (const name of ['checkpoint.sqlite', '.writer.sqlite', '.data-key'])
        assert.equal(fs.lstatSync(path.join(fixture.directory, name)).isFile(), true);
    } finally {
      fixture.clean();
    }
  }
);
