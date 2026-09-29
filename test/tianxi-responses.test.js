'use strict';

const assert = require('assert');
const {
  buildTianxiResponsesResponse,
  createTianxiResponsesStream,
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
      exec_mode: 'local',
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
assert.strictEqual(response.status, 'incomplete');
assert.deepStrictEqual(response.incomplete_details, {
  reason: 'tianxi_tool_calls_pending',
});
assert.strictEqual(response.output[0].type, 'reasoning');
assert.deepStrictEqual(response.output[0].summary, [
  { type: 'summary_text', text: '先判断路径。' },
]);
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
assert.ok(stream.includes('event: response.in_progress'));
assert.ok(stream.includes('response.reasoning.delta'));
assert.ok(stream.includes('response.reasoning_summary_part.added'));
assert.ok(stream.includes('response.reasoning_summary_text.delta'));
assert.ok(stream.includes('response.reasoning_summary_text.done'));
assert.ok(stream.includes('response.reasoning_summary_part.done'));
assert.ok(stream.includes('先判断路径。'));
assert.ok(stream.includes('response.output_text.delta'));
assert.ok(stream.includes('可以接入。'));
assert.ok(stream.includes('response.function_call_arguments.delta'));
assert.ok(stream.includes('read_file'));
assert.ok(stream.includes('tianxi_permission_request'));
assert.ok(stream.includes('event: response.incomplete'));
assert.ok(!stream.includes('event: response.completed'));
assert.ok(stream.includes('event: response.content_part.added'));
assert.ok(stream.includes('event: response.content_part.done'));
assert.ok(stream.includes('event: response.output_item.done'));
assert.ok(stream.endsWith('data: [DONE]\n\n'));
const streamPayloads = stream
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch (_error) {
      return null;
    }
  })
  .filter(Boolean);
for (const payload of streamPayloads) {
  if (payload.type && payload.type !== 'response.created') {
    assert.ok(payload.response_id || payload.response, payload.type + ' is missing response_id');
  }
}
const incompleteRiskEvent = stream
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch (_error) {
      return null;
    }
  })
  .find((item) => item?.type === 'response.incomplete');
const reasoningAddedEvent = streamPayloads.find(
  (item) => item?.type === 'response.output_item.added' && item.item?.type === 'reasoning'
);
assert.equal(reasoningAddedEvent.item.status, 'in_progress');
assert.deepStrictEqual(reasoningAddedEvent.item.content, []);
const reasoningDoneEvent = streamPayloads.find(
  (item) => item?.type === 'response.output_item.done' && item.item?.type === 'reasoning'
);
assert.equal(reasoningDoneEvent.item.status, 'completed');
assert.deepStrictEqual(reasoningDoneEvent.item.summary, [
  { type: 'summary_text', text: '先判断路径。' },
]);
const reasoningSummaryPartAddedEvent = streamPayloads.find(
  (item) => item?.type === 'response.reasoning_summary_part.added'
);
assert.equal(reasoningSummaryPartAddedEvent.output_index, reasoningAddedEvent.output_index);
assert.deepStrictEqual(reasoningSummaryPartAddedEvent.part, {
  type: 'summary_text',
  text: '',
});
const reasoningSummaryDeltaEvent = streamPayloads.find(
  (item) => item?.type === 'response.reasoning_summary_text.delta'
);
assert.equal(reasoningSummaryDeltaEvent.delta, '先判断路径。');
assert.equal(reasoningSummaryDeltaEvent.summary_index, 0);
const reasoningSummaryTextDoneEvent = streamPayloads.find(
  (item) => item?.type === 'response.reasoning_summary_text.done'
);
assert.equal(reasoningSummaryTextDoneEvent.text, '先判断路径。');
const reasoningSummaryPartDoneEvent = streamPayloads.find(
  (item) => item?.type === 'response.reasoning_summary_part.done'
);
assert.deepStrictEqual(reasoningSummaryPartDoneEvent.part, {
  type: 'summary_text',
  text: '先判断路径。',
});
assert.equal(incompleteRiskEvent.response.output[1].type, 'message');
assert.equal(incompleteRiskEvent.response.output[1].content[0].text, '可以接入。');
assert.deepStrictEqual(incompleteRiskEvent.response.output, response.output);
assert.strictEqual(streamRes.ended, true);

const partialCallbackRes = fakeRes();
const partialCallbackStream = createTianxiResponsesStream(
  partialCallbackRes,
  { model: 'tianxi/super', input: 'ping' },
  'super',
  fakeDeps()
);
partialCallbackStream.writeFrame(frames[0]);
partialCallbackStream.finish(frames);
partialCallbackStream.finish(frames);
assert.equal((partialCallbackRes.text().match(/event: response.incomplete/g) || []).length, 1);
assert.equal((partialCallbackRes.text().match(/event: response.completed/g) || []).length, 0);
assert.ok(partialCallbackRes.text().includes('可以接入。'));
assert.equal((partialCallbackRes.text().match(/event: response.reasoning.delta/g) || []).length, 1);

const disconnectedRes = fakeRes();
const disconnectedStream = createTianxiResponsesStream(
  disconnectedRes,
  { model: 'tianxi/super', input: 'ping' },
  'super',
  fakeDeps()
);
const beforeDisconnect = disconnectedRes.text();
disconnectedRes.destroyed = true;
disconnectedStream.writeFrame(frames[0]);
disconnectedStream.finish(frames);
assert.equal(disconnectedRes.text(), beforeDisconnect);
assert.equal(disconnectedRes.ended, false);

const lateReasoningRes = fakeRes();
writeTianxiResponsesStream(
  lateReasoningRes,
  { model: 'tianxi/super', input: 'ping' },
  [
    { type: 'task_output', data: { content_type: 'text', content: 'Answer' } },
    { type: 'task_output', data: { reasoning_content: 'Reason' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
const lateReasoningDelta = lateReasoningRes
  .text()
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch (_error) {
      return null;
    }
  })
  .find((item) => item?.type === 'response.reasoning.delta');
assert.strictEqual(lateReasoningDelta.output_index, 1);

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
const incompleteEvent = incompleteStream
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch (_error) {
      return null;
    }
  })
  .find((item) => item?.type === 'response.incomplete');
assert.deepStrictEqual(incompleteEvent.response, incomplete);

const falsyToolOutputFrames = [
  {
    type: 'act_exec',
    data: { exec_mode: 'local', actions: [{ id: 'empty_output', name: 'Tool' }] },
  },
  { type: 'act_resp', data: { action_id: 'empty_output', output: '', secret: 'SECRET' } },
  {
    type: 'act_exec',
    data: { exec_mode: 'local', actions: [{ id: 'false_output', name: 'Tool' }] },
  },
  { type: 'act_resp', data: { action_id: 'false_output', output: false, secret: 'SECRET' } },
  {
    type: 'act_exec',
    data: { exec_mode: 'local', actions: [{ id: 'zero_output', name: 'Tool' }] },
  },
  { type: 'act_resp', data: { action_id: 'zero_output', output: 0, secret: 'SECRET' } },
  { type: 'task_status', data: { status: 'COMPLETED' } },
];
const falsyToolOutput = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  falsyToolOutputFrames,
  'super',
  fakeDeps()
);
assert.equal(falsyToolOutput.status, 'completed');
assert.deepStrictEqual(
  falsyToolOutput.output
    .filter((item) => item.type === 'function_call_output')
    .map((item) => item.output),
  ['', 'false', '0']
);
assert.ok(!JSON.stringify(falsyToolOutput).includes('SECRET'));
const falsyToolOutputStreamRes = fakeRes();
writeTianxiResponsesStream(
  falsyToolOutputStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  falsyToolOutputFrames,
  'super',
  fakeDeps()
);
assert.ok(!falsyToolOutputStreamRes.text().includes('SECRET'));

const workingOnly = [{ type: 'task_status', data: { status: 'WORKING' } }];
const missingTerminal = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  workingOnly,
  'super',
  fakeDeps()
);
assert.equal(missingTerminal.status, 'incomplete');
assert.equal(missingTerminal.incomplete_details.reason, 'tianxi_terminal_status_missing');
const missingTerminalStreamRes = fakeRes();
writeTianxiResponsesStream(
  missingTerminalStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  workingOnly,
  'super',
  fakeDeps()
);
assert.ok(missingTerminalStreamRes.text().includes('event: response.incomplete'));
assert.ok(!missingTerminalStreamRes.text().includes('event: response.completed'));

const emptyCompletion = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [{ type: 'task_status', data: { status: 'COMPLETED' } }],
  'super',
  fakeDeps()
);
assert.equal(emptyCompletion.status, 'incomplete');
assert.equal(emptyCompletion.incomplete_details.reason, 'tianxi_empty_completion');

const completedWithPendingPermission = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'approve?' },
  [
    {
      type: 'risk_exec',
      data: {
        action_id: 'approval_1',
        action_name: 'run_command',
        args: { command: 'dir' },
      },
    },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(completedWithPendingPermission.status, 'incomplete');
assert.equal(completedWithPendingPermission.incomplete_details.reason, 'tianxi_tool_calls_pending');

const nativeInternalFrames = [
  { type: 'act_exec', data: { exec_mode: 'cli', actions: [{ id: 'read_1', name: 'Read' }] } },
  { type: 'act_resp', data: { actions: [{ id: 'read_1', result: 'private source text' }] } },
  { type: 'task_output', data: { content_type: 'text', content: 'Project summary' } },
  { type: 'task_status', data: { status: 'COMPLETED' } },
];
const nativeInternal = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'inspect' },
  nativeInternalFrames,
  'super',
  fakeDeps()
);
assert.equal(nativeInternal.status, 'completed');
assert.deepEqual(
  nativeInternal.output.map((item) => item.type),
  ['reasoning', 'message']
);
assert.equal(nativeInternal.output[0].summary[0].text, 'Using Read.\nRead completed.\n');
assert.ok(!JSON.stringify(nativeInternal).includes('private source text'));
const nativeInternalStreamRes = fakeRes();
writeTianxiResponsesStream(
  nativeInternalStreamRes,
  { model: 'tianxi/super', input: 'inspect' },
  nativeInternalFrames,
  'super',
  fakeDeps()
);
assert.ok(nativeInternalStreamRes.text().includes('event: response.completed'));
assert.ok(nativeInternalStreamRes.text().includes('Using Read.'));
assert.ok(nativeInternalStreamRes.text().includes('Read completed.'));
assert.ok(!nativeInternalStreamRes.text().includes('response.function_call_arguments'));
assert.ok(!nativeInternalStreamRes.text().includes('private source text'));

const failed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [{ type: 'task_status', data: { status: 'FAILED', error_detail: 'boom' } }],
  'super',
  fakeDeps()
);
assert.strictEqual(failed.status, 'failed');
assert.strictEqual(failed.error.message, 'boom');
const failedStreamRes = fakeRes();
writeTianxiResponsesStream(
  failedStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  [{ type: 'task_status', data: { status: 'FAILED', error_detail: 'boom' } }],
  'super',
  fakeDeps()
);
const failedEvent = failedStreamRes
  .text()
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch (_error) {
      return null;
    }
  })
  .find((item) => item?.type === 'response.failed');
assert.deepStrictEqual(failedEvent.response, failed);

const failedWithPendingPermissionFrames = [
  {
    type: 'risk_exec',
    data: {
      action_id: 'approval_failed',
      action_name: 'run_command',
      args: { command: 'dir' },
    },
  },
  { type: 'task_status', data: { status: 'FAILED', error_detail: 'denied' } },
];
const failedWithPendingPermission = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'approve?' },
  failedWithPendingPermissionFrames,
  'super',
  fakeDeps()
);
assert.equal(failedWithPendingPermission.status, 'failed');
assert.equal(failedWithPendingPermission.error.message, 'denied');
assert.equal(Object.hasOwn(failedWithPendingPermission, 'incomplete_details'), false);
const failedWithPendingPermissionStreamRes = fakeRes();
writeTianxiResponsesStream(
  failedWithPendingPermissionStreamRes,
  { model: 'tianxi/super', input: 'approve?' },
  failedWithPendingPermissionFrames,
  'super',
  fakeDeps()
);
const failedWithPendingPermissionStream = failedWithPendingPermissionStreamRes.text();
assert.ok(failedWithPendingPermissionStream.includes('event: response.failed'));
assert.ok(!failedWithPendingPermissionStream.includes('event: response.incomplete'));

const sensitiveFailedFrame = {
  type: 'task_status',
  data: {
    status: 'FAILED',
    error_detail: 'Authorization: Bearer sat-secret-token ' + 'a'.repeat(140),
  },
};
const sensitiveFailed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [sensitiveFailedFrame],
  'super',
  fakeDeps()
);
const serializedSensitiveFailed = JSON.stringify(sensitiveFailed);
assert.strictEqual(sensitiveFailed.status, 'failed');
assert.ok(!serializedSensitiveFailed.includes('Authorization: Bearer'));
assert.ok(!serializedSensitiveFailed.includes('sat-secret-token'));
assert.ok(!serializedSensitiveFailed.includes('a'.repeat(140)));
const sensitiveFailedStreamRes = fakeRes();
writeTianxiResponsesStream(
  sensitiveFailedStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  [sensitiveFailedFrame],
  'super',
  fakeDeps()
);
const serializedSensitiveFailedStream = sensitiveFailedStreamRes.text();
assert.ok(serializedSensitiveFailedStream.includes('event: response.failed'));
assert.ok(!serializedSensitiveFailedStream.includes('Authorization: Bearer'));
assert.ok(!serializedSensitiveFailedStream.includes('sat-secret-token'));
assert.ok(!serializedSensitiveFailedStream.includes('a'.repeat(140)));

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

const explicitEmptyFields = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    { type: 'task_output', data: { content_type: 'text', content: '', delta: 'SECRET delta' } },
    {
      type: 'task_output',
      data: { reasoning_content: '', reasoning: 'SECRET reasoning' },
    },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(explicitEmptyFields.status, 'incomplete');
assert.equal(explicitEmptyFields.incomplete_details.reason, 'tianxi_empty_completion');
assert.ok(!JSON.stringify(explicitEmptyFields).includes('SECRET'));

const alternateReasoningFields = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    { type: 'task_output', data: { thought: 'thought field. ' } },
    {
      type: 'task_output',
      data: { content_type: 'reasoning', content: 'reasoning content type. ' },
    },
    {
      type: 'task_output',
      data: { content_stage: 'thinking', content: 'thinking stage. ' },
    },
    { type: 'task_output', data: { content_type: 'text', content: 'Final.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(alternateReasoningFields.status, 'completed');
assert.deepStrictEqual(alternateReasoningFields.output[0].summary, [
  {
    type: 'summary_text',
    text: 'thought field. reasoning content type. thinking stage. ',
  },
]);
assert.equal(alternateReasoningFields.output[1].content[0].text, 'Final.');
const alternateReasoningStreamRes = fakeRes();
writeTianxiResponsesStream(
  alternateReasoningStreamRes,
  { model: 'tianxi/super', input: 'ping' },
  [
    { type: 'task_output', data: { thought: 'thought field. ' } },
    {
      type: 'task_output',
      data: { content_type: 'reasoning', content: 'reasoning content type. ' },
    },
    {
      type: 'task_output',
      data: { content_stage: 'thinking', content: 'thinking stage. ' },
    },
    { type: 'task_output', data: { content_type: 'text', content: 'Final.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
const alternateReasoningStream = alternateReasoningStreamRes.text();
assert.equal((alternateReasoningStream.match(/event: response.reasoning.delta/g) || []).length, 3);
assert.equal(
  (alternateReasoningStream.match(/event: response.output_text.delta/g) || []).length,
  1
);

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
