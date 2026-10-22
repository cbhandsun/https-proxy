'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const moduleReady = import('../../tauri-ui/src/app/domains/context-recovery-controls.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('clear sends one fixed management request and requires an exact ACK', async () => {
  const { requestContextRecoveryClear } = await moduleReady;
  const requests = [];
  let cancelled;
  const result = await requestContextRecoveryClear({
    getApiBase: () => '',
    fetchRequest: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, scope: 'proxy_context_recovery' }) };
    },
    setTimer: (_, deadline) => {
      assert.equal(deadline, 10000);
      return 7;
    },
    cancelTimer: (id) => {
      cancelled = id;
    },
  });
  assert.equal(result, 'cleared');
  assert.equal(cancelled, 7);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/local/context-recovery/clear');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.body, '{"confirm":true}');
  assert.deepEqual(requests[0].options.headers, { 'content-type': 'application/json' });
  assert.equal(requests[0].options.signal.aborted, false);
});

test('empty, malformed, unexpected and accessor ACKs never claim success', async () => {
  const { requestContextRecoveryClear } = await moduleReady;
  const accessor = { scope: 'proxy_context_recovery' };
  Object.defineProperty(accessor, 'ok', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  for (const value of [
    null,
    [],
    {},
    { ok: true },
    { ok: true, scope: 'other' },
    { ok: true, scope: 'proxy_context_recovery', content: '<script>secret</script>' },
    accessor,
  ]) {
    assert.equal(
      await requestContextRecoveryClear({
        getApiBase: () => '',
        fetchRequest: async () => ({ ok: true, json: async () => value }),
      }),
      'unknown'
    );
  }
  for (const response of [
    null,
    {
      ok: true,
      json: async () => {
        throw new Error('secret');
      },
    },
  ]) {
    assert.equal(
      await requestContextRecoveryClear({
        getApiBase: () => '',
        fetchRequest: async () => response,
      }),
      'unknown'
    );
  }
});

test('HTTP rejection and transport failures are fixed states without retries', async () => {
  const { requestContextRecoveryClear } = await moduleReady;
  for (const code of [400, 401, 403, 405, 409, 503]) {
    let requests = 0;
    assert.equal(
      await requestContextRecoveryClear({
        getApiBase: () => '',
        fetchRequest: async () => {
          requests++;
          return {
            ok: false,
            status: code,
            json: () => {
              throw new Error('must not parse error content');
            },
          };
        },
      }),
      'failed'
    );
    assert.equal(requests, 1);
  }
  let requests = 0;
  assert.equal(
    await requestContextRecoveryClear({
      getApiBase: () => '',
      fetchRequest: async () => {
        requests++;
        throw new Error('credential and native error must remain private');
      },
    }),
    'unknown'
  );
  assert.equal(requests, 1);
});

test('timeout settles an unresponsive native action without replay or late success', async () => {
  const { requestContextRecoveryClear } = await moduleReady;
  const native = deferred();
  let expire;
  let signal;
  let requests = 0;
  let cancellations = 0;
  const pending = requestContextRecoveryClear({
    getApiBase: () => '',
    fetchRequest: (_, options) => {
      requests++;
      signal = options.signal;
      return native.promise;
    },
    setTimer: (callback) => {
      expire = callback;
      return 1;
    },
    cancelTimer: () => {
      cancellations++;
    },
  });
  expire();
  assert.equal(await pending, 'unknown');
  assert.equal(signal.aborted, true);
  native.resolve({ ok: true, json: async () => ({ ok: true, scope: 'proxy_context_recovery' }) });
  assert.equal(await pending, 'unknown');
  assert.equal(requests, 1);
  assert.equal(cancellations, 1);
});

async function controls({
  confirmAction = async () => true,
  requestClear = async () => 'cleared',
  readClearStatus,
  hasPending,
  cancelPending,
  dismissPending,
  schedule = () => 1,
  cancelSchedule = () => {},
} = {}) {
  const { bindContextRecoveryControls } = await moduleReady;
  const attributes = new Map();
  const button = { disabled: false, setAttribute: (key, value) => attributes.set(key, value) };
  const status = { textContent: '' };
  const refresh = { hidden: true, disabled: false };
  const cancel = { hidden: true, disabled: false };
  const dismiss = { hidden: true, disabled: false };
  bindContextRecoveryControls({
    getElement: (name) =>
      name === 'clearContextRecovery'
        ? button
        : name === 'refreshContextRecoveryClear'
          ? refresh
          : name === 'cancelContextRecoveryClear'
            ? cancel
            : name === 'dismissContextRecoveryClear'
              ? dismiss
              : status,
    confirmAction,
    requestClear,
    readClearStatus,
    hasPending,
    cancelPending,
    dismissPending,
    schedule,
    cancelSchedule,
  });
  return { button, status, attributes, refresh, cancel, dismiss };
}

test('confirmation covers scope, cancelling and invalid confirmation do not clear', async () => {
  for (const confirmation of [false, null, 'true']) {
    let calls = 0;
    const { button, status } = await controls({
      confirmAction: async (options) => {
        assert.equal(options.danger, true);
        for (const scope of ['插件', '客户端聊天', '审计日志', '已保存设置'])
          assert.ok(options.message.includes(scope));
        return confirmation;
      },
      requestClear: async () => {
        calls++;
        return 'cleared';
      },
    });
    await button.onclick();
    assert.equal(calls, 0);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, '');
  }
});

test('confirmation and clearing are single-flight and report success only after ACK', async () => {
  const confirmation = deferred();
  const clearing = deferred();
  let confirmations = 0;
  let requests = 0;
  const { button, status, attributes } = await controls({
    confirmAction: () => {
      confirmations++;
      return confirmation.promise;
    },
    requestClear: () => {
      requests++;
      return clearing.promise;
    },
  });
  const first = button.onclick();
  await button.onclick();
  assert.equal(confirmations, 1);
  assert.equal(requests, 0);
  assert.equal(button.disabled, true);
  confirmation.resolve(true);
  await Promise.resolve();
  assert.equal(attributes.get('aria-busy'), 'true');
  assert.ok(status.textContent.includes('正在'));
  await button.onclick();
  assert.equal(requests, 1);
  clearing.resolve('cleared');
  await first;
  assert.ok(status.textContent.includes('已清除'));
  assert.equal(button.disabled, false);
  assert.equal(attributes.get('aria-busy'), 'false');
});

test('errors and untrusted results never render native content or repeat unknown actions', async () => {
  for (const requestClear of [
    async () => 'unknown',
    async () => '<img src=x onerror=secret>',
    async () => {
      throw new Error('secret');
    },
  ]) {
    let requests = 0;
    const { button, status } = await controls({
      requestClear: () => {
        requests++;
        return requestClear();
      },
    });
    await button.onclick();
    assert.equal(button.disabled, true);
    assert.ok(status.textContent.includes('结果未知'));
    assert.ok(!status.textContent.includes('secret'));
    await button.onclick();
    assert.equal(requests, 1);
  }
  const failed = await controls({ requestClear: async () => 'failed' });
  await failed.button.onclick();
  assert.equal(failed.button.disabled, false);
  assert.ok(failed.status.textContent.includes('未确认'));
  const confirmationError = await controls({
    confirmAction: async () => {
      throw new Error('secret');
    },
  });
  await confirmationError.button.onclick();
  assert.equal(confirmationError.button.disabled, false);
  assert.ok(!confirmationError.status.textContent.includes('secret'));
});

test('settings controls provide accessible status and independent persistence input', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../tauri-ui/index.html'), 'utf8');
  assert.match(html, /id="contextRecoveryPersistenceEnabled"\s+type="checkbox"/);
  assert.match(html, /id="contextRecoveryClearStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="clearContextRecovery"[^>]*type="button"/);
});

test('persisted operations resume with a read-only query, and refresh does not clear again', async () => {
  let pending = true;
  let reads = 0;
  let starts = 0;
  const query = deferred();
  const f = await controls({
    hasPending: () => pending,
    requestClear: async () => {
      starts++;
      return 'cleared';
    },
    readClearStatus: async () => {
      reads++;
      return await query.promise;
    },
  });
  assert.equal(f.button.disabled, true);
  assert.equal(f.refresh.hidden, false);
  assert.equal(f.refresh.disabled, true);
  await f.refresh.onclick();
  await f.button.onclick();
  assert.equal(reads, 1);
  assert.equal(starts, 0);
  pending = false;
  query.resolve('cleared');
  await new Promise(setImmediate);
  assert.ok(f.status.textContent.includes('已清除'));
  assert.equal(f.refresh.hidden, true);
  assert.equal(f.button.disabled, false);
});

test('running, unavailable and rejected status checks keep the action locked without native error content', async () => {
  for (const readClearStatus of [
    async () => 'clearing',
    async () => null,
    async () => {
      throw new Error('SECRET');
    },
  ]) {
    const f = await controls({ hasPending: () => true, readClearStatus });
    await new Promise(setImmediate);
    assert.equal(f.button.disabled, true);
    assert.equal(f.refresh.disabled, false);
    assert.ok(!f.status.textContent.includes('SECRET'));
  }
});

test('cancel needs explicit confirmation and releases the action only on a terminal cancellation receipt', async () => {
  for (const confirmed of [false, 'true', true]) {
    let pending = true;
    let cancels = 0;
    let starts = 0;
    const f = await controls({
      hasPending: () => pending,
      readClearStatus: async () => 'unknown',
      confirmAction: async (options) => {
        assert.ok(options.message.includes('已经运行'));
        return confirmed;
      },
      requestClear: async () => {
        starts++;
        return 'cleared';
      },
      cancelPending: async () => {
        cancels++;
        pending = false;
        return 'cancelled';
      },
    });
    await new Promise(setImmediate);
    await f.cancel.onclick();
    assert.equal(cancels, confirmed === true ? 1 : 0);
    assert.equal(starts, 0);
    assert.equal(f.button.disabled, confirmed !== true);
    if (confirmed === true) assert.ok(f.status.textContent.includes('未因此清除'));
  }
  const running = await controls({
    hasPending: () => true,
    readClearStatus: async () => 'unknown',
    cancelPending: async () => 'clearing',
  });
  await new Promise(setImmediate);
  await running.cancel.onclick();
  assert.equal(running.button.disabled, true);
  assert.ok(running.status.textContent.includes('正在'));
});

test('dismissal is a separate explicit action and never reports successful clearing or cancels the backend', async () => {
  let pending = true;
  let dismissals = 0;
  let starts = 0;
  let cancellations = 0;
  const confirmations = [];
  const f = await controls({
    hasPending: () => pending,
    readClearStatus: async () => 'unknown',
    confirmAction: async (options) => {
      confirmations.push(options);
      return true;
    },
    dismissPending: () => {
      dismissals++;
      pending = false;
      return true;
    },
    cancelPending: async () => {
      cancellations++;
      return 'cancelled';
    },
    requestClear: async () => {
      starts++;
      return 'cleared';
    },
  });
  await new Promise(setImmediate);
  await f.dismiss.onclick();
  assert.equal(dismissals, 1);
  assert.equal(cancellations, 0);
  assert.equal(starts, 0);
  assert.ok(confirmations[0].message.includes('不取消后台清除'));
  assert.ok(f.status.textContent.includes('不确认旧操作结果'));
  assert.equal(f.button.disabled, false);
  await f.button.onclick();
  assert.equal(starts, 1);
  assert.equal(confirmations.length, 2);
  for (const dismissPending of [
    () => false,
    () => {
      throw new Error('SECRET');
    },
  ]) {
    const f = await controls({
      hasPending: () => true,
      readClearStatus: async () => 'unknown',
      dismissPending,
    });
    await new Promise(setImmediate);
    await f.dismiss.onclick();
    assert.equal(f.button.disabled, true);
    assert.ok(!f.status.textContent.includes('SECRET'));
  }
});

test('timed polling is bounded, only calls status, and stops on unknown or terminal state', async () => {
  let pending = true;
  let reads = 0;
  let starts = 0;
  let result = 'clearing';
  let nextId = 0;
  const timers = new Map();
  const f = await controls({
    hasPending: () => pending,
    readClearStatus: async () => {
      reads++;
      if (result === 'cleared') pending = false;
      return result;
    },
    requestClear: async () => {
      starts++;
      return 'clearing';
    },
    schedule: (callback, delay) => {
      assert.equal(delay, 1000);
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    cancelSchedule: (id) => timers.delete(id),
  });
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  for (let poll = 0; poll < 30; poll++) {
    assert.equal(timers.size, 1);
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    callback();
    await new Promise(setImmediate);
  }
  assert.equal(reads, 31);
  assert.equal(starts, 0);
  assert.equal(timers.size, 0);
  await f.refresh.onclick();
  assert.equal(reads, 32);
  assert.equal(timers.size, 0);
  result = 'cleared';
  await f.refresh.onclick();
  assert.equal(reads, 33);
  assert.equal(f.button.disabled, false);
  assert.equal(timers.size, 0);
  // No pending scope means even an explicit stale click is read-only/no-op.
  await f.refresh.onclick();
  assert.equal(reads, 33);
  pending = true;
  result = 'unknown';
  await f.refresh.onclick();
  assert.equal(timers.size, 0);
  assert.equal(f.button.disabled, true);
});

test('cancellation confirmation locks query and dismissal; a lost cancel response keeps its scope', async () => {
  const confirmation = deferred();
  let confirmations = 0;
  let reads = 0;
  let cancels = 0;
  let dismissals = 0;
  const f = await controls({
    hasPending: () => true,
    readClearStatus: async () => {
      reads++;
      return 'unknown';
    },
    confirmAction: () => {
      confirmations++;
      return confirmation.promise;
    },
    cancelPending: async () => {
      cancels++;
      throw new Error('SECRET');
    },
    dismissPending: () => {
      dismissals++;
      return true;
    },
  });
  await new Promise(setImmediate);
  const action = f.cancel.onclick();
  await f.cancel.onclick();
  await f.refresh.onclick();
  await f.dismiss.onclick();
  assert.equal(confirmations, 1);
  assert.equal(reads, 1);
  assert.equal(dismissals, 0);
  confirmation.resolve(true);
  await action;
  assert.equal(cancels, 1);
  assert.equal(f.button.disabled, true);
  assert.ok(!f.status.textContent.includes('SECRET'));
});
