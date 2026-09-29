'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AbortController } = globalThis;
const {
  DEFAULT_TIANXI_NATIVE_IDLE_TIMEOUT_MS,
  createFileTianxiNativeRuntime,
  createAgentCoreTianxiNativeRuntime,
  createFixtureTianxiNativeRuntime,
  createNativeApiChannelTianxiRuntime,
  createTacServerTianxiNativeRuntime,
  createTianxiNativeRuntime,
  createTransportTianxiNativeRuntime,
  createUnavailableTianxiNativeRuntime,
} = require('../lib/proxy/tianxi-native-runtime');

function fakeJwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `sat-${encode({ alg: 'none' })}.${encode({ exp })}.signature`;
}

function fakeExpiredQoderRuntimeRuns() {
  return [
    {
      classification: 'service_account_expired',
      lastTimestamp: '2026-09-18T07:09:45.782-07:00',
      initializeStatus: 'error',
      catalogReady: false,
      token: 'must-not-leak',
    },
  ];
}

test('Tianxi native fixture and frames-file runtimes return normalized frames', async () => {
  const fixture = createFixtureTianxiNativeRuntime({ text: 'fixture-ok' });
  const fixtureResult = await fixture.sendResponses({ model: 'super' });
  assert.equal(fixtureResult.frames.at(-1).data.status, 'COMPLETED');
  assert.equal(fixtureResult.frames[1].data.content, 'fixture-ok');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tianxi-'));
  const file = path.join(dir, 'frames.json');
  fs.writeFileSync(
    file,
    JSON.stringify([{ type: 'task_output', data: { content: 'file-ok' } }]),
    'utf8'
  );
  const fileResult = await createFileTianxiNativeRuntime(file).sendResponses({ model: 'super' });
  assert.equal(fileResult.frames[0].data.content, 'file-ok');
});

test('Tianxi tac-server runtime injects local header and returns native frames', async () => {
  let sent;
  let contextSeen;
  const runtime = createTacServerTianxiNativeRuntime({
    idleTimeoutMs: 2345,
    header: {
      app_id: 'app',
      app_version: '1.0',
      credentials: { type: 'official-login' },
      device_id: 'device',
      device_type: 'pc',
      role: 'user',
      tab_id: 'tab',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    enableSetTokenInjection: true,
    transport: {
      async sendQuery(frame, context) {
        sent = frame;
        contextSeen = context;
        return [
          { type: 'task_output', data: { content: 'real-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });
  const result = await runtime.sendResponses(
    {
      model: 'super',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello tac' }] }],
    },
    {
      now: () => 789,
      uuid: (() => {
        const values = ['session-3', 'request-3', 'query-3'];
        return () => values.shift();
      })(),
    }
  );
  assert.equal(runtime.name, 'tac-server');
  assert.equal(sent.header.user_id, 'user');
  assert.equal(sent.header.device_id, 'device');
  assert.equal(sent.header.app_id, 'app');
  assert.equal(sent.data.text, 'hello tac');
  assert.equal(sent.data.options.backend, 'qoder');
  assert.equal(sent.data.options.configPath, 'C:\\ProgramData\\Lenovo\\AIAgent\\xlagent\\');
  assert.equal(contextSeen.idleTimeoutMs, 2345);
  assert.equal(result.frames[0].data.content, 'real-ok');
});

test('Tianxi tac-server keeps the bounded default idle window and accepts an override', async () => {
  assert.equal(DEFAULT_TIANXI_NATIVE_IDLE_TIMEOUT_MS, 120000);
  const observed = [];
  const options = {
    mode: 'tac-server',
    header: { app_id: 'app', device_id: 'device', user_id: 'user', credentials: {} },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    transport: {
      async sendQuery(_frame, context) {
        observed.push(context.idleTimeoutMs);
        return [{ type: 'task_status', data: { status: 'COMPLETED' } }];
      },
    },
  };
  await createTianxiNativeRuntime(options).sendResponses({ model: 'chat', input: 'hello' });
  await createTianxiNativeRuntime({ ...options, idleTimeoutMs: 45000 }).sendResponses({
    model: 'chat',
    input: 'hello',
  });
  assert.deepEqual(observed, [120000, 45000]);
});

test('Tianxi tac-server streams normalized frames and releases terminal status last', async () => {
  const streamed = [];
  const runtime = createTacServerTianxiNativeRuntime({
    header: { app_id: 'app', device_id: 'device', user_id: 'user', credentials: {} },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    transport: {
      async sendQuery(_frame, context) {
        const output = { type: 'task_output', data: { content: 'live' } };
        const terminal = { type: 'task_status', data: { status: 'COMPLETED' } };
        context.onFrame(output);
        context.onFrame(terminal);
        assert.deepEqual(streamed, ['task_output']);
        return [output, terminal];
      },
    },
  });
  const result = await runtime.sendResponses(
    { model: 'chat', input: 'hello' },
    { onFrame: (frame) => streamed.push(frame.type) }
  );
  assert.deepEqual(streamed, ['task_output', 'task_status']);
  assert.equal(result.frames.at(-1).data.status, 'COMPLETED');
});

test('Tianxi tac-server runtime allows visible partial frames to close after idle', async () => {
  let queryContext;
  const runtime = createTacServerTianxiNativeRuntime({
    header: { app_id: 'app', device_id: 'device', user_id: 'user', credentials: {} },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    transport: {
      async sendQuery(_frame, context) {
        queryContext = context;
        return [{ type: 'task_output', data: { content: 'partial answer' } }];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'chat', input: 'hello' });
  assert.equal(queryContext.allowPartialOnIdle, true);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].data.content, 'partial answer');
});

test('Tianxi tac-server runtime fails fast when qoder service account token is expired', async () => {
  let sent = false;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(100),
        tx_token: fakeJwt(100),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    readLatestQoderRuntimeSummaries: fakeExpiredQoderRuntimeRuns,
    enableSetTokenInjection: true,
    enableTianxiSuperModeRefresh: false,
    transport: {
      async sendQuery() {
        sent = true;
        return [];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  assert.equal(sent, false);
  assert.equal(result.frames[0].data.status, 'FAILED');
  assert.equal(result.frames[0].data.error_code, 'INVALID_CREDENTIALS');
  assert.match(result.frames[0].data.error_detail, /Service Account token has expired/);
  assert.deepEqual(result.frames[0].data.credential_state, {
    qoderExpired: true,
    txExpired: true,
    refreshPossibleWithTx: false,
  });
  assert.deepEqual(result.frames[0].data.qoder_runtime_state, {
    latestClassification: 'service_account_expired',
    latestRunLastTimestamp: '2026-09-18T07:09:45.782-07:00',
    latestInitializeStatus: 'error',
    latestCatalogReady: false,
    recentClassifications: ['service_account_expired'],
  });
  assert.ok(!JSON.stringify(result.frames[0].data).includes('must-not-leak'));
});

test('Tianxi tac-server runtime uses fresh registry qoder token over stale AgentCore log token', async () => {
  let sent;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(100),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      credentials: { qoder_token: 'fresh-registry-qoder-token' },
      credentialExpiry: {
        qoder_token: { expiresAtMs: 300000, expired: false },
      },
    }),
    transport: {
      async sendQuery(frame) {
        sent = frame;
        return [
          { type: 'task_output', data: { content: 'registry-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  assert.equal(sent.header.credentials.qoder_token, 'fresh-registry-qoder-token');
  assert.equal(result.frames[0].data.content, 'registry-ok');
});

test('Tianxi tac-server runtime injects fresh header qoder token before super query', async () => {
  let injected;
  let sent;
  const freshToken = fakeJwt(300);
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: freshToken,
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    enableSetTokenInjection: true,
    transport: {
      async sendControlCommand(command) {
        injected = command;
        return [{ type: 'ack', name: 'set_token' }];
      },
      async sendQuery(frame) {
        sent = frame;
        return [
          { type: 'task_output', data: { content: 'injected-header-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });

  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });

  assert.equal(injected.type, 'set_token');
  assert.equal(injected.header.app_id, 'app');
  assert.equal(injected.header.device_id, 'device');
  assert.equal(injected.header.user_id, 'user');
  assert.equal(typeof injected.header.session_id, 'string');
  assert.equal(typeof injected.header.request_id, 'string');
  assert.equal(injected.token, freshToken);
  assert.equal(sent.header.credentials.qoder_token, freshToken);
  assert.equal(result.frames[0].data.content, 'injected-header-ok');
});

test('Tianxi tac-server runtime recognizes routed dfmodel super payload for injection', async () => {
  let injected;
  const freshToken = fakeJwt(300);
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: freshToken,
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    enableSetTokenInjection: true,
    transport: {
      async sendControlCommand(command) {
        injected = command;
        return [{ type: 'ack', name: 'set_token' }];
      },
      async sendQuery() {
        return [
          { type: 'task_output', data: { content: 'routed-super-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });

  const result = await runtime.sendResponses(
    {
      model: 'dfmodel',
      metadata: {
        requestedModel: 'tianxi/super',
        routedModel: 'super',
        tianxi: { llm: 'dfmodel' },
      },
    },
    { now: () => 150000 }
  );

  assert.equal(injected.header.user_id, 'user');
  assert.equal(typeof injected.header.session_id, 'string');
  assert.equal(typeof injected.header.request_id, 'string');
  assert.equal(injected.token, freshToken);
  assert.equal(result.frames[0].data.content, 'routed-super-ok');
});

test('Tianxi tac-server runtime refreshes and injects qoder token before super query', async () => {
  let sent;
  let injected;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(100),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      credentials: { qoder_token: 'expired-registry-token' },
      credentialExpiry: {
        qoder_token: { expiresAtMs: 100000, expired: true },
        tianxi_login_token: { expiresAtMs: 300000, expired: false },
      },
    }),
    async refreshQoderToken() {
      return {
        attempted: true,
        status: 'refreshed',
        source: 'native',
        token: 'fresh-qoder-token',
        cache: {
          available: true,
          credentials: { qoder_token: 'fresh-qoder-token' },
          credentialExpiry: {
            qoder_token: { expiresAtMs: 300000, expired: false },
            tianxi_login_token: { expiresAtMs: 300000, expired: false },
          },
        },
      };
    },
    enableSetTokenInjection: true,
    transport: {
      async sendControlCommand(command) {
        injected = command;
        return [{ type: 'ack', name: 'set_token' }];
      },
      async sendQuery(frame) {
        sent = frame;
        return [
          { type: 'task_output', data: { content: 'refresh-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  assert.equal(injected.type, 'set_token');
  assert.equal(injected.header.app_id, 'app');
  assert.equal(injected.header.device_id, 'device');
  assert.equal(injected.header.user_id, 'user');
  assert.equal(typeof injected.header.session_id, 'string');
  assert.equal(typeof injected.header.request_id, 'string');
  assert.equal(injected.token, 'fresh-qoder-token');
  assert.equal(sent.header.credentials.qoder_token, 'fresh-qoder-token');
  assert.equal(result.frames[0].data.content, 'refresh-ok');
});

test('Tianxi runtime uses refreshed AgentCore header while registry cache remains expired', async () => {
  let refreshed = false;
  let sent;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: { qoder_token: fakeJwt(100), tx_token: fakeJwt(100) },
      device_id: 'device',
      user_id: 'user',
    },
    readLatestAgentCoreHeader: () => ({
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(refreshed ? 300 : 100),
        tx_token: fakeJwt(refreshed ? 300 : 100),
      },
      device_id: 'device',
      user_id: 'user',
    }),
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentialExpiry: { qoder_token: { expired: true } },
    }),
    async triggerTianxiQoderRefresh() {
      refreshed = true;
    },
    transport: {
      async sendQuery(frame) {
        sent = frame;
        return [
          { type: 'task_output', data: { content: 'agentcore-refresh-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  assert.equal(sent.header.credentials.qoder_token, fakeJwt(300));
  assert.equal(sent.header.credentials.tx_token, fakeJwt(300));
  assert.equal(result.frames[0].data.content, 'agentcore-refresh-ok');
});

test('Tianxi tac-server runtime does not send unsupported set_token by default', async () => {
  let injected = false;
  let sent;
  const freshToken = fakeJwt(300);
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: freshToken,
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    transport: {
      async sendControlCommand() {
        injected = true;
        throw new Error('set_token should be disabled');
      },
      async sendQuery(frame) {
        sent = frame;
        return [
          { type: 'task_output', data: { content: 'query-only-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });

  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });

  assert.equal(injected, false);
  assert.equal(sent.header.credentials.qoder_token, freshToken);
  assert.equal(result.frames[0].data.content, 'query-only-ok');
});

test('Tianxi tac-server runtime forces native refresh and retries catalog auth failure once', async () => {
  let queries = 0;
  let refreshReason = '';
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(300),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentials: {},
      credentialExpiry: {
        qoder_token: { expiresAtMs: 300000, expired: false },
      },
    }),
    async refreshQoderToken({ reason }) {
      refreshReason = reason;
      return {
        attempted: true,
        status: 'refreshed_agentcore',
        source: 'agentcore',
        token: fakeJwt(400),
        header: {
          app_id: 'app',
          credentials: { qoder_token: fakeJwt(400), tx_token: fakeJwt(300) },
          device_id: 'device',
          user_id: 'user',
        },
        cache: {
          available: true,
          hasQoderToken: true,
          credentials: {},
          credentialExpiry: {
            qoder_token: { expiresAtMs: 400000, expired: false },
          },
        },
      };
    },
    transport: {
      async sendQuery() {
        queries += 1;
        if (queries === 1) {
          return [
            {
              type: 'task_status',
              data: {
                status: 'FAILED',
                error_code: 'INVALID_CREDENTIALS',
                error_detail: 'catalog not ready after authentication',
              },
            },
          ];
        }
        return [
          { type: 'task_output', data: { content: 'retry-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });

  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });

  assert.equal(refreshReason, 'tac_server_auth_failure');
  assert.equal(queries, 2);
  assert.equal(result.frames[0].data.content, 'retry-ok');
});

test('Tianxi runtime retries auth failure with new AgentCore header rather than stale token', async () => {
  let queries = 0;
  let refreshed = false;
  const sentTokens = [];
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: { qoder_token: fakeJwt(300) },
      device_id: 'device',
      user_id: 'user',
    },
    readLatestAgentCoreHeader: () => ({
      app_id: 'app',
      credentials: { qoder_token: fakeJwt(refreshed ? 400 : 300) },
      device_id: 'device',
      user_id: 'user',
    }),
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentialExpiry: { qoder_token: { expired: true } },
    }),
    async triggerTianxiQoderRefresh() {
      refreshed = true;
    },
    transport: {
      async sendQuery(frame) {
        queries += 1;
        sentTokens.push(frame.header.credentials.qoder_token);
        if (queries === 1) {
          return [
            {
              type: 'task_status',
              data: {
                status: 'FAILED',
                error_code: 'INVALID_CREDENTIALS',
                error_detail: 'catalog not ready after authentication',
              },
            },
          ];
        }
        return [
          { type: 'task_output', data: { content: 'retry-new-header-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  assert.deepEqual(sentTokens, [fakeJwt(300), fakeJwt(400)]);
  assert.equal(result.frames[0].data.content, 'retry-new-header-ok');
});

test('Tianxi tac-server runtime triggers SuperMode UI refresh by default on catalog auth failure', async () => {
  let queries = 0;
  let uiTriggered = false;
  let spawned;
  const runtime = createTacServerTianxiNativeRuntime({
    forceWindows: true,
    tianxiSmartUiExePath: 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe',
    existsSync: () => true,
    spawn(file, args, options) {
      uiTriggered = true;
      spawned = { file, args, options };
      return { pid: 1234, unref() {} };
    },
    readLatestAgentCoreHeader: () => ({
      app_id: 'app',
      credentials: { qoder_token: fakeJwt(uiTriggered ? 400 : 300) },
      device_id: 'device',
      user_id: 'user',
    }),
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(300),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentials: {},
      credentialExpiry: {
        qoder_token: { expiresAtMs: uiTriggered ? 400000 : 300000, expired: false },
      },
    }),
    transport: {
      async sendQuery() {
        queries += 1;
        if (queries === 1) {
          return [
            {
              type: 'task_status',
              data: {
                status: 'FAILED',
                error_code: 'INVALID_CREDENTIALS',
                error_detail: 'catalog not ready after authentication',
              },
            },
          ];
        }
        return [
          { type: 'task_output', data: { content: 'ui-refresh-retry-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });

  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });

  assert.equal(queries, 2);
  assert.equal(result.frames[0].data.content, 'ui-refresh-retry-ok');
  assert.equal(spawned.file, 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe');
  assert.equal(spawned.args[0], '--xlcommunicationdata');
  assert.equal(spawned.args[1], '--xlsource=Codex');
  assert.equal(spawned.args[2].startsWith('--xlmessage='), true);
  assert.equal(spawned.options.detached, true);
  assert.equal(JSON.stringify(spawned).includes(fakeJwt(300)), false);
});

test('Tianxi tac-server runtime annotates catalog auth failure when native refresh is unavailable', async () => {
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(300),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentials: {},
      credentialExpiry: {
        qoder_token: { expiresAtMs: 300000, expired: false },
      },
    }),
    readLatestQoderRuntimeSummaries: fakeExpiredQoderRuntimeRuns,
    enableTianxiSuperModeRefresh: false,
    transport: {
      async sendQuery() {
        return [
          {
            type: 'task_status',
            data: {
              status: 'FAILED',
              error_code: 'INVALID_CREDENTIALS',
              error_detail: 'Service Account token has expired',
            },
          },
        ];
      },
    },
  });

  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  const status = result.frames[0].data;

  assert.equal(status.status, 'FAILED');
  assert.equal(status.error_code, 'INVALID_CREDENTIALS');
  assert.deepEqual(status.refresh_state, {
    attempted: false,
    status: 'no_native_refresh',
    source: 'registry',
    injected: false,
    errorCode: '',
  });
  assert.deepEqual(status.qoder_runtime_state, {
    latestClassification: 'service_account_expired',
    latestRunLastTimestamp: '2026-09-18T07:09:45.782-07:00',
    latestInitializeStatus: 'error',
    latestCatalogReady: false,
    recentClassifications: ['service_account_expired'],
  });
  assert.ok(!JSON.stringify(status).includes(fakeJwt(300)));
  assert.ok(!JSON.stringify(status).includes('must-not-leak'));
});

test('Tianxi tac-server runtime reports sanitized refresh state when refresh cannot obtain qoder token', async () => {
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(100),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      credentials: { qoder_token: 'expired-registry-token' },
      credentialExpiry: {
        qoder_token: { expiresAtMs: 100000, expired: true },
        tianxi_login_token: { expiresAtMs: 300000, expired: false },
      },
    }),
    async refreshQoderToken() {
      return {
        attempted: true,
        status: 'refresh_no_fresh_token',
        source: 'native',
        token: 'expired-registry-token',
      };
    },
    transport: {
      async sendQuery() {
        throw new Error('should not send query with expired token');
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });
  const status = result.frames[0].data;
  assert.equal(status.status, 'FAILED');
  assert.equal(status.error_code, 'INVALID_CREDENTIALS');
  assert.deepEqual(status.refresh_state, {
    attempted: true,
    status: 'refresh_no_fresh_token',
    source: 'native',
    injected: false,
    errorCode: '',
  });
  assert.ok(!JSON.stringify(status).includes('expired-registry-token'));
});

test('Tianxi tac-server runtime rejects encrypted cache without a fresh usable token', async () => {
  let sent = false;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(100),
        tx_token: fakeJwt(300),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentials: {},
      credentialExpiry: {
        qoder_token: { expiresAtMs: 100000, expired: true },
        tianxi_login_token: { expiresAtMs: 300000, expired: false },
      },
    }),
    async refreshQoderToken() {
      return {
        attempted: true,
        status: 'refreshed_encrypted_cache',
        source: 'native',
        cache: {
          available: true,
          hasQoderToken: true,
          credentials: {},
          credentialExpiry: {
            qoder_token: { expiresAtMs: 300000, expired: false },
            tianxi_login_token: { expiresAtMs: 300000, expired: false },
          },
        },
      };
    },
    transport: {
      async sendQuery() {
        sent = true;
        return [
          { type: 'task_output', data: { content: 'encrypted-cache-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });

  const result = await runtime.sendResponses({ model: 'super' }, { now: () => 150000 });

  assert.equal(sent, false);
  assert.equal(result.frames[0].data.status, 'FAILED');
  assert.equal(result.frames[0].data.error_code, 'INVALID_CREDENTIALS');
});

test('Tianxi tac-server runtime does not apply super qoder preflight to chat route', async () => {
  let sent = false;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: {
        qoder_token: fakeJwt(100),
      },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({ available: false, credentialExpiry: {} }),
    transport: {
      async sendQuery() {
        sent = true;
        return [
          { type: 'task_output', data: { content: 'chat-ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ];
      },
    },
  });
  const result = await runtime.sendResponses({ model: 'tianxi/chat' }, { now: () => 150000 });
  assert.equal(sent, true);
  assert.equal(result.frames[0].data.content, 'chat-ok');
});

test('Tianxi nativeApi channel runtime sends query and waits for terminal status', async () => {
  let registered = false;
  let sent;
  let callback;
  const runtime = createNativeApiChannelTianxiRuntime({
    transport: {
      registerChannel(channelName, onMessage) {
        assert.equal(channelName, 'aschannel');
        registered = true;
        callback = onMessage;
        return () => {
          registered = false;
        };
      },
      async sendChannelMessage(frame, channelName) {
        sent = { frame, channelName };
        callback({ type: 'task_output', data: { content: 'native-channel-ok' } });
        callback({ type: 'task_status', data: { status: 'COMPLETED' } });
      },
    },
  });
  const result = await runtime.sendResponses(
    {
      model: 'super',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello channel' }] }],
    },
    {
      now: () => 456,
      uuid: (() => {
        const values = ['session-2', 'request-2', 'query-2'];
        return () => values.shift();
      })(),
    }
  );
  assert.equal(runtime.name, 'nativeApi-channel');
  assert.equal(registered, false);
  assert.equal(sent.channelName, 'aschannel');
  assert.equal(sent.frame.data.text, 'hello channel');
  assert.equal(sent.frame.data.fromChannel, true);
  assert.equal(result.frames[0].data.content, 'native-channel-ok');
  assert.equal(result.frames[1].data.status, 'COMPLETED');
});

test('Tianxi AgentCore runtime builds native frames and parses notify payloads', async () => {
  let sent;
  const runtime = createAgentCoreTianxiNativeRuntime({
    transport: {
      async sendAgentCoreFrames(request) {
        sent = request;
        return { data: JSON.stringify({ type: 'task_output', data: { content: 'agentcore-ok' } }) };
      },
    },
  });
  const result = await runtime.sendResponses(
    {
      model: 'super',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello super' }] }],
    },
    {
      now: () => 123,
      uuid: (() => {
        const values = ['session-1', 'request-1', 'sync-1', 'query-1'];
        return () => values.shift();
      })(),
    }
  );
  assert.equal(runtime.name, 'agentcore');
  assert.equal(sent.sessionId, 'session-1');
  assert.equal(sent.frames[0].type, 'mcp_server_sync');
  assert.equal(sent.frames[1].type, 'query');
  assert.equal(sent.frames[1].data.text, 'hello super');
  assert.equal(result.frames[0].data.content, 'agentcore-ok');
});

test('Tianxi native runtime factory selects safe modes from env', async () => {
  assert.equal(createTianxiNativeRuntime({ env: {} }).name, 'fixture');
  assert.equal(
    createTianxiNativeRuntime({ env: { HPM_TIANXI_RUNTIME: 'native' } }).name,
    'native-unavailable'
  );
  await assert.rejects(
    createUnavailableTianxiNativeRuntime().sendResponses({ model: 'super' }),
    /tianxi_native_runtime_unavailable/
  );
});

test('Tianxi tac-server runtime retries auth only before visible output', async () => {
  let queries = 0;
  const emitted = [];
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: { qoder_token: fakeJwt(300) },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      hasQoderToken: true,
      credentialExpiry: { qoder_token: { expired: false } },
    }),
    async refreshQoderToken() {
      return {
        attempted: true,
        status: 'refreshed_agentcore',
        source: 'agentcore',
        token: fakeJwt(400),
        header: {
          app_id: 'app',
          credentials: { qoder_token: fakeJwt(400) },
          device_id: 'device',
          user_id: 'user',
        },
      };
    },
    transport: {
      async sendQuery(_frame, context) {
        queries += 1;
        if (queries === 1) {
          const failed = {
            type: 'task_status',
            data: {
              status: 'FAILED',
              error_code: 'INVALID_CREDENTIALS',
              error_detail: 'authentication failed',
            },
          };
          context.onFrame({ type: 'task_status', data: { status: 'WORKING' } });
          context.onFrame(failed);
          return [{ type: 'task_status', data: { status: 'WORKING' } }, failed];
        }
        const output = { type: 'task_output', data: { content: 'retry-ok' } };
        const completed = { type: 'task_status', data: { status: 'COMPLETED' } };
        context.onFrame(output);
        context.onFrame(completed);
        return [output, completed];
      },
    },
  });

  const result = await runtime.sendResponses(
    { model: 'super' },
    { now: () => 150000, onFrame: (frame) => emitted.push(frame) }
  );
  assert.equal(queries, 2);
  assert.equal(result.frames[0].data.content, 'retry-ok');
  assert.deepEqual(
    emitted.map((frame) => frame.type),
    ['task_output', 'task_status']
  );
  assert.ok(!JSON.stringify(emitted).includes('authentication failed'));

  queries = 0;
  emitted.length = 0;
  const visibleFailureRuntime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: { qoder_token: fakeJwt(300) },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      credentialExpiry: { qoder_token: { expired: false } },
    }),
    async refreshQoderToken() {
      throw new Error('must not retry after visible output');
    },
    transport: {
      async sendQuery(_frame, context) {
        queries += 1;
        const output = { type: 'task_output', data: { content: 'partial' } };
        const failed = {
          type: 'task_status',
          data: {
            status: 'FAILED',
            error_code: 'INVALID_CREDENTIALS',
            error_detail: 'authentication failed',
          },
        };
        context.onFrame(output);
        context.onFrame(failed);
        return [output, failed];
      },
    },
  });
  const failed = await visibleFailureRuntime.sendResponses(
    { model: 'super' },
    { now: () => 150000, onFrame: (frame) => emitted.push(frame) }
  );
  assert.equal(queries, 1);
  assert.equal(failed.frames[1].data.status, 'FAILED');
  assert.deepEqual(
    emitted.map((frame) => frame.type),
    ['task_output', 'task_status']
  );
});

test('Tianxi native transport enforces timeout, cancel and sanitized failures', async () => {
  let timeoutSignal;
  const timeoutRuntime = createTransportTianxiNativeRuntime({
    timeoutMs: 10,
    send: (_payload, context) => {
      timeoutSignal = context.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(timeoutRuntime.sendResponses({ model: 'super' }), (error) => {
    assert.equal(error.code, 'tianxi_native_runtime_timeout');
    assert.equal(error.status, 504);
    return true;
  });
  assert.equal(timeoutSignal.aborted, true);

  const controller = new AbortController();
  let transportSignal;
  const abortRuntime = createTransportTianxiNativeRuntime({
    timeoutMs: 1000,
    send: (_payload, context) => {
      transportSignal = context.signal;
      return new Promise(() => {});
    },
  });
  const aborted = abortRuntime.sendResponses({ model: 'super' }, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(aborted, (error) => {
    assert.equal(error.code, 'tianxi_native_runtime_aborted');
    assert.equal(error.status, 499);
    return true;
  });
  assert.equal(transportSignal.aborted, true);

  const brokenRuntime = createTransportTianxiNativeRuntime({
    send: async () => {
      const err = new Error('Authorization: Bearer sat-secret-token ' + 'a'.repeat(140));
      err.code = 'PIPE_FAILED';
      throw err;
    },
  });
  await assert.rejects(brokenRuntime.sendResponses({ model: 'super' }), (error) => {
    assert.equal(error.code, 'tianxi_native_runtime_failed');
    assert.equal(error.diagnostics.cause_code, 'PIPE_FAILED');
    assert.equal(error.diagnostics.cause_message.includes('sat-secret-token'), false);
    assert.equal(error.diagnostics.cause_message.includes('Authorization: Bearer'), false);
    assert.equal(error.diagnostics.cause_message.includes('a'.repeat(140)), false);
    return true;
  });
});
