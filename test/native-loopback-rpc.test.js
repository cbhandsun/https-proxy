'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNativeLoopbackRpc } = require('../scripts/lib/native-loopback-rpc');

function fixture(t, handlers = {}) {
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  const sent = [];
  child.stdin.on('data', (chunk) => sent.push(JSON.parse(chunk.toString())));
  const rpc = createNativeLoopbackRpc(child, handlers);
  t.after(() => rpc.close());
  const emit = (value) => child.stdout.write(Buffer.from(JSON.stringify(value) + '\n'));
  return { child, rpc, emit, sent };
}
const code = (expected) => (problem) =>
  problem.code === expected && !problem.message.includes('secret');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('RPC correlates coalesced replies and split multibyte UTF-8 without raw diagnostics', async (t) => {
  const f = fixture(t);
  const first = f.rpc.call('first');
  const second = f.rpc.call('second', {});
  const bytes = Buffer.from(
    JSON.stringify({ id: 1, result: '🙂中文' }) + '\n' + JSON.stringify({ id: 2, result: 2 }) + '\n'
  );
  const split = bytes.indexOf(Buffer.from('🙂')) + 1;
  f.child.stdout.write(bytes.subarray(0, split));
  f.child.stdout.write(bytes.subarray(split));
  assert.equal(await first, '🙂中文');
  assert.equal(await second, 2);
  assert.deepEqual(f.sent, [
    { id: 1, method: 'first' },
    { id: 2, method: 'second', params: {} },
  ]);
  f.child.stderr.write('secret diagnostic');
  assert.equal(f.rpc.inspect().diagnosticBytes, 17);
  assert.equal(JSON.stringify(f.rpc.inspect()).includes('secret'), false);
});

test('notifications match predicates, skip whitespace, and server replies are correlated', async (t) => {
  const notifications = [];
  const f = fixture(t, {
    onNotification: (value) => notifications.push(value.method),
    onServerRequest: async () => ({ ok: true }),
  });
  f.rpc.notify('initialized');
  f.rpc.notify('configured', { ready: true });
  const defaultWaiting = f.rpc.waitFor('default');
  f.emit({ method: 'default', params: { ready: true } });
  assert.equal((await defaultWaiting).ready, true);
  const waiting = f.rpc.waitFor('ready', (params) => params.value === 2);
  f.child.stdout.write('\n  \n');
  f.emit({ method: 'ready', params: { value: 1 } });
  f.emit({ method: 'other', params: {} });
  f.emit({ method: 'ready', params: { value: 2 } });
  assert.equal((await waiting).value, 2);
  f.emit({ id: 'server-1', method: 'item/tool/call', params: {} });
  await tick();
  assert.deepEqual(f.sent.at(-1), { id: 'server-1', result: { ok: true } });
  assert.deepEqual(notifications, ['default', 'ready', 'other', 'ready']);
});

test('remote errors are redacted without breaking a later valid reply', async (t) => {
  const f = fixture(t);
  const rejected = assert.rejects(f.rpc.call('fail'), code('native_rpc_rejected'));
  f.emit({ id: 1, error: { message: 'secret token' } });
  await rejected;
  const valid = f.rpc.call('valid');
  f.emit({ id: 2, result: null });
  assert.equal(await valid, null);
  assert.equal(f.rpc.inspect().failureCode, null);
});

for (const [label, bytes, expected] of [
  ['malformed JSON', Buffer.from('{secret\n'), 'native_rpc_invalid_message'],
  ['array', Buffer.from('[]\n'), 'native_rpc_invalid_message'],
  ['null', Buffer.from('null\n'), 'native_rpc_invalid_message'],
  ['invalid UTF-8', Buffer.from([255, 10]), 'native_rpc_invalid_message'],
  ['unknown method', Buffer.from('{"method":"../bad name"}\n'), 'native_rpc_invalid_message'],
  [
    'wrong version',
    Buffer.from('{"jsonrpc":"secret","method":"ready"}\n'),
    'native_rpc_invalid_message',
  ],
  [
    'mixed request/reply',
    Buffer.from('{"method":"ready","result":1}\n'),
    'native_rpc_invalid_message',
  ],
  [
    'oversized line',
    Buffer.from('x'.repeat(2 * 1024 * 1024 + 1) + '\n'),
    'native_rpc_line_too_large',
  ],
  [
    'oversized pending line',
    Buffer.from('x'.repeat(2 * 1024 * 1024 + 1)),
    'native_rpc_line_too_large',
  ],
])
  test('RPC refuses ' + label, async (t) => {
    const f = fixture(t);
    const rejected = assert.rejects(f.rpc.call('pending'), code(expected));
    f.child.stdout.write(bytes);
    await rejected;
    assert.equal(f.rpc.inspect().pending, 0);
  });

for (const [reply, expected] of [
  [{ id: 4, result: true }, 'native_rpc_unexpected_reply'],
  [{ id: null, result: true }, 'native_rpc_invalid_reply'],
  [{ id: 1 }, 'native_rpc_invalid_reply'],
  [{ id: 1, result: true, error: {} }, 'native_rpc_invalid_reply'],
])
  test('invalid reply fails all pending work: ' + expected + JSON.stringify(reply), async (t) => {
    const f = fixture(t);
    const rejected = assert.rejects(f.rpc.call('pending'), code(expected));
    f.emit(reply);
    await rejected;
  });

test('server identity reuse and absent/throwing callbacks fail closed', async (t) => {
  for (const handler of [
    undefined,
    () => {
      throw new Error('secret');
    },
    async () => {
      throw new Error('secret');
    },
    () => ({ ok: true }),
  ]) {
    const f = fixture(t, handler ? { onServerRequest: handler } : {});
    f.emit({ id: 'same', method: 'read', params: {} });
    await tick();
    if (!f.rpc.inspect().failureCode) f.emit({ id: 'same', method: 'read', params: {} });
    assert.equal(f.rpc.inspect().failureCode, 'native_rpc_server_request_refused');
  }
});

test('bounded requests, waiters, notifications and server requests do not silently expand', async (t) => {
  const f = fixture(t);
  const calls = Array.from({ length: 32 }, () =>
    f.rpc.call('pending').catch((problem) => problem.code)
  );
  await assert.rejects(f.rpc.call('overflow'), code('native_rpc_options_invalid'));
  const waiters = Array.from({ length: 8 }, () =>
    f.rpc.waitFor('ready').catch((problem) => problem.code)
  );
  await assert.rejects(f.rpc.waitFor('overflow'), code('native_rpc_options_invalid'));
  f.rpc.close();
  assert.ok(
    (await Promise.all([...calls, ...waiters])).every((value) => value === 'native_rpc_closed')
  );
  const n = fixture(t);
  for (let index = 0; index < 4097; index++) n.emit({ method: 'ready' });
  assert.equal(n.rpc.inspect().failureCode, 'native_rpc_notification_limit');
  const s = fixture(t, { onServerRequest: () => true });
  for (let index = 0; index < 129; index++) s.emit({ id: index, method: 'read' });
  assert.equal(s.rpc.inspect().failureCode, 'native_rpc_server_request_refused');
  await tick();
});

test('hostile options and parameters never execute accessors or coercion hooks', async (t) => {
  let executions = 0;
  const getter = Object.defineProperty({}, 'timeoutMs', {
    enumerable: true,
    get() {
      executions++;
      return 10;
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const handlers of [
    null,
    [],
    getter,
    { timeoutMs: null },
    { timeoutMs: 9 },
    { timeoutMs: 30001 },
    { onFailure: 1 },
    { extra: true },
    Object.create({ timeoutMs: 10 }),
  ]) {
    assert.throws(() => createNativeLoopbackRpc({}, handlers), code('native_rpc_options_invalid'));
  }
  const f = fixture(t);
  await assert.rejects(f.rpc.call('pending', cyclic), code('native_rpc_send_failed'));
  assert.equal(executions, 0);
  const g = fixture(t);
  assert.throws(() => g.rpc.notify('bad name'), code('native_rpc_options_invalid'));
  await assert.rejects(g.rpc.call('bad name'), code('native_rpc_options_invalid'));
  await assert.rejects(g.rpc.waitFor('ready', 1), code('native_rpc_options_invalid'));
});

for (const [surface, event, expected] of [
  ['stdout', 'error', 'native_rpc_stream_failed'],
  ['stderr', 'error', 'native_rpc_stream_failed'],
  ['stdin', 'error', 'native_rpc_stream_failed'],
  ['child', 'error', 'native_process_spawn_failed'],
  ['child', 'exit', 'native_process_exited'],
  ['child', 'close', 'native_process_exited'],
])
  test('terminal ' + surface + '/' + event + ' clears all waiting work', async (t) => {
    const f = fixture(t);
    const rejected = assert.rejects(f.rpc.waitFor('ready'), code(expected));
    (surface === 'child' ? f.child : f.child[surface]).emit(event, new Error('secret'));
    await rejected;
    await assert.rejects(f.rpc.call('later'), code(expected));
    assert.throws(() => f.rpc.notify('later'), code(expected));
  });

test('end validates trailing UTF-8 and partial JSON instead of ignoring it', async (t) => {
  for (const [bytes, expected] of [
    [Buffer.from('{'), 'native_rpc_truncated_stream'],
    [Buffer.from([0xf0]), 'native_rpc_invalid_message'],
    [Buffer.from('\n'), 'native_rpc_stream_closed'],
  ]) {
    const f = fixture(t);
    const rejected = assert.rejects(f.rpc.call('pending'), code(expected));
    f.child.stdout.end(bytes);
    await rejected;
  }
});

test('timeouts, unavailable writes and observer failures are fixed safe errors', async (t) => {
  const f = fixture(t, { timeoutMs: 10 });
  await assert.rejects(f.rpc.call('pending'), code('native_rpc_timeout'));
  const w = fixture(t, { timeoutMs: 10 });
  await assert.rejects(w.rpc.waitFor('ready'), code('native_rpc_timeout'));
  const g = fixture(t);
  g.child.stdin.destroy();
  await assert.rejects(g.rpc.call('pending'), code('native_rpc_unavailable'));
  const h = fixture(t, {
    onNotification() {
      throw new Error('secret');
    },
  });
  const rejected = assert.rejects(h.rpc.waitFor('ready'), code('native_rpc_observer_failed'));
  h.emit({ method: 'ready' });
  await rejected;
  const i = fixture(t, {
    onFailure() {
      throw new Error('secret');
    },
  });
  i.rpc.close();
  assert.equal(i.rpc.inspect().failureCode, 'native_rpc_observer_failed');
  const j = fixture(t);
  j.child.stdin.write = () => {
    throw new Error('secret');
  };
  await assert.rejects(j.rpc.call('pending'), code('native_rpc_send_failed'));
});

test('bounded extended native turn wait preserves short RPC timeout and cancels on close', async (t) => {
  const f = fixture(t, { timeoutMs: 10 });
  for (const ms of [0, 9, 120001, NaN, '120000', null])
    await assert.rejects(
      f.rpc.waitFor('ready', () => true, ms),
      code('native_rpc_options_invalid')
    );
  const waiting = f.rpc.waitFor('ready', () => true, 120000);
  f.emit({ method: 'ready', params: { completed: true } });
  assert.equal((await waiting).completed, true);
  const cancel = assert.rejects(
    f.rpc.waitFor('later', () => true, 120000),
    code('native_rpc_closed')
  );
  f.rpc.close();
  await cancel;
  assert.equal(f.rpc.inspect().waiters, 0);
  const g = fixture(t);
  await assert.rejects(
    g.rpc.waitFor('later', () => true, 10),
    code('native_rpc_timeout')
  );
});
