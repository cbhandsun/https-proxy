'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  createClearOperations,
  validOperationId,
} = require('../lib/proxy/context-recovery-clear-operations');
const { createContextRecoveryManagement } = require('../lib/proxy/context-recovery-management');
const { dispatchLocalManagementRoute } = require('../lib/proxy/management-router');

test('prepare is non-destructive; start is synchronous and idempotent through durable completion', async () => {
  let calls = 0;
  let resolve;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const operations = createClearOperations({
    execute: () => {
      calls++;
      return gate;
    },
  });
  const prepared = operations.prepare();
  assert.equal(prepared.state, 'prepared');
  assert.equal(validOperationId(prepared.operationId), true);
  assert.equal(calls, 0);
  assert.equal(operations.start(prepared.operationId).state, 'running');
  assert.equal(calls, 1);
  assert.equal(operations.start(prepared.operationId).state, 'running');
  const other = operations.prepare();
  assert.equal(operations.start(other.operationId).code, 'context_recovery_operation_busy');
  resolve({ ok: true });
  await new Promise(setImmediate);
  assert.equal(operations.inspect(prepared.operationId).state, 'succeeded');
  assert.equal(operations.start(prepared.operationId).state, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(operations.start(other.operationId).state, 'running');
  await new Promise(setImmediate);
  assert.equal(calls, 2);
});

test('terminal failures are safe, non-replayed, and reject malformed or executable ACK data', async () => {
  let getters = 0;
  const values = [
    undefined,
    null,
    {},
    { ok: true, private: 'SECRET' },
    {
      get ok() {
        getters++;
        return true;
      },
    },
    {
      get then() {
        getters++;
        return () => {};
      },
    },
    { ok: false, code: 'context_recovery_disabled' },
  ];
  for (const value of values) {
    const operations = createClearOperations({ execute: () => value });
    const id = operations.prepare().operationId;
    const result = operations.start(id);
    assert.equal(result.state, value?.code === 'context_recovery_disabled' ? 'disabled' : 'failed');
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.deepEqual(operations.start(id), result);
  }
  assert.equal(getters, 0);
  for (const execute of [
    () => {
      throw new Error('SECRET');
    },
    () => Promise.reject(new Error('SECRET')),
  ]) {
    const operations = createClearOperations({ execute });
    const id = operations.prepare().operationId;
    operations.start(id);
    await new Promise(setImmediate);
    assert.equal(operations.inspect(id).state, 'failed');
  }
  const native = Promise.resolve({ ok: true });
  Object.defineProperty(native, 'then', {
    get() {
      getters++;
      throw new Error();
    },
  });
  const operations = createClearOperations({ execute: () => native });
  const id = operations.prepare().operationId;
  operations.start(id);
  await new Promise(setImmediate);
  assert.equal(operations.inspect(id).state, 'succeeded');
  assert.equal(getters, 0);
});

test('expiry, capacity, clock rollback and service restart never recreate missing operations', () => {
  let now = 100;
  let calls = 0;
  const operations = createClearOperations({
    clock: () => now,
    execute: () => {
      calls++;
      return { ok: true };
    },
  });
  const ids = Array.from({ length: 32 }, () => operations.prepare().operationId);
  assert.equal(operations.prepare().code, 'context_recovery_operation_capacity');
  operations.start(ids[0]);
  now += 30 * 60 * 1000;
  assert.equal(operations.inspect(ids[0]).code, 'context_recovery_operation_unknown');
  assert.equal(operations.start(ids[1]).code, 'context_recovery_operation_unknown');
  now = 0;
  assert.equal(operations.start(ids[0]).code, 'context_recovery_operation_unknown');
  const fresh = operations.prepare().operationId;
  assert.equal(operations.inspect(fresh).state, 'prepared');
  const restarted = createClearOperations({
    execute: () => {
      calls++;
      return { ok: true };
    },
  });
  assert.equal(restarted.start(fresh).code, 'context_recovery_operation_unknown');
  assert.equal(calls, 1);
  for (const value of [null, {}, '', fresh.toUpperCase(), '../' + fresh, 'x'.repeat(10000)])
    assert.equal(operations.start(value).ok, false);
  assert.throws(() => createClearOperations({}), /Invalid clear operation owner/);
  for (const clock of [() => NaN, () => -1, () => Number.MAX_SAFE_INTEGER])
    assert.throws(
      () => createClearOperations({ clock, execute() {} }).prepare(),
      /clock unavailable/
    );
});

test('running operations are not evicted and retain single execution even beyond expiry', async () => {
  let now = 0;
  let resolve;
  let calls = 0;
  const operations = createClearOperations({
    clock: () => now,
    execute: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const id = operations.prepare().operationId;
  operations.start(id);
  now = 60 * 60 * 1000;
  assert.equal(operations.inspect(id).state, 'running');
  assert.equal(operations.start(id).state, 'running');
  assert.equal(calls, 1);
  resolve({ ok: true });
  await new Promise(setImmediate);
  assert.equal(operations.inspect(id).code, 'context_recovery_operation_unknown');
  assert.equal(operations.start(id).ok, false);
});

function api(lifecycle) {
  let replies = [];
  const handlers = createContextRecoveryManagement({
    lifecycle,
    sendJson: (res, status, value) => {
      replies.push({ status, value });
      res.resolve({ status, value });
    },
  });
  return async (
    name,
    {
      method = 'POST',
      body = '{}',
      url = '/v1/local/context-recovery/clear-operations',
      aborted = false,
      destroyed = false,
    } = {}
  ) => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method, url, aborted });
    const res = { destroyed };
    const result = new Promise((resolve) => {
      res.resolve = resolve;
    });
    replies = [];
    handlers[name](req, res);
    if (aborted || destroyed) {
      await new Promise(setImmediate);
      assert.equal(replies.length, 0);
      return null;
    }
    return await result;
  };
}
const prepare = 'handleLocalContextRecoveryClearPrepareRequest';
const start = 'handleLocalContextRecoveryClearStartRequest';
const status = 'handleLocalContextRecoveryClearStatusRequest';
const cancel = 'handleLocalContextRecoveryClearCancelRequest';

test('operation HTTP handlers validate bounded exact shapes and query selectors', async () => {
  let calls = 0;
  const request = api({
    clearAsync: () => {
      calls++;
      return { ok: true };
    },
  });
  for (const body of ['', 'true', 'false', '[]', 'null', '""', '{"confirm":true}', ' '.repeat(129)])
    assert.equal((await request(prepare, { body })).status, 400);
  assert.equal((await request(prepare, { method: 'GET' })).status, 405);
  const prepared = await request(prepare);
  assert.equal(prepared.status, 202);
  const id = prepared.value.operationId;
  assert.equal(calls, 0);
  for (const body of [
    '{}',
    JSON.stringify({ operationId: id, confirm: 'true' }),
    JSON.stringify({ operationId: id, confirm: true, path: 'SECRET' }),
  ])
    assert.equal((await request(start, { body })).status, 400);
  assert.equal((await request(start, { method: 'GET' })).status, 405);
  for (const query of [
    '',
    '?operationId=x',
    `?operationId=${id}&operationId=${id}`,
    `?operationId=${id}&path=SECRET`,
    `?operationId=${id}#x`,
    '?operationId=' + 'x'.repeat(300),
  ])
    assert.equal(
      (
        await request(status, {
          method: 'GET',
          url: '/local/context-recovery/clear-operations' + query,
        })
      ).status,
      400
    );
  assert.equal((await request(status, { method: 'POST' })).status, 405);
  assert.equal(
    (await request(start, { body: JSON.stringify({ confirm: true, operationId: id }) })).value
      .state,
    'succeeded'
  );
  assert.equal(
    (
      await request(status, {
        method: 'GET',
        url: '/local/context-recovery/clear-operations?operationId=' + id,
      })
    ).value.state,
    'succeeded'
  );
  assert.equal(calls, 1);
  await request(start, { body: JSON.stringify({ confirm: true, operationId: id }) });
  assert.equal(calls, 1);
  assert.equal(
    (
      await request(status, {
        method: 'GET',
        url: '/local/context-recovery/clear-operations?operationId=11111111-1111-4111-8111-111111111111',
      })
    ).status,
    404
  );
  await request(prepare, { aborted: true });
  await request(prepare, { destroyed: true });
});

test('operation routes expose only exact allowed methods and both aliases', () => {
  for (const prefix of ['/v1/local', '/local'])
    for (const [suffix, method, name] of [
      ['', 'POST', prepare],
      ['', 'GET', status],
      ['/start', 'POST', start],
    ]) {
      let calls = 0;
      assert.equal(
        dispatchLocalManagementRoute({
          method,
          pathname: prefix + '/context-recovery/clear-operations' + suffix,
          handlers: {
            [name]() {
              calls++;
            },
          },
          req: {},
          res: {},
        }),
        true
      );
      assert.equal(calls, 1);
      assert.equal(
        dispatchLocalManagementRoute({
          method: 'DELETE',
          pathname: prefix + '/context-recovery/clear-operations' + suffix,
          handlers: {},
          req: {},
          res: {},
        }),
        false
      );
    }
});

test('cancelled prepared operations reject every delayed start without touching recovery data', () => {
  let executions = 0;
  const operations = createClearOperations({
    execute: () => {
      executions++;
      return { ok: true };
    },
  });
  const id = operations.prepare().operationId;
  assert.equal(operations.cancel(id).state, 'cancelled');
  assert.equal(operations.inspect(id).state, 'cancelled');
  assert.equal(operations.cancel(id).state, 'cancelled');
  for (let repeat = 0; repeat < 3; repeat++) assert.equal(operations.start(id).state, 'cancelled');
  assert.equal(executions, 0);
  assert.equal(
    operations.cancel('11111111-1111-4111-8111-111111111111').code,
    'context_recovery_operation_unknown'
  );
});

test('cancel HTTP is exact, confirmed and authenticated-route-only; cancelled IDs never dispatch start', async () => {
  let executions = 0;
  const request = api({
    clearAsync: () => {
      executions++;
      return { ok: true };
    },
  });
  const id = (await request(prepare)).value.operationId;
  for (const body of [
    '',
    '{}',
    'true',
    '[]',
    'null',
    JSON.stringify({ confirm: false, operationId: id }),
    JSON.stringify({ confirm: true, operationId: '../PRIVATE' }),
    JSON.stringify({ confirm: true, operationId: id, path: 'PRIVATE' }),
    ' '.repeat(129),
  ])
    assert.equal((await request(cancel, { body })).status, 400);
  assert.equal((await request(cancel, { method: 'GET' })).status, 405);
  const body = JSON.stringify({ confirm: true, operationId: id });
  await request(cancel, { body, aborted: true });
  await request(cancel, { body, destroyed: true });
  const cancelled = await request(cancel, { body });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.value.state, 'cancelled');
  assert.equal((await request(start, { body })).value.state, 'cancelled');
  assert.equal(executions, 0);
  for (const prefix of ['/v1/local', '/local']) {
    let handled = 0;
    assert.equal(
      dispatchLocalManagementRoute({
        method: 'POST',
        pathname: prefix + '/context-recovery/clear-operations/cancel',
        handlers: {
          [cancel]() {
            handled++;
          },
        },
        req: {},
        res: {},
      }),
      true
    );
    assert.equal(handled, 1);
    assert.equal(
      dispatchLocalManagementRoute({
        method: 'GET',
        pathname: prefix + '/context-recovery/clear-operations/cancel',
        handlers: {},
        req: {},
        res: {},
      }),
      false
    );
  }
});

test('cancelling a waiting operation cannot release another running owner or resurrect after expiry', async () => {
  let now = 1;
  let resolve;
  let executions = 0;
  const operations = createClearOperations({
    clock: () => now,
    execute: () => {
      executions++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const live = operations.prepare().operationId;
  operations.start(live);
  const waiting = operations.prepare().operationId;
  operations.cancel(waiting);
  assert.equal(
    operations.start(operations.prepare().operationId).code,
    'context_recovery_operation_busy'
  );
  assert.equal(executions, 1);
  now += 30 * 60 * 1000;
  assert.equal(operations.start(waiting).code, 'context_recovery_operation_unknown');
  assert.equal(operations.cancel(waiting).code, 'context_recovery_operation_unknown');
  assert.equal(operations.inspect(live).state, 'running');
  resolve({ ok: true });
  await new Promise(setImmediate);
  assert.equal(executions, 1);
});

test('cancellation cannot interrupt running clears or rewrite their durable terminal result', async () => {
  let resolve;
  let executions = 0;
  const operations = createClearOperations({
    execute: () => {
      executions++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const id = operations.prepare().operationId;
  operations.start(id);
  assert.equal(operations.cancel(id).state, 'running');
  resolve({ ok: true });
  await new Promise(setImmediate);
  assert.equal(operations.cancel(id).state, 'succeeded');
  assert.equal(executions, 1);
});
