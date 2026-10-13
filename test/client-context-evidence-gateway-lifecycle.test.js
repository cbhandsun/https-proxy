'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEvidenceGatewayCatalog } = require('../lib/client/context-evidence-gateway-catalog');
const {
  createEvidenceGatewayCatalogRefresh,
} = require('../lib/client/context-evidence-gateway-refresh');
const {
  createEvidenceGatewayProgressForwarder,
} = require('../lib/client/context-evidence-gateway-progress');
const { createContextEvidenceGateway } = require('../lib/client/context-evidence-gateway');
const definition = {
  name: 'lookup',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
};
const result = (value) => ({
  content: [{ type: 'text', text: 'returned result' }],
  structuredContent: { value },
});
const json = (value) => JSON.parse(value.content[0].text);

test('atomic replacement pins in-flight contracts, rejects hostile replacements, and retains reader budgets and sources', async (t) => {
  let finish;
  let calls = 0;
  const gateway = createContextEvidenceGateway({
    tools: [definition],
    callTool: () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : result('new'),
  });
  t.after(gateway.close);
  const pending = gateway.call('lookup');
  gateway.suspendDispatch();
  assert.equal(json(await gateway.call('lookup')).error, 'gateway_catalog_unavailable');
  assert.equal(gateway.definitions.length, 3);
  assert.equal(json(await gateway.call('hpm_list_execution_records')).records[0].state, 'running');
  gateway.replaceCatalog([
    {
      ...definition,
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
  ]);
  finish(result(1));
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), result(1));
  assert.deepEqual(JSON.parse(JSON.stringify(await gateway.call('lookup'))), result('new'));
  assert.equal(json(await gateway.call('hpm_list_retained_evidence')).sources.length, 2);
  assert.throws(
    () => gateway.replaceCatalog([{ ...definition, name: 'hpm_read_retained_evidence' }]),
    /gateway_catalog_unavailable/
  );
  assert.equal(gateway.inspect().catalogAvailable, false);
  assert.equal(json(await gateway.call('lookup')).error, 'gateway_catalog_unavailable');
  assert.equal(calls, 2);
  assert.equal(json(await gateway.call('hpm_list_retained_evidence')).sources.length, 2);
  gateway.replaceCatalog([]);
  assert.equal(json(await gateway.call('lookup')).error, 'unknown_gateway_tool');
  for (let i = 0; i < 64; i++) await gateway.call('hpm_list_execution_records');
  gateway.replaceCatalog([definition]);
  assert.equal(
    json(await gateway.call('hpm_list_execution_records')).error,
    'execution_read_budget_exceeded'
  );
  gateway.close();
  assert.throws(() => gateway.replaceCatalog([definition]), /evidence_gateway_closed/);
});

test('one catalog deadline bounds all pages, cancellation and hostile clocks without leaking exceptions', async () => {
  let time = 0;
  const timeouts = [];
  const tools = await loadEvidenceGatewayCatalog(
    {
      request: async (_request, _schema, options) => {
        timeouts.push(options.timeout);
        time += 10000;
        return timeouts.length === 1 ? { tools: [], nextCursor: 'next' } : { tools: [definition] };
      },
    },
    undefined,
    () => time
  );
  assert.equal(tools.length, 1);
  assert.deepEqual(timeouts, [60000, 50000]);
  await assert.rejects(
    loadEvidenceGatewayCatalog(
      {
        request() {
          assert.fail('cancelled catalog dispatched');
        },
      },
      { aborted: true }
    ),
    /gateway_catalog_unavailable/
  );
  for (const now of [
    () => -1,
    () => NaN,
    () => Number.MAX_SAFE_INTEGER,
    () => {
      throw new Error('private-clock-value');
    },
  ])
    await assert.rejects(
      loadEvidenceGatewayCatalog({}, undefined, now),
      (error) => error.message === 'gateway_catalog_unavailable'
    );
  for (const receivedAt of [-1, NaN, 60000]) {
    let current = 0;
    await assert.rejects(
      loadEvidenceGatewayCatalog(
        {
          request: async () => {
            current = receivedAt;
            return { tools: [] };
          },
        },
        undefined,
        () => current
      ),
      /gateway_catalog_unavailable/
    );
  }
  const controller = new globalThis.AbortController();
  await assert.rejects(
    loadEvidenceGatewayCatalog(
      {
        request: async () => {
          controller.abort();
          return { tools: [] };
        },
      },
      controller.signal
    ),
    /gateway_catalog_unavailable/
  );
});

function refreshFixture(overrides = {}) {
  const updates = [];
  let suspensions = 0;
  let notifications = 0;
  let closed = false;
  const refresh = createEvidenceGatewayCatalogRefresh({
    load: async () => ['fresh'],
    replace: (value) => updates.push(value),
    suspend: () => {
      suspensions++;
    },
    notify: async () => {
      notifications++;
    },
    isClosed: () => closed,
    ...overrides,
  });
  return {
    refresh,
    updates,
    suspensions: () => suspensions,
    notifications: () => notifications,
    close: () => {
      closed = true;
    },
  };
}

test('catalog refresh is single-flight, discards stale reads, and caps automatic reads without execution replay', async () => {
  let reads = 0;
  let resolve;
  const f = refreshFixture({
    load: () =>
      ++reads === 1
        ? new Promise((r) => {
            resolve = r;
          })
        : ['fresh'],
  });
  const first = f.refresh.refresh();
  await Promise.resolve();
  assert.equal(f.refresh.refresh(), first);
  resolve(['stale']);
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(f.updates, [['fresh']]);
  assert.equal(reads, 2);
  for (let i = 0; i < 30; i++) assert.equal((await f.refresh.refresh()).ok, true);
  assert.equal((await f.refresh.refresh()).ok, false);
  assert.equal(f.refresh.inspect().attempts, 32);
  assert.equal(reads, 32);
  assert.ok(f.suspensions() > 0);
  f.close();
  assert.equal((await f.refresh.refresh()).ok, false);
  assert.equal(f.notifications(), 32);
});

test('refresh failures, persistent notification storms and late closure do not publish stale catalogs', async () => {
  for (const callback of [
    {
      load: async () => {
        throw new Error('private-catalog-data');
      },
    },
    {
      replace: () => {
        throw new Error('private-schema-data');
      },
    },
  ]) {
    const f = refreshFixture(callback);
    assert.equal((await f.refresh.refresh()).ok, false);
    assert.equal(f.suspensions(), 2);
  }
  const failedNotify = refreshFixture({
    notify: async () => {
      throw new Error('private-notification-data');
    },
  });
  assert.equal((await failedNotify.refresh.refresh()).ok, true);
  assert.equal(failedNotify.refresh.inspect().notificationFailures, 1);
  let resolve;
  const closed = refreshFixture({
    load: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = closed.refresh.refresh();
  await Promise.resolve();
  closed.close();
  resolve(['late']);
  assert.equal((await pending).ok, false);
  assert.deepEqual(closed.updates, []);
  assert.equal(closed.notifications(), 0);
  const storm = refreshFixture({
    load: async () => {
      storm.refresh.refresh();
      return ['stale'];
    },
  });
  assert.equal((await storm.refresh.refresh()).ok, false);
  assert.equal(storm.refresh.inspect().attempts, 2);
  assert.deepEqual(storm.updates, []);
  let once = false;
  const notifying = refreshFixture({
    notify: async () => {
      if (!once) {
        once = true;
        notifying.refresh.refresh();
      }
    },
  });
  assert.equal((await notifying.refresh.refresh()).ok, false);
  assert.equal(notifying.notifications(), 0);
  assert.ok(notifying.suspensions() >= 2);
});

test('progress forwards only monotonic bounded numeric metadata using the original token, never message content', async () => {
  const sent = [];
  const f = createEvidenceGatewayProgressForwarder({
    token: 'upstream-token',
    send: async (params) => sent.push(params),
    isActive: () => true,
  });
  assert.equal(
    await f.accept({ progress: 0, total: 2, progressToken: 'foreign', message: 'private-content' }),
    true
  );
  assert.equal(await f.accept({ progress: 1 }), true);
  assert.deepEqual(sent, [
    { progressToken: 'upstream-token', progress: 0, total: 2 },
    { progressToken: 'upstream-token', progress: 1 },
  ]);
  for (const value of [
    null,
    [],
    {},
    { progress: -1 },
    { progress: NaN },
    { progress: Infinity },
    { progress: Number.MAX_SAFE_INTEGER + 1 },
    { progress: 1 },
    { progress: 0 },
    { progress: 2, total: 1 },
    { progress: 2, total: -1 },
    { progress: 2, message: 'x'.repeat(5000) },
  ])
    assert.equal(await f.accept(value), false);
  let invoked = 0;
  const getter = Object.defineProperty({}, 'progress', {
    enumerable: true,
    get() {
      invoked++;
      return 3;
    },
  });
  assert.equal(await f.accept(getter), false);
  assert.equal(invoked, 0);
  assert.equal(sent.length, 2);
  const budget = createEvidenceGatewayProgressForwarder({
    token: 0,
    send: async () => {},
    isActive: () => true,
  });
  for (let i = 0; i < 64; i++) assert.equal(await budget.accept({ progress: i }), true);
  assert.equal(await budget.accept({ progress: 64 }), false);
  assert.equal(budget.inspect().forwarded, 64);
});

test('invalid token, cancelled completion and failed progress delivery never retry or expose failures', async () => {
  for (const token of [undefined, {}, 'x'.repeat(257), '\ud800', 0.5]) {
    const f = createEvidenceGatewayProgressForwarder({
      token,
      send() {
        assert.fail('invalid token forwarded');
      },
      isActive: () => true,
    });
    assert.equal(await f.accept({ progress: 0 }), false);
  }
  const inactive = createEvidenceGatewayProgressForwarder({
    token: 'ok',
    send() {
      assert.fail('late progress forwarded');
    },
    isActive: () => false,
  });
  assert.equal(await inactive.accept({ progress: 0 }), false);
  let calls = 0;
  const failed = createEvidenceGatewayProgressForwarder({
    token: 'ok',
    send() {
      calls++;
      throw new Error('private-delivery-value');
    },
    isActive: () => true,
  });
  assert.equal(await failed.accept({ progress: 0 }), false);
  assert.equal(await failed.accept({ progress: 0 }), false);
  assert.equal(failed.inspect().failures, 1);
  assert.equal(calls, 1);
});
