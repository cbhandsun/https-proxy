'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createContextRecoveryManagement } = require('../lib/proxy/context-recovery-management');
const { dispatchLocalManagementRoute } = require('../lib/proxy/management-router');

function fixture(
  lifecycle,
  body = '{"confirm":true}',
  { method = 'POST', send, aborted = false } = {}
) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.aborted = aborted;
  const res = {};
  let resolve;
  const completed = new Promise((done) => {
    resolve = done;
  });
  const replies = [];
  const handlers = createContextRecoveryManagement({
    lifecycle,
    sendJson(target, status, value) {
      assert.equal(target, res);
      replies.push({ status, value });
      resolve({ status, value });
      send?.();
    },
  });
  handlers.handleLocalContextRecoveryClearRequest(req, res);
  return { req, res, handlers, completed, replies };
}

test('management clear requires explicit bounded confirmation and accepts no path or session selectors', async () => {
  let calls = 0;
  const lifecycle = {
    clearAsync() {
      calls++;
      return { ok: true };
    },
  };
  for (const body of [
    '',
    '{}',
    'null',
    '[]',
    'true',
    '{',
    '{"confirm":"true"}',
    '{"confirm":true,"scope":"all"}',
    '{"confirm":true,"path":"PRIVATE_DATA"}',
    '{"confirm":true,"__proto__":{}}',
    ' '.repeat(129),
    '{"CONFIRM":true}',
  ]) {
    const f = fixture(lifecycle, body);
    assert.deepEqual(await f.completed, {
      status: 400,
      value: { ok: false, code: 'context_recovery_clear_invalid' },
    });
    assert.equal(f.replies.length, 1);
  }
  assert.equal(calls, 0);
  const f = fixture(lifecycle);
  assert.deepEqual(await f.completed, {
    status: 200,
    value: { ok: true, scope: 'proxy_context_recovery' },
  });
  assert.equal(calls, 1);
  assert.equal((await fixture(lifecycle, '', { method: 'GET' }).completed).status, 405);
  assert.equal(calls, 1);
});

test('management clear waits for durable ACK and never exposes malformed, private or rejected errors', async () => {
  let executed = 0;
  for (const mode of ['missing', 'throw', 'reject', 'shape', 'getter', 'disabled']) {
    const lifecycle =
      mode === 'missing'
        ? {}
        : {
            clearAsync() {
              if (mode === 'throw') throw new Error('PRIVATE_DATA');
              if (mode === 'reject') return Promise.reject(new Error('PRIVATE_DATA'));
              if (mode === 'shape') return { ok: true, secret: 'PRIVATE_DATA' };
              if (mode === 'getter')
                return {
                  get then() {
                    executed++;
                    return () => {};
                  },
                };
              return { ok: false, code: 'context_recovery_disabled' };
            },
          };
    const result = await fixture(lifecycle).completed;
    assert.equal(result.status, mode === 'disabled' ? 409 : 503);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DATA/);
  }
  const accessor = {
    get clearAsync() {
      executed++;
      return () => ({ ok: true });
    },
  };
  assert.equal((await fixture(accessor).completed).status, 503);
  assert.equal(executed, 0);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ clearAsync: () => gate });
  await new Promise(setImmediate);
  assert.equal(f.replies.length, 0);
  release({ ok: true });
  assert.equal((await f.completed).status, 200);
});

test('aborted requests and closed responses cannot launch or repeat a clear', async () => {
  let calls = 0;
  const lifecycle = {
    clearAsync() {
      calls++;
      return { ok: true };
    },
  };
  const aborted = fixture(lifecycle, '{"confirm":true}', { aborted: true });
  await new Promise(setImmediate);
  assert.equal(calls, 0);
  assert.equal(aborted.replies.length, 0);
  const closed = fixture(lifecycle);
  closed.res.destroyed = true;
  await new Promise(setImmediate);
  assert.equal(calls, 0);
  const terminal = fixture(lifecycle, '{"confirm":true}', {
    send() {
      throw new Error('PRIVATE_DATA');
    },
  });
  assert.equal((await terminal.completed).status, 200);
  await new Promise(setImmediate);
  assert.equal(terminal.replies.length, 1);
  assert.equal(calls, 1);
});

test('both management aliases route only POST through the existing clear handler', () => {
  let calls = 0;
  for (const pathname of ['/v1/local/context-recovery/clear', '/local/context-recovery/clear']) {
    for (const method of ['POST', 'GET', 'DELETE']) {
      assert.equal(
        dispatchLocalManagementRoute({
          method,
          pathname,
          req: {},
          res: {},
          handlers: {
            handleLocalContextRecoveryClearRequest() {
              calls++;
            },
          },
        }),
        method === 'POST'
      );
    }
  }
  assert.equal(calls, 2);
  assert.throws(
    () => createContextRecoveryManagement({ sendJson: null }),
    /Invalid recovery management sender/
  );
});
