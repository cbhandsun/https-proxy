'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ready = import('../../tauri-ui/src/app/domains/context-recovery-clear-client.js');
const id = '12345678-1234-4123-8123-123456789abc';
const key = 'hpm_context_recovery_clear_operation_v1';
const record = (state, operationId = id) => ({
  ok: true,
  scope: 'proxy_context_recovery',
  operationId,
  state,
});
function memory(initial) {
  const values = new Map(initial ? [[key, initial]] : []);
  return {
    getItem: (name) => values.get(name) || null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
    values,
  };
}
async function fixture({
  storage = memory(),
  responses = [record('prepared'), record('running')],
  fetchRequest,
  setTimer,
  cancelTimer,
} = {}) {
  const { createContextRecoveryClearClient } = await ready;
  const calls = [];
  const client = createContextRecoveryClearClient({
    storage,
    getApiBase: () => '',
    setTimer,
    cancelTimer,
    fetchRequest:
      fetchRequest ||
      (async (url, options) => {
        calls.push({ url, options });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return { ok: next !== null, json: async () => next };
      }),
  });
  return { client, calls, storage };
}

test('prepare persists its ID before a single destructive start; only query follows', async () => {
  const storage = memory();
  const f = await fixture({
    storage,
    responses: [record('prepared'), record('running'), record('succeeded')],
  });
  assert.equal(await f.client.requestClear(), 'clearing');
  assert.equal(storage.getItem(key), id);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, '/v1/local/context-recovery/clear-operations');
  assert.equal(f.calls[0].options.body, '{}');
  assert.equal(f.calls[1].options.body, JSON.stringify({ confirm: true, operationId: id }));
  assert.equal(await f.client.requestClear(), 'unknown');
  assert.equal(f.calls.length, 2);
  assert.equal(await f.client.readStatus(), 'cleared');
  assert.equal(f.calls[2].options.method, 'GET');
  assert.equal(f.calls[2].url, '/v1/local/context-recovery/clear-operations?operationId=' + id);
  assert.equal(f.client.hasPending(), false);
  assert.equal(storage.getItem(key), null);
});

test('lost start response and reload only query the persisted operation, never replay POST', async () => {
  const storage = memory();
  const original = await fixture({ storage, responses: [record('prepared'), new Error('SECRET')] });
  assert.equal(await original.client.requestClear(), 'unknown');
  assert.equal(storage.getItem(key), id);
  const restored = await fixture({ storage, responses: [record('running'), record('succeeded')] });
  assert.equal(restored.client.hasPending(), true);
  assert.equal(await restored.client.requestClear(), 'unknown');
  assert.equal(restored.calls.length, 0);
  assert.equal(await restored.client.readStatus(), 'clearing');
  assert.equal(await restored.client.readStatus(), 'cleared');
  assert.ok(restored.calls.every((call) => call.options.method === 'GET'));
});

test('prepared, missing, mismatched and malformed query records remain unknown without widening action', async () => {
  const accessor = record('succeeded');
  Object.defineProperty(accessor, 'state', {
    enumerable: true,
    get() {
      throw new Error('must not run');
    },
  });
  for (const value of [
    null,
    {},
    [],
    record('prepared'),
    record('succeeded', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    { ...record('succeeded'), private: 'SECRET' },
    accessor,
  ]) {
    const f = await fixture({ storage: memory(id), responses: [value] });
    assert.equal(await f.client.readStatus(), 'unknown');
    assert.equal(f.client.hasPending(), true);
    assert.equal(await f.client.requestClear(), 'unknown');
    assert.equal(f.calls.length, 1);
  }
});

test('invalid saved IDs and unavailable storage cannot launch a destructive start', async () => {
  for (const initial of ['../SECRET', 'x'.repeat(10000), id.toUpperCase()]) {
    const f = await fixture({ storage: memory(initial) });
    assert.equal(f.client.hasPending(), false);
    assert.equal(await f.client.readStatus(), 'not_started');
    assert.equal(f.calls.length, 0);
  }
  for (const storage of [
    {
      getItem() {
        throw new Error();
      },
      setItem() {
        throw new Error();
      },
      removeItem() {},
    },
    { getItem: () => null, setItem() {}, removeItem() {} },
  ]) {
    const f = await fixture({ storage });
    assert.equal(await f.client.requestClear(), 'not_started');
    assert.equal(f.calls.length, 1);
    assert.ok(!f.calls[0].url.endsWith('/start'));
  }
  for (const response of [null, {}, [], record('running'), record('prepared', 'BAD')]) {
    const f = await fixture({ responses: [response] });
    assert.equal(await f.client.requestClear(), 'not_started');
    assert.equal(f.calls.length, 1);
  }
});

test('concurrent actions share one flight and known failure never leaks server content', async () => {
  const f = await fixture({ responses: [record('prepared'), record('failed')] });
  const first = f.client.requestClear();
  assert.equal(f.client.requestClear(), first);
  assert.equal(f.client.readStatus(), first);
  assert.equal(await first, 'failed');
  assert.equal(f.calls.length, 2);
  assert.equal(f.client.hasPending(), false);
  const unavailable = await fixture({ storage: memory(id), responses: [new Error('SECRET')] });
  assert.equal(await unavailable.client.readStatus(), 'unknown');
  const noRemoval = memory(id);
  noRemoval.removeItem = () => {
    throw new Error('SECRET');
  };
  const disabled = await fixture({ storage: noRemoval, responses: [record('disabled')] });
  assert.equal(await disabled.client.readStatus(), 'failed');
});

test('native IPC ignoring abort still times out at the original deadline without late reexecution', async () => {
  let expire;
  let requests = 0;
  let signal;
  const f = await fixture({
    storage: memory(id),
    setTimer: (callback, timeout) => {
      expire = callback;
      assert.equal(timeout, 10000);
      return 1;
    },
    cancelTimer: (handle) => assert.equal(handle, 1),
    fetchRequest: (_, options) => {
      requests++;
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const query = f.client.readStatus();
  expire();
  assert.equal(await query, 'unknown');
  assert.equal(signal.aborted, true);
  assert.equal(await f.client.requestClear(), 'unknown');
  assert.equal(requests, 1);
});

test('cancel requires an exact same-ID cancelled receipt; uncertain cancellation retains its query scope', async () => {
  const cancelled = await fixture({ storage: memory(id), responses: [record('cancelled')] });
  assert.equal(await cancelled.client.cancelPending(), 'cancelled');
  assert.equal(cancelled.client.hasPending(), false);
  assert.equal(cancelled.calls[0].url, '/v1/local/context-recovery/clear-operations/cancel');
  assert.equal(cancelled.calls[0].options.body, JSON.stringify({ confirm: true, operationId: id }));
  for (const value of [
    null,
    record('prepared'),
    record('cancelled', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ]) {
    const f = await fixture({ storage: memory(id), responses: [value] });
    assert.equal(await f.client.cancelPending(), 'unknown');
    assert.equal(f.client.hasPending(), true);
    assert.equal(await f.client.requestClear(), 'unknown');
    assert.equal(f.calls.length, 1);
  }
  const running = await fixture({ storage: memory(id), responses: [record('running')] });
  assert.equal(await running.client.cancelPending(), 'clearing');
  assert.equal(running.client.hasPending(), true);
});

test('explicit local dismissal never cancels or repeats an operation and requires storage removal readback', async () => {
  const f = await fixture({ storage: memory(id) });
  assert.equal(f.client.dismissPending(), true);
  assert.equal(f.client.hasPending(), false);
  assert.equal(f.calls.length, 0);
  for (const removal of [
    () => {},
    () => {
      throw new Error('SECRET');
    },
  ]) {
    const storage = memory(id);
    storage.removeItem = removal;
    const f = await fixture({ storage });
    assert.equal(f.client.dismissPending(), false);
    assert.equal(f.client.hasPending(), true);
    assert.equal(f.calls.length, 0);
  }
});

test('pending query prevents cancellation and dismissal; cancelled query receipts safely survive reload', async () => {
  let resolve;
  let requests = 0;
  const f = await fixture({
    storage: memory(id),
    fetchRequest: () => {
      requests++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const query = f.client.readStatus();
  assert.equal(await f.client.cancelPending(), 'unknown');
  assert.equal(f.client.dismissPending(), false);
  assert.equal(requests, 1);
  resolve({ ok: true, json: async () => record('cancelled') });
  assert.equal(await query, 'cancelled');
  assert.equal(f.client.hasPending(), false);
  assert.equal(await f.client.cancelPending(), 'not_started');
  assert.equal(requests, 1);
  const restored = await fixture({ storage: memory(id), responses: [record('cancelled')] });
  assert.equal(await restored.client.readStatus(), 'cancelled');
  assert.equal(restored.calls[0].options.method, 'GET');
});
