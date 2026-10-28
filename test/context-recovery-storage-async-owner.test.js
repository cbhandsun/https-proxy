'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecoveryAnchorSession } = require('../lib/proxy/context-recovery-anchor');
const { createAsyncStorageOwner } = require('../lib/proxy/context-recovery-storage-owner');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');
const { DatabaseSync } = require('node:sqlite');
const { types } = require('node:util');
const { storageFailureDiagnostic } = require('../lib/proxy/context-recovery-storage-failure');
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' && error.message === error.code;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t, delayedEngine = false, delayedKeyPersistence = false) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-async-owner-'));
  const directory = path.join(root, 'store'),
    executable = path.join(root, 'native.exe');
  fs.writeFileSync(executable, 'synthetic-anchor-backend');
  const rows = new Map(),
    owners = [],
    gates = [];
  let writes = 0,
    closes = 0,
    channels = 0,
    syncWrites = 0,
    failed = false;
  let nativeTime = 0,
    readinessObserved = false,
    engineSawReady = false;
  const startupPhases = [];
  const channelStartup = [];
  let replyValue = (text) => text;
  let waitReply = async () => {},
    waitClose = async () => {};
  let protectionFailure;
  let nativeRequests = 0;
  const protectionSamples = [];
  const protectKey = ({ operation, value }) => {
    if (operation !== 'protect') return value.slice(KEY_PREFIX.length);
    protectionSamples.push({
      channels,
      nativeRequests,
      writes,
      keyExists: fs.existsSync(path.join(directory, '.data-key')),
      databaseExists: fs.existsSync(path.join(directory, 'checkpoint.sqlite')),
    });
    if (protectionFailure === 'throw') throw Error('PRIVATE synthetic key protection failure');
    if (protectionFailure === 'malformed') return KEY_PREFIX + 'not-base64';
    if (protectionFailure === 'collision')
      fs.writeFileSync(path.join(directory, '.data-key'), 'synthetic collision', { flag: 'wx' });
    return KEY_PREFIX + value;
  };
  const execute = (text) => {
    nativeRequests++;
    const request = JSON.parse(text),
      prior = rows.get(request.slot) ?? { revision: 0, value: null };
    if (request.operation === 'read') return JSON.stringify({ ok: true, ...prior });
    writes++;
    if (failed) throw Error('PRIVATE synthetic flush failure');
    assert.equal(request.expectedRevision, prior.revision);
    const next = { revision: prior.revision + 1, value: request.value };
    rows.set(request.slot, next);
    return JSON.stringify({ ok: true, ...next });
  };
  const createAnchorSession = (input) =>
    createRecoveryAnchorSession(input, {
      platform: 'win32',
      nativeExecutable: executable,
      environment: { SystemRoot: 'C:\\Windows' },
      execute: (_file, _args, options) => {
        if (JSON.parse(options.input).operation !== 'read') syncWrites++;
        return execute(options.input);
      },
      createChannel: () => {
        channels++;
        channelStartup.push({ phase: startupPhases.at(-1), writes });
        if (delayedEngine) {
          const { ChildProcess } = require('node:child_process');
          const { PassThrough } = require('node:stream');
          const {
            createRecoveryAnchorChannel,
          } = require('../lib/proxy/context-recovery-anchor-channel');
          const child = new ChildProcess();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
          child.kill = () => {
            queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
            return true;
          };
          child.stdin.on('end', () => queueMicrotask(() => child.emit('close', 0)));
          child.stdin.on('data', (frame) => {
            const reply = Buffer.from(execute(frame.subarray(8).toString('utf8')));
            const header = Buffer.alloc(8);
            header.writeUInt32LE(frame.readUInt32LE(0), 0);
            header.writeUInt32LE(reply.length, 4);
            queueMicrotask(() => child.stdout.write(Buffer.concat([header, reply])));
          });
          return createRecoveryAnchorChannel(
            { executable, systemRoot: 'C:\\Windows' },
            {
              monotonic: () => nativeTime,
              spawnChild() {
                queueMicrotask(() => {
                  child.stdout.write(Buffer.alloc(8));
                  readinessObserved = true;
                });
                return child;
              },
            }
          );
        }
        return {
          async execute(text) {
            const reply = execute(text);
            await waitReply();
            return replyValue(reply);
          },
          async close() {
            closes++;
            await waitClose();
          },
        };
      },
    });
  const open = (onExecutionProgress) => {
    const owner = createAsyncStorageOwner(
      {
        directory,
        protectKey,
        onStartup: ({ phase }) => {
          startupPhases.push(phase);
          if (delayedKeyPersistence && phase === 'key_write_started') nativeTime = 10001;
          if (delayedEngine && phase === 'engine_prepare_started') {
            engineSawReady = readinessObserved;
            nativeTime = 10001;
          }
        },
        onExecutionProgress,
      },
      { createAnchorSession }
    );
    if (types.isPromise(owner))
      return owner.then((ready) => {
        owners.push(ready);
        return ready;
      });
    owners.push(owner);
    return owner;
  };
  t.after(async () => {
    for (const held of gates) held.resolve();
    for (const owner of owners) await owner.close();
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    open,
    directory,
    rows,
    writes: () => writes,
    closes: () => closes,
    channels: () => channels,
    channelStartup: () => [...channelStartup],
    protectionSamples: () => [...protectionSamples],
    rejectProtection(mode) {
      protectionFailure = mode;
    },
    nativeRequests: () => nativeRequests,
    engineSawReady: () => engineSawReady,
    syncWrites: () => syncWrites,
    startupPhases: () => [...startupPhases],
    corruptReply(mode) {
      replyValue = (text) => {
        if (mode === 'empty') return '';
        if (mode === 'malformed') return '{';
        const value = JSON.parse(text);
        value.revision = mode === 'extreme-revision' ? Number.MAX_SAFE_INTEGER : value.revision + 1;
        return JSON.stringify(value);
      };
    },
    validReply() {
      replyValue = (text) => text;
    },
    rejectReply() {
      waitReply = async () => {
        throw Error('PRIVATE synthetic reply failure');
      };
    },
    resumeReplies() {
      waitReply = async () => {};
    },
    fail() {
      failed = true;
    },
    restore() {
      failed = false;
    },
    holdReply() {
      const held = gate();
      gates.push(held);
      waitReply = () => held.promise;
      return held;
    },
    holdClose() {
      const held = gate();
      gates.push(held);
      waitClose = () => held.promise;
      return held;
    },
  };
}
const scope = 'a'.repeat(64);
const save = (owner, expiresAt, revision = 0) =>
  owner.execute({
    operation: 'save',
    scope,
    expectedRevision: revision,
    expiresAt,
    state: { original: 'PRIVATE synthetic', calls: 4 - revision },
  });

test('execution observation distinguishes the retained anchor wait from SQL completion without acknowledging early', async (t) => {
  const f = fixture(t),
    events = [],
    owner = await f.open((event) => events.push(event));
  assert.equal(events.length, 0, 'startup does not masquerade as a request');
  const held = f.holdReply();
  let acknowledged = false;
  const pending = save(owner, Date.now() + 60000).then((value) => {
    acknowledged = true;
    return value;
  });
  await turn();
  assert.equal(events.at(-1).phase, 'anchor_persist_started');
  assert.ok(events.some((event) => event.phase === 'engine_execute_finished'));
  assert.ok(events.some((event) => event.phase === 'engine_snapshot_finished'));
  assert.equal(acknowledged, false);
  assert.equal(
    events.some((event) => event.phase === 'completed'),
    false
  );
  held.resolve();
  assert.deepEqual(await pending, { revision: 1 });
  assert.equal(events.at(-1).phase, 'completed');
  assert.equal(events.length, 11);
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
  await assert.rejects(save(owner, Date.now() + 60000), safe);
  assert.equal(events.at(-1).phase, 'failed');
  assert.equal(events.at(-1).sequence, 2);
  await owner.close();
});

test('async owner retains synchronous empty intent and durable startup, waits for exact ACK and reopens unchanged expiry', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  assert.equal(f.writes(), 2);
  const held = f.holdReply(),
    pending = save(owner, expiresAt);
  let acknowledged = false;
  void pending.then(() => {
    acknowledged = true;
  });
  await turn();
  assert.equal(acknowledged, false);
  const db = new DatabaseSync(path.join(f.directory, 'checkpoint.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM recovery_state').get().count, 1);
  } finally {
    db.close();
  }
  await assert.rejects(owner.execute({ operation: 'inspect' }), safe);
  held.resolve();
  assert.deepEqual(await pending, { revision: 1 });
  await owner.close();
  const reopened = await f.open();
  const state = await reopened.execute({ operation: 'load', scope });
  assert.equal(state.expiresAt, expiresAt);
  assert.equal(state.revision, 1);
});

test('failed post-SQL ACK never succeeds and writer lock remains held until actual channel close', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const held = f.holdClose();
  f.fail();
  const pending = save(owner, expiresAt, 1),
    rejected = assert.rejects(pending, (error) => {
      assert.deepEqual(storageFailureDiagnostic(error), {
        phase: 'anchor-request',
        cleanupFailed: false,
      });
      return safe(error);
    });
  await turn();
  assert.equal(f.closes(), 1);
  assert.throws(f.open, safe, 'cannot grant another writer while native cleanup is pending');
  held.resolve();
  await rejected;
  await assert.rejects(owner.execute({ operation: 'load', scope }), safe);
  f.restore();
  const reopened = await f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).revision, 2);
});

test('rejected stale SQL remains retryable and does not submit another anchor write', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const writes = f.writes();
  await assert.rejects(save(owner, expiresAt), (error) => {
    assert.deepEqual(storageFailureDiagnostic(error), {
      phase: 'engine-execute',
      cleanupFailed: false,
    });
    return safe(error);
  });
  assert.equal(f.writes(), writes);
  assert.deepEqual(await save(owner, expiresAt, 1), { revision: 2 });
});

test('close during async ACK holds the writer lock, rejects in-flight result and is idempotent', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    reply = f.holdReply(),
    closed = f.holdClose();
  const rejected = assert.rejects(save(owner, Date.now() + 60000), safe),
    closing = owner.close();
  assert.equal(owner.close(), closing);
  reply.resolve();
  await turn();
  assert.throws(f.open, safe);
  closed.resolve();
  await closing;
  await rejected;
  const reopened = await f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).revision, 1);
});

test('path verification failure closes an already-used async channel before releasing writer authority', async (t) => {
  const f = fixture(t),
    owner = await f.open(),
    expiresAt = Date.now() + 60000;
  await save(owner, expiresAt);
  const key = path.join(f.directory, '.data-key'),
    moved = key + '-moved';
  const held = f.holdClose();
  fs.renameSync(key, moved);
  const rejected = assert.rejects(owner.execute({ operation: 'inspect' }), safe);
  await turn();
  assert.equal(f.closes(), 1);
  const lock = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  try {
    assert.throws(() => lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'));
  } finally {
    lock.close();
  }
  held.resolve();
  await rejected;
  fs.renameSync(moved, key);
  const reopened = await f.open();
  assert.equal((await reopened.execute({ operation: 'load', scope })).expiresAt, expiresAt);
});

test('async startup waits for its real channel ACK and reuses that channel for the first request', async (t) => {
  const f = fixture(t),
    held = f.holdReply(),
    pending = f.open();
  assert.equal(types.isPromise(pending), true, 'startup must await the owned native channel');
  let ready = false;
  void pending.then(() => {
    ready = true;
  });
  await turn();
  assert.equal(ready, false);
  assert.equal(
    f.syncWrites(),
    1,
    'empty enrollment intent still precedes SQL COMMIT synchronously'
  );
  assert.equal(f.writes(), 2);
  assert.equal(f.channels(), 1);
  assert.throws(f.open, safe, 'pending startup retains the exclusive writer');
  held.resolve();
  const owner = await pending;
  assert.equal(f.startupPhases().filter((phase) => phase === 'engine_ready').length, 1);
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
  assert.equal(f.channels(), 1, 'first operation cannot spawn another anchor channel');
  assert.equal(f.syncWrites(), 1, 'startup final ACK must not use another one-shot process');
});

test('failed startup ACK stays rejected and retains writer authority until actual channel cleanup', async (t) => {
  const f = fixture(t),
    held = f.holdClose();
  f.rejectReply();
  const pending = f.open();
  assert.equal(types.isPromise(pending), true);
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(storageFailureDiagnostic(error).phase, 'anchor-request');
    return safe(error);
  });
  await turn();
  assert.equal(f.closes(), 1);
  assert.throws(f.open, safe);
  held.resolve();
  await rejected;
  f.resumeReplies();
  const reopened = await f.open();
  assert.deepEqual(await reopened.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

for (const mode of ['empty', 'malformed', 'wrong-revision', 'extreme-revision']) {
  test(
    'async startup rejects ' + mode + ' ACK, closes the channel and never returns ready',
    async (t) => {
      const f = fixture(t);
      f.corruptReply(mode);
      await assert.rejects(f.open(), safe);
      assert.equal(f.startupPhases().includes('engine_ready'), false);
      assert.equal(f.closes(), 1);
      assert.equal(f.syncWrites(), 1);
      f.validReply();
      const owner = await f.open();
      assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
    }
  );
}

test('path replacement during startup ACK cannot return ready or release its writer before cleanup', async (t) => {
  const f = fixture(t),
    reply = f.holdReply(),
    cleanup = f.holdClose();
  const pending = f.open();
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(storageFailureDiagnostic(error).phase, 'owner-verify');
    return safe(error);
  });
  await turn();
  const key = path.join(f.directory, '.data-key'),
    moved = key + '-during-startup';
  fs.renameSync(key, moved);
  reply.resolve();
  await turn();
  assert.equal(f.startupPhases().includes('engine_ready'), false);
  assert.equal(f.closes(), 1);
  const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  try {
    assert.throws(() => mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'));
  } finally {
    mutex.close();
  }
  cleanup.resolve();
  await rejected;
  fs.renameSync(moved, key);
  const owner = await f.open();
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

test('early transport prestart leaves the original readiness window after key persistence', async (t) => {
  const f = fixture(t, true, true);
  const owner = await f.open();
  assert.equal(f.engineSawReady(), true);
  assert.equal(f.channels(), 1);
  assert.equal(f.syncWrites(), 1);
  assert.equal(f.writes(), 2);
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

test('fresh owner primes only its idle transport before protecting or persisting its real key', async (t) => {
  const f = fixture(t);
  const owner = await f.open();
  assert.deepEqual(f.channelStartup(), [{ phase: 'key_protect_started', writes: 0 }]);
  assert.equal(f.channels(), 1);
  assert.deepEqual(f.protectionSamples(), [
    { channels: 1, nativeRequests: 0, writes: 0, keyExists: false, databaseExists: false },
  ]);
  assert.equal(f.syncWrites(), 1, 'durable enrollment remains behind key persistence');
  assert.equal(f.writes(), 2, 'idle process readiness cannot replace the final durable ACK');
  await owner.close();
  const reopened = await f.open();
  assert.equal(
    f.channelStartup()[1].phase,
    'anchor_open_started',
    'existing keys are unprotected before session binding'
  );
  assert.deepEqual(await reopened.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

for (const mode of ['throw', 'malformed', 'collision']) {
  test('early idle transport closes before writer release after key ' + mode, async (t) => {
    const f = fixture(t),
      held = f.holdClose();
    f.rejectProtection(mode);
    const pending = f.open();
    assert.equal(types.isPromise(pending), true);
    const rejected = assert.rejects(pending, safe);
    await turn();
    assert.equal(f.channels(), 1);
    assert.equal(f.closes(), 1);
    assert.equal(
      f.nativeRequests(),
      0,
      'no anchor read or enrollment precedes persisted-key admission'
    );
    assert.equal(fs.existsSync(path.join(f.directory, 'checkpoint.sqlite')), false);
    const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
    try {
      assert.throws(() => mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'));
    } finally {
      mutex.close();
    }
    held.resolve();
    await rejected;
    const released = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
    try {
      released.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
    } finally {
      released.close();
    }
  });
}

test('async owner launches the idle anchor transport before synchronous read and enrollment', async (t) => {
  const f = fixture(t),
    owner = await f.open();
  assert.deepEqual(f.channelStartup(), [{ phase: 'key_protect_started', writes: 0 }]);
  assert.equal(f.syncWrites(), 1);
  assert.equal(f.writes(), 2);
  await owner.execute({ operation: 'inspect' });
  assert.equal(f.channels(), 1);
});

test('synchronous startup rejection awaits the primed child before releasing the SQLite writer', async (t) => {
  const f = fixture(t),
    held = f.holdClose();
  f.fail();
  const pending = f.open();
  assert.equal(types.isPromise(pending), true);
  const rejected = assert.rejects(pending, safe);
  await turn();
  assert.equal(f.closes(), 1);
  assert.equal(f.startupPhases().includes('engine_ready'), false);
  const mutex = new DatabaseSync(path.join(f.directory, '.writer.sqlite'));
  try {
    assert.throws(() => mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'));
  } finally {
    mutex.close();
  }
  held.resolve();
  await rejected;
  f.restore();
  const owner = await f.open();
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

// Model a >10s synchronous SQL/manifest pass with a monotonic test clock, not
// a larger timeout. The real transport readiness frame is queued before it.
test('async owner consumes native readiness before a synchronous engine pass can exhaust its ten-second startup bound', async (t) => {
  const f = fixture(t, true);
  const owner = await f.open();
  assert.equal(f.engineSawReady(), true);
  assert.equal(f.syncWrites(), 1, 'empty intent remains synchronous before SQL commit');
  assert.equal(f.writes(), 2, 'readiness cannot substitute for durable startup ACK');
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});

test('physical replacement while awaiting native readiness rejects startup before SQL admission', async (t) => {
  const f = fixture(t, true);
  const pending = f.open();
  const key = path.join(f.directory, '.data-key'),
    moved = key + '-readiness';
  fs.renameSync(key, moved);
  await assert.rejects(pending, safe);
  assert.equal(f.startupPhases().includes('engine_prepare_started'), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'checkpoint.sqlite')), false);
  assert.equal(f.syncWrites(), 0);
  fs.renameSync(moved, key);
  const owner = await f.open();
  assert.deepEqual(await owner.execute({ operation: 'inspect' }), { records: 0, bytes: 0 });
});
