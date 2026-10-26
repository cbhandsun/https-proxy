'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChildProcess } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { createRecoveryAnchorChannel } = require('../lib/proxy/context-recovery-anchor-channel');
const {
  encodeRecoveryAnchorFrame,
  parseRecoveryAnchorReply,
} = require('../lib/proxy/context-recovery-anchor-protocol');

const request = JSON.stringify({ operation: 'read', slot: 'a'.repeat(64) });
const reply = '{"ok":true,"revision":0,"value":null}';
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503 &&
  error.cause === undefined;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function wire(sequence, bytes) {
  bytes = Buffer.from(bytes);
  const out = Buffer.alloc(8 + bytes.length);
  out.writeUInt32LE(sequence, 0);
  out.writeUInt32LE(bytes.length, 4);
  bytes.copy(out, 8);
  return out;
}
function fixture(t, overrides = {}) {
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const frames = [],
    signals = [],
    timers = new Map();
  let launches = 0,
    time = 0,
    autoClose = true;
  child.stdin.on('data', (value) => frames.push(Buffer.from(value)));
  child.stdin.on('end', () => {
    if (autoClose) queueMicrotask(() => child.emit('close', 0));
  });
  child.kill = (signal) => {
    signals.push(signal);
    if (autoClose) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const options = { executable: process.execPath, systemRoot: 'C:\\Windows' };
  const dependencies = {
    spawnChild(file, args, options) {
      launches++;
      assert.equal(file, process.execPath);
      assert.deepEqual(args, ['--hpm-context-anchor-stream-v1']);
      assert.deepEqual(options, {
        windowsHide: true,
        shell: false,
        env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return child;
    },
    monotonic: () => time,
    scheduleTimer(callback, milliseconds) {
      assert.equal(milliseconds, 10000);
      const token = Symbol('owned-timer');
      timers.set(token, callback);
      return token;
    },
    cancelTimer(token) {
      timers.delete(token);
    },
    ...overrides,
  };
  const channel = createRecoveryAnchorChannel(options, dependencies);
  t.after(async () => {
    child.emit('close', 0);
    await channel.close();
  });
  return {
    channel,
    child,
    frames,
    signals,
    timers,
    execute(text = request) {
      const result = channel.execute(text);
      void result.catch(() => {});
      return result;
    },
    launches: () => launches,
    setTime(value) {
      time = value;
    },
    keepAlive() {
      autoClose = false;
    },
    respond(text = reply, sequence = frames.length) {
      child.stdout.write(wire(sequence, text));
    },
    timeout() {
      time += 10000;
      assert.equal(timers.size, 1);
      [...timers.values()][0]();
    },
  };
}

test('channel reuses exactly one owned child, validates frames and clears each original deadline', async (t) => {
  const f = fixture(t);
  assert.equal(f.launches(), 0);
  for (let i = 1; i <= 3; i++) {
    const result = f.execute();
    assert.deepEqual(f.frames[i - 1], encodeRecoveryAnchorFrame(i, request));
    f.respond(reply, i);
    assert.equal(await result, reply);
    assert.equal(f.timers.size, 0);
  }
  assert.equal(f.launches(), 1);
  await f.channel.close();
  assert.equal(f.signals.length, 0);
  await assert.rejects(f.execute(), safe);
  assert.equal(f.frames.length, 3);
});

test('concurrent invocation is refused without writing or disturbing the original request', async (t) => {
  const f = fixture(t),
    first = f.execute();
  await assert.rejects(f.execute(), safe);
  assert.equal(f.frames.length, 1);
  f.respond();
  assert.equal(await first, reply);
});

test('a previously cancelled request deadline cannot terminate a newer request', async (t) => {
  const f = fixture(t),
    first = f.execute();
  const staleCallback = [...f.timers.values()][0];
  f.respond();
  await first;
  const second = f.execute();
  staleCallback();
  assert.equal(f.signals.length, 0);
  f.respond(reply, 2);
  assert.equal(await second, reply);
});

test('fragmented headers and bodies produce no partial reply and allocate only their bounded frame', async (t) => {
  const f = fixture(t),
    result = f.execute();
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const bytes = wire(1, reply);
  for (const byte of bytes.subarray(0, -1)) f.child.stdout.write(Buffer.from([byte]));
  await turn();
  assert.equal(settled, false);
  f.child.stdout.write(bytes.subarray(-1));
  assert.equal(await result, reply);
});

test('the original maximum native value survives fragmented transport without enlarging its limit', async (t) => {
  const f = fixture(t),
    result = f.execute();
  const text = JSON.stringify({
    ok: true,
    revision: 1,
    value: Buffer.alloc(65536, 42).toString('base64'),
  });
  const bytes = wire(1, text);
  for (let offset = 0; offset < bytes.length; offset += 1024)
    f.child.stdout.write(bytes.subarray(offset, offset + 1024));
  assert.equal(await result, text);
  assert.equal(f.timers.size, 0);
});

test('invalid frame lengths, sequence, UTF8, JSON, duplicate fields or negative ACK kill without retry', async (t) => {
  const bad = [
    Buffer.alloc(8),
    wire(0, reply),
    wire(2, reply),
    Buffer.from([1, 0, 0, 0, 1, 0, 2, 0]),
    wire(1, Buffer.from([255])),
    wire(1, '{}'),
    wire(1, '{"ok":false}'),
    wire(1, '{"ok":true,"revision":0,"value":null,"ok":true}'),
    wire(1, '{"ok":true,"revision":0,"value":null} '),
    Buffer.concat([wire(1, reply), wire(2, reply)]),
  ];
  for (const bytes of bad) {
    const f = fixture(t),
      result = f.execute();
    f.child.stdout.write(bytes);
    await assert.rejects(result, safe);
    await f.channel.close();
    assert.deepEqual(f.signals, ['SIGKILL']);
    await assert.rejects(f.execute(), safe);
    assert.equal(f.launches(), 1);
  }
});

test('timeout marks failure at the original ten seconds but withholds cleanup ACK until actual close', async (t) => {
  const f = fixture(t);
  f.keepAlive();
  const result = f.execute();
  let rejected = false;
  void result.catch(() => {
    rejected = true;
  });
  f.timeout();
  await turn();
  assert.equal(rejected, false);
  assert.deepEqual(f.signals, ['SIGKILL']);
  f.respond();
  await turn();
  assert.equal(rejected, false);
  f.child.emit('exit', null, 'SIGKILL');
  await turn();
  assert.equal(rejected, false);
  f.child.emit('close', null, 'SIGKILL');
  await assert.rejects(result, safe);
  await f.channel.close();
  assert.equal(f.timers.size, 0);
});

test('a delayed timer cannot admit an ACK at or after its monotonic deadline', async (t) => {
  for (const time of [10000, 10001]) {
    const f = fixture(t),
      result = f.execute();
    f.setTime(time);
    f.respond();
    await assert.rejects(result, safe);
    assert.deepEqual(f.signals, ['SIGKILL']);
  }
});

test('spawn latency and response validation remain inside the original monotonic deadline', async (t) => {
  let calls = 0;
  const f = fixture(t, { monotonic: () => (calls++ ? 10000 : 0) });
  await assert.rejects(f.execute(), safe);
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.signals, ['SIGKILL']);
  const times = [0, 0, 9999, 10000];
  const g = fixture(t, { monotonic: () => times.shift() ?? 10000 });
  const result = g.execute();
  g.respond();
  await assert.rejects(result, safe);
  assert.deepEqual(g.signals, ['SIGKILL']);
});

test('clock rollback after a successful request closes the child before rejecting a later operation', async (t) => {
  const f = fixture(t);
  f.setTime(1);
  const first = f.execute();
  f.respond();
  await first;
  f.setTime(0);
  await assert.rejects(f.execute(), safe);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.signals, ['SIGKILL']);
});

test('stderr, stream errors, early EOF and premature child close never expose underlying errors', async (t) => {
  for (const source of ['stderr', 'stdout-error', 'stdin-error', 'child-error', 'end', 'close']) {
    const f = fixture(t),
      result = f.execute();
    if (source === 'stderr') f.child.stderr.write('PRIVATE synthetic credentials');
    else if (source === 'end') f.child.stdout.end(wire(1, reply).subarray(0, 10));
    else if (source === 'close') f.child.emit('close', 1);
    else if (source === 'child-error') f.child.emit('error', Error('PRIVATE synthetic failure'));
    else
      f.child[source.startsWith('stdout') ? 'stdout' : 'stdin'].emit(
        'error',
        Error('PRIVATE synthetic failure')
      );
    await assert.rejects(result, safe);
    await f.channel.close();
    assert.equal(f.launches(), 1);
  }
});

test('close during a request rejects only after child close and is idempotent', async (t) => {
  const f = fixture(t);
  f.keepAlive();
  const result = f.execute();
  const closing = f.channel.close();
  assert.equal(f.channel.close(), closing);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await turn();
  assert.equal(closed, false);
  f.respond();
  await turn();
  assert.equal(closed, false);
  f.child.emit('close', 0);
  await closing;
  await assert.rejects(result, safe);
  assert.deepEqual(f.signals, ['SIGKILL']);
});

test('idle close sends EOF then kills a nonexiting child at the unchanged cleanup deadline', async (t) => {
  const f = fixture(t),
    result = f.execute();
  f.respond();
  await result;
  f.keepAlive();
  const closing = f.channel.close();
  await turn();
  assert.equal(f.signals.length, 0);
  f.timeout();
  await turn();
  assert.deepEqual(f.signals, ['SIGKILL']);
  f.child.emit('close', 0);
  await closing;
});

test('failed kill never switches to a PID-based fallback or reports early cleanup', async (t) => {
  const f = fixture(t);
  f.keepAlive();
  const result = f.execute();
  let attempts = 0;
  f.child.kill = () => {
    attempts++;
    throw Error('PRIVATE kill failure');
  };
  f.timeout();
  let failed = false;
  void result.catch(() => {
    failed = true;
  });
  await turn();
  assert.equal(failed, false);
  assert.equal(attempts, 1);
  f.child.emit('close', 1);
  await assert.rejects(result, safe);
  await f.channel.close();
});

test('invalid requests and closing an unused channel never launch a process', async (t) => {
  const f = fixture(t);
  for (const value of [null, {}, '', '\ud800', 'x'.repeat(131073)])
    await assert.rejects(f.execute(value), safe);
  assert.equal(f.launches(), 0);
  await f.channel.close();
  assert.equal(f.launches(), 0);
});

test('synchronous spawn and scheduler failures are fixed failures without process retry', async (t) => {
  for (const overrides of [
    {
      spawnChild() {
        throw Error('PRIVATE spawn failure');
      },
    },
    {
      spawnChild() {
        return null;
      },
    },
    {
      scheduleTimer() {
        throw Error('PRIVATE timer failure');
      },
    },
    {
      scheduleTimer(callback) {
        callback();
        return 1;
      },
      cancelTimer() {},
    },
  ]) {
    const f = fixture(t, overrides);
    await assert.rejects(f.execute(), safe);
    await f.channel.close();
    await assert.rejects(f.execute(), safe);
  }
});

test('cancel failure rejects rather than resolving an ACK, and invalid clocks terminate the channel', async (t) => {
  const f = fixture(t, {
    cancelTimer() {
      throw Error('PRIVATE cancel failure');
    },
  });
  const result = f.execute();
  f.respond();
  await assert.rejects(result, safe);
  await f.channel.close();
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const g = fixture(t, { monotonic: () => value });
    await assert.rejects(g.execute(), safe);
    assert.equal(g.launches(), 0);
    await g.channel.close();
  }
});

test('frame encoding and original ACK parsing retain maximum, empty, hostile and exact-version boundaries', () => {
  const unicode = '😀'.repeat(32768),
    framed = encodeRecoveryAnchorFrame(0xfffffffe, unicode);
  assert.equal(framed.length, 131080);
  assert.equal(framed.readUInt32LE(4), 131072);
  for (const value of [0, -1, 1.5, NaN, 0xffffffff, Number.MAX_SAFE_INTEGER, null])
    assert.throws(() => encodeRecoveryAnchorFrame(value, request), safe);
  for (const value of ['', null, {}, '\ud800', unicode + 'a', 'x'.repeat(131073)])
    assert.throws(() => encodeRecoveryAnchorFrame(1, value), safe);
  const maximum = Buffer.alloc(65536, 42).toString('base64');
  assert.equal(
    parseRecoveryAnchorReply(
      JSON.stringify({ ok: true, revision: Number.MAX_SAFE_INTEGER, value: maximum })
    ).value,
    maximum
  );
  for (const value of [
    'null',
    '{}',
    '{"ok":false}',
    '{"ok":true,"revision":-1,"value":null}',
    '{"ok":true,"revision":1,"value":"Kg=="}',
    '{"ok":true,"revision":0,"value":null,"value":null}',
    'x'.repeat(131073),
  ])
    assert.throws(() => parseRecoveryAnchorReply(value), safe);
});

test('option and dependency validation invokes no proxies, accessors or process for malformed inputs', () => {
  let hooks = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        hooks++;
        throw Error();
      },
      ownKeys() {
        hooks++;
        throw Error();
      },
    }
  );
  const getter = { systemRoot: 'C:\\Windows' };
  Object.defineProperty(getter, 'executable', {
    enumerable: true,
    get() {
      hooks++;
      return process.execPath;
    },
  });
  for (const value of [
    null,
    [],
    proxy,
    getter,
    {},
    { executable: 'relative.exe', systemRoot: 'C:\\Windows' },
    { executable: process.execPath, systemRoot: 'invalid' },
    { executable: process.execPath + '\n', systemRoot: 'C:\\Windows' },
  ])
    assert.throws(() => createRecoveryAnchorChannel(value), safe);
  for (const value of [
    null,
    proxy,
    { invalid: () => {} },
    { spawnChild: async () => {} },
    { monotonic: function* () {} },
  ])
    assert.throws(
      () =>
        createRecoveryAnchorChannel(
          { executable: process.execPath, systemRoot: 'C:\\Windows' },
          value
        ),
      safe
    );
  assert.equal(hooks, 0);
});
