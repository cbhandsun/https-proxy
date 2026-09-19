'use strict';

const assert = require('assert');
const {
  buildTianxiResponsesResponse,
  writeTianxiResponsesStream,
} = require('../lib/proxy/tianxi-responses');
const { officialLoginProvider } = require('../lib/proxy/auth-mode');
const { validateConfig } = require('../lib/proxy/validator');

function fakeDeps() {
  return {
    fallbackId: (prefix) => prefix + '_test',
    stableCreated: () => 123,
  };
}

function fakeRes() {
  const writes = [];
  return {
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
    },
    end(chunk) {
      if (chunk) writes.push(String(chunk));
      this.ended = true;
    },
    text() {
      return writes.join('');
    },
  };
}

const frames = [
  {
    type: 'task_output',
    data: { reasoning_content: '先判断路径。' },
  },
  {
    type: 'task_output',
    data: { content_type: 'text', content: '可以接入。' },
  },
  {
    type: 'act_exec',
    data: {
      actions: [
        {
          id: 'act_1',
          name: 'read_file',
          parameters: { path: 'C:/safe/example.txt' },
        },
      ],
    },
  },
  {
    type: 'act_resp',
    data: {
      actions: [{ id: 'act_1', result: { status: 'success' } }],
    },
  },
  {
    type: 'risk_exec',
    data: {
      task_id: 'task_1',
      action_id: 'risk_1',
      action_name: 'run_command',
      args: { command: 'dir' },
    },
  },
  {
    type: 'task_status',
    data: { status: 'COMPLETED' },
  },
];

const response = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  frames,
  'super',
  fakeDeps()
);

assert.strictEqual(response.id, 'resp_test');
assert.strictEqual(response.status, 'completed');
assert.strictEqual(response.output[0].type, 'reasoning');
assert.strictEqual(response.output[0].summary, '先判断路径。');
assert.strictEqual(response.output[1].type, 'message');
assert.strictEqual(response.output[1].content[0].text, '可以接入。');
assert.strictEqual(response.output[2].type, 'function_call');
assert.strictEqual(response.output[2].name, 'read_file');
assert.strictEqual(response.output[2].arguments, '{"path":"C:/safe/example.txt"}');
assert.strictEqual(response.output[3].type, 'function_call_output');
assert.strictEqual(response.output[4].name, 'tianxi_permission_request');
assert.strictEqual(response.output[4].status, 'in_progress');
assert.deepStrictEqual(JSON.parse(response.output[4].arguments), {
  action_id: 'risk_1',
  tool_name: 'run_command',
  tool_input: { command: 'dir' },
});
assert.strictEqual(response.output[4].arguments.includes('task_1'), false);

const streamRes = fakeRes();
writeTianxiResponsesStream(
  streamRes,
  { model: 'tianxi/super', input: 'ping' },
  frames,
  'super',
  fakeDeps()
);
const stream = streamRes.text();
assert.ok(stream.includes('event: response.created'));
assert.ok(stream.includes('response.reasoning.delta'));
assert.ok(stream.includes('先判断路径。'));
assert.ok(stream.includes('response.output_text.delta'));
assert.ok(stream.includes('可以接入。'));
assert.ok(stream.includes('response.function_call_arguments.delta'));
assert.ok(stream.includes('read_file'));
assert.ok(stream.includes('tianxi_permission_request'));
assert.ok(stream.includes('event: response.completed'));
assert.strictEqual(streamRes.ended, true);

const pendingToolFrames = [
  { type: 'task_output', data: { content_type: 'text', content: '先搜索资料。' } },
  {
    type: 'risk_exec',
    data: {
      action_id: 'risk_search',
      tool_name: 'WebSearch',
      tool_input: { query: 'AI future office' },
      internal_token: 'do-not-leak',
    },
  },
  {
    type: 'act_exec',
    data: {
      actions: [
        {
          id: 'call_search',
          name: 'WebSearch',
          parameters: { query: 'AI future office' },
        },
      ],
    },
  },
];

const incomplete = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  pendingToolFrames,
  'super',
  fakeDeps()
);
assert.strictEqual(incomplete.status, 'incomplete');
assert.deepStrictEqual(incomplete.incomplete_details, {
  reason: 'tianxi_tool_calls_pending',
});
assert.strictEqual(
  incomplete.output.some((item) => item.type === 'function_call' && item.status === 'in_progress'),
  true
);

const incompleteStreamRes = fakeRes();
writeTianxiResponsesStream(
  incompleteStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  pendingToolFrames,
  'super',
  fakeDeps()
);
const incompleteStream = incompleteStreamRes.text();
assert.ok(incompleteStream.includes('event: response.incomplete'));
assert.ok(incompleteStream.includes('tianxi_tool_calls_pending'));
assert.ok(!incompleteStream.includes('event: response.completed'));
assert.ok(incompleteStream.includes('WebSearch'));
assert.ok(!incompleteStream.includes('do-not-leak'));

const failed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [{ type: 'task_status', data: { status: 'FAILED', error_detail: 'boom' } }],
  'super',
  fakeDeps()
);
assert.strictEqual(failed.status, 'failed');
assert.strictEqual(failed.error.message, 'boom');

const objectFailedFrame = {
  type: 'task_status',
  data: {
    status: 'FAILED',
    error_code: 'INVALID_CREDENTIALS',
    message: {
      errors: ['Service Account token has expired'],
      source: 'qoder',
      stage: 'result',
      subtype: 'error',
    },
  },
};
const objectFailed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [objectFailedFrame],
  'super',
  fakeDeps()
);
assert.strictEqual(objectFailed.status, 'failed');
assert.strictEqual(objectFailed.error.code, 'INVALID_CREDENTIALS');
assert.strictEqual(typeof objectFailed.error.message, 'string');
assert.ok(objectFailed.error.message.includes('qoder service account token has expired'));
assert.ok(objectFailed.error.message.includes('local Tianxi login token may still be valid'));
assert.ok(objectFailed.error.message.includes('chat or super mode'));

const expiredLoginFailed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    {
      type: 'task_status',
      data: {
        status: 'FAILED',
        error_code: 'INVALID_CREDENTIALS',
        error_detail: 'Service Account token has expired',
        credential_state: {
          qoderExpired: true,
          txExpired: true,
          refreshPossibleWithTx: false,
        },
      },
    },
  ],
  'super',
  fakeDeps()
);
assert.strictEqual(expiredLoginFailed.status, 'failed');
assert.ok(expiredLoginFailed.error.message.includes('login token observed'));
assert.ok(!JSON.stringify(expiredLoginFailed).includes('sat-'));

const registryLoginFreshFailed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    {
      type: 'task_status',
      data: {
        status: 'FAILED',
        error_code: 'INVALID_CREDENTIALS',
        error_detail: 'Service Account token has expired',
        credential_state: {
          qoderExpired: true,
          txExpired: true,
          refreshPossibleWithTx: false,
        },
        registry_credential_state: {
          qoderExpired: true,
          loginExpired: false,
          hasQoderToken: true,
          hasPlaintextQoderToken: false,
          refreshPossibleWithLogin: true,
        },
      },
    },
  ],
  'super',
  fakeDeps()
);
assert.strictEqual(registryLoginFreshFailed.status, 'failed');
assert.ok(registryLoginFreshFailed.error.message.includes('registry login cache is still valid'));
assert.ok(registryLoginFreshFailed.error.message.includes('fresh qoder_token'));
assert.deepStrictEqual(registryLoginFreshFailed.error.param.registry_credential_state, {
  qoderExpired: true,
  loginExpired: false,
  hasQoderToken: true,
  hasPlaintextQoderToken: false,
  refreshPossibleWithLogin: true,
});

const refreshDiagnosticFailed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    {
      type: 'task_status',
      data: {
        status: 'FAILED',
        error_code: 'INVALID_CREDENTIALS',
        error_detail: 'Service Account token has expired',
        refresh_state: {
          attempted: false,
          status: 'no_native_refresh',
          source: 'registry',
          token: 'must-not-leak',
        },
      },
    },
  ],
  'super',
  fakeDeps()
);
assert.strictEqual(refreshDiagnosticFailed.error.param.refresh_state.status, 'no_native_refresh');
assert.ok(!JSON.stringify(refreshDiagnosticFailed).includes('sat-'));
assert.ok(!JSON.stringify(refreshDiagnosticFailed).includes('must-not-leak'));

const catalogNotReadyFrame = {
  type: 'task_status',
  data: {
    status: 'FAILED',
    error_code: 'INVALID_CREDENTIALS',
    error_detail: 'catalog not ready after authentication',
    refresh_state: {
      attempted: false,
      status: 'no_native_refresh',
      source: 'registry',
      token: 'must-not-leak',
    },
    qoder_runtime_state: {
      latestClassification: 'service_account_expired',
      latestRunLastTimestamp: '2026-09-18T07:09:45.782-07:00',
      latestInitializeStatus: 'error',
      latestCatalogReady: false,
      recentClassifications: ['service_account_expired'],
      token: 'must-not-leak',
    },
  },
};
const catalogNotReadyFailed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [catalogNotReadyFrame],
  'super',
  fakeDeps()
);
assert.strictEqual(catalogNotReadyFailed.status, 'failed');
assert.ok(catalogNotReadyFailed.error.message.includes('Qoder model catalog is not ready'));
assert.ok(catalogNotReadyFailed.error.message.includes('service-account token was expired'));
assert.ok(catalogNotReadyFailed.error.message.includes('catalog_ready=true'));
assert.strictEqual(catalogNotReadyFailed.error.param.refresh_state.status, 'no_native_refresh');
assert.deepStrictEqual(catalogNotReadyFailed.error.param.qoder_runtime_state, {
  latestClassification: 'service_account_expired',
  latestRunLastTimestamp: '2026-09-18T07:09:45.782-07:00',
  latestInitializeStatus: 'error',
  latestCatalogReady: false,
  recentClassifications: ['service_account_expired'],
});
assert.ok(!Object.hasOwn(catalogNotReadyFailed.error.param.refresh_state, 'token'));
assert.ok(!Object.hasOwn(catalogNotReadyFailed.error.param.qoder_runtime_state, 'token'));
assert.ok(!JSON.stringify(catalogNotReadyFailed).includes('must-not-leak'));

const objectFailedStreamRes = fakeRes();
writeTianxiResponsesStream(
  objectFailedStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  [objectFailedFrame],
  'super',
  fakeDeps()
);
const objectFailedStream = objectFailedStreamRes.text();
assert.ok(objectFailedStream.includes('event: response.failed'));
assert.ok(objectFailedStream.includes('qoder service account token has expired'));

const catalogNotReadyStreamRes = fakeRes();
writeTianxiResponsesStream(
  catalogNotReadyStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  [catalogNotReadyFrame],
  'super',
  fakeDeps()
);
const catalogNotReadyStream = catalogNotReadyStreamRes.text();
assert.ok(catalogNotReadyStream.includes('event: response.failed'));
assert.ok(catalogNotReadyStream.includes('Qoder model catalog is not ready'));
assert.ok(catalogNotReadyStream.includes('service-account token was expired'));
assert.ok(!catalogNotReadyStream.includes('must-not-leak'));

assert.strictEqual(
  officialLoginProvider({
    id: 'custom-tianxi',
    protocol: 'tianxi',
    authMode: 'official-login',
    targetUrl: 'http://127.0.0.1:49305',
  }),
  'tianxi'
);

const validation = validateConfig({
  activeProfile: 'tianxi-official',
  profiles: [
    {
      id: 'tianxi-official',
      protocol: 'tianxi',
      authMode: 'official-login',
      targetUrl: 'http://127.0.0.1:49305',
    },
  ],
  modelRoutes: [{ from: 'tianxi/super', to: 'super', profileId: 'tianxi-official' }],
  localServer: { listenPort: 3443 },
});
assert.deepStrictEqual(validation.errors, []);

console.log('[tianxi-responses.test] ok');
