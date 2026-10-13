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
    data: { content_type: 'text', content_schema: 'final', content: '可以接入。' },
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
const nativeSummary =
  '先判断路径。\n- Tianxi native tool read_file (1 call) started.\n' +
  '\n- Tianxi native tool read_file (1 call) returned.\n' +
  '\n- Tianxi native tool tianxi_permission_request (1 call) awaiting permission.\n';

assert.strictEqual(response.id, 'resp_test');
assert.strictEqual(response.status, 'incomplete');
assert.strictEqual(response.incomplete_details.reason, 'tianxi_native_permission_required');
assert.strictEqual(response.output[0].type, 'reasoning');
assert.deepStrictEqual(response.output[0].summary, [
  {
    type: 'summary_text',
    text: nativeSummary,
  },
]);
assert.strictEqual(response.output[1].type, 'message');
assert.strictEqual(response.output[1].content[0].text, '可以接入。');
assert.strictEqual(response.output_text, '可以接入。');
assert.equal(response.output.length, 2);
assert.ok(!JSON.stringify(response).includes('C:/safe/example.txt'));
assert.ok(!JSON.stringify(response).includes('task_1'));

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
assert.ok(!stream.includes('event: response.reasoning.delta'));
assert.ok(!stream.includes('event: response.reasoning.done'));
assert.ok(stream.includes('response.reasoning_summary_part.added'));
assert.ok(stream.includes('response.reasoning_summary_text.delta'));
assert.ok(stream.includes('response.reasoning_summary_text.done'));
assert.ok(stream.includes('response.reasoning_summary_part.done'));
assert.ok(stream.includes('先判断路径。'));
assert.ok(stream.includes('response.output_text.delta'));
assert.ok(stream.includes('可以接入。'));
assert.ok(stream.includes('read_file'));
assert.ok(!stream.includes('custom_tool_call'));
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
streamPayloads.forEach((payload, index) => {
  if (payload.type?.startsWith('response.')) assert.equal(payload.sequence_number, index);
});
const completedRiskEvent = stream
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
assert.deepStrictEqual(reasoningAddedEvent.item.summary, []);
const reasoningDoneEvent = streamPayloads.find(
  (item) => item?.type === 'response.output_item.done' && item.item?.type === 'reasoning'
);
assert.equal(reasoningDoneEvent.item.status, 'incomplete');
assert.deepStrictEqual(reasoningDoneEvent.item.summary, [
  {
    type: 'summary_text',
    text: nativeSummary,
  },
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
assert.equal(reasoningSummaryTextDoneEvent.text, nativeSummary);
const reasoningSummaryPartDoneEvent = streamPayloads.find(
  (item) => item?.type === 'response.reasoning_summary_part.done'
);
assert.deepStrictEqual(reasoningSummaryPartDoneEvent.part, {
  type: 'summary_text',
  text: nativeSummary,
});
assert.equal(completedRiskEvent.response.output[1].type, 'message');
assert.equal(completedRiskEvent.response.output[1].content[0].text, '可以接入。');
assert.deepStrictEqual(completedRiskEvent.response.output, response.output);
const customInputEvents = streamPayloads.filter(
  (item) =>
    item?.type === 'response.custom_tool_call_input.delta' ||
    item?.type === 'response.custom_tool_call_input.done'
);
assert.equal(customInputEvents.length, 0);
assert.strictEqual(streamRes.ended, true);

const partialCallbackRes = fakeRes();
const partialCallbackStream = createTianxiResponsesStream(
  partialCallbackRes,
  { model: 'tianxi/super', input: 'ping' },
  'super',
  fakeDeps()
);
partialCallbackStream.writeFrame(frames[0]);
const partialCallbackResponse = partialCallbackStream.finish(frames);
partialCallbackStream.finish(frames);
assert.equal(partialCallbackResponse.status, 'incomplete');
assert.equal((partialCallbackRes.text().match(/event: response.incomplete/g) || []).length, 1);
assert.equal((partialCallbackRes.text().match(/event: response.completed/g) || []).length, 0);
assert.ok(partialCallbackRes.text().includes('可以接入。'));
assert.equal(
  (partialCallbackRes.text().match(/event: response.reasoning_summary_text.delta/g) || []).length,
  4
);
assert.deepStrictEqual(partialCallbackStream.getSummary(), {
  frameCount: frames.length,
  taskOutputFrames: 2,
  toolCallFrames: 2,
  toolResponseFrames: 1,
  reasoningChars: nativeSummary.length,
  textChars: '可以接入。'.length,
  outputMarkers: { none: 1, text: 1 },
  outputFields: { reasoning_content: 1, content: 1 },
  terminalFrameCount: 1,
  terminalStatus: 'COMPLETED',
  pendingToolCalls: 0,
  pendingNativeToolCalls: 0,
  pendingNativePermissions: 1,
  responseStatus: 'incomplete',
  incompleteReason: 'tianxi_native_permission_required',
  byteCount: partialCallbackStream.getSummary().byteCount,
});
assert.ok(partialCallbackStream.getSummary().byteCount > 0);

const unknownMarkerStream = createTianxiResponsesStream(
  fakeRes(),
  { model: 'tianxi/super', input: 'ping' },
  'super',
  fakeDeps()
);
unknownMarkerStream.writeFrame({
  type: 'task_output',
  data: { content_type: 'Authorization: Bearer private-value', unexpected: 'private-value' },
});
assert.deepStrictEqual(unknownMarkerStream.getSummary().outputMarkers, { other: 1 });
assert.deepStrictEqual(unknownMarkerStream.getSummary().outputFields, { none: 1 });

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
    {
      type: 'task_output',
      data: { content_type: 'text', content_schema: 'final', content: 'Answer' },
    },
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
  .find((item) => item?.type === 'response.reasoning_summary_text.delta');
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
  incomplete.output.some((item) => item.type === 'function_call' && item.status === 'incomplete'),
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
assert.equal(falsyToolOutput.status, 'incomplete');
assert.equal(falsyToolOutput.incomplete_details.reason, 'tianxi_empty_completion');
assert.deepStrictEqual(
  falsyToolOutput.output
    .filter((item) => item.type === 'custom_tool_call_output')
    .map((item) => item.output),
  []
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

const workingLocalToolsWithoutResponses = [
  { type: 'act_exec', data: { exec_mode: 'local', actions: [{ id: 'local_a', name: 'Read' }] } },
  { type: 'act_exec', data: { exec_mode: 'local', actions: [{ id: 'local_b', name: 'Grep' }] } },
  { type: 'task_status', data: { status: 'WORKING' } },
];
const recoveredWorkingLocalTools = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'audit' },
  workingLocalToolsWithoutResponses,
  'super',
  fakeDeps()
);
assert.equal(recoveredWorkingLocalTools.status, 'incomplete');
assert.equal(
  recoveredWorkingLocalTools.incomplete_details.reason,
  'tianxi_terminal_status_missing'
);
assert.deepEqual(
  recoveredWorkingLocalTools.output.map((item) => item.type),
  ['reasoning']
);
assert.equal(
  recoveredWorkingLocalTools.output[0].summary[0].text,
  '\n- Tianxi native tool Read (1 call) started.\n\n- Tianxi native tool Grep (1 call) started.\nTianxi native task is working.\n'
);
const recoveredWorkingLocalToolsStreamRes = fakeRes();
const recoveredWorkingLocalToolsStream = createTianxiResponsesStream(
  recoveredWorkingLocalToolsStreamRes,
  { model: 'tianxi/super', input: 'audit' },
  'super',
  fakeDeps()
);
for (const frame of workingLocalToolsWithoutResponses) {
  recoveredWorkingLocalToolsStream.writeFrame(frame);
}
const recoveredWorkingLocalToolsStreamResponse = recoveredWorkingLocalToolsStream.finish();
assert.equal(recoveredWorkingLocalToolsStreamResponse.status, 'incomplete');
assert.equal(recoveredWorkingLocalToolsStream.getSummary().pendingToolCalls, 0);
assert.ok(!recoveredWorkingLocalToolsStreamRes.text().includes('custom_tool_call'));
assert.ok(recoveredWorkingLocalToolsStreamRes.text().includes('event: response.incomplete'));

const toolOnlyBatchFrames = Array.from({ length: 11 }, (_, index) => ({
  type: 'act_exec',
  data: { exec_mode: 'cli', actions: [{ id: `read_${index}`, name: 'Read' }] },
}));
const toolOnlyBatch = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'audit' },
  toolOnlyBatchFrames,
  'super',
  fakeDeps()
);
const expectedToolProgress = Array.from(
  { length: 11 },
  (_, index) =>
    `\n- Tianxi native tool Read (${index + 1} ${index === 0 ? 'call' : 'calls'}) started.\n`
).join('');
assert.equal(toolOnlyBatch.output[0].summary[0].text, expectedToolProgress);
assert.equal(toolOnlyBatch.output.filter((item) => item.type === 'custom_tool_call').length, 0);
const toolOnlyBatchRes = fakeRes();
const toolOnlyBatchStream = writeTianxiResponsesStream(
  toolOnlyBatchRes,
  { model: 'tianxi/super', input: 'audit' },
  toolOnlyBatchFrames,
  'super',
  fakeDeps()
);
assert.equal(toolOnlyBatchStream.getSummary().reasoningChars, expectedToolProgress.length);
const toolOnlyBatchDeltas = toolOnlyBatchRes
  .text()
  .split('\n')
  .filter((line) => line.startsWith('data: {'))
  .map((line) => JSON.parse(line.slice(6)))
  .filter((item) => item.type === 'response.reasoning_summary_text.delta');
assert.equal(toolOnlyBatchDeltas.length, 11);
assert.equal(toolOnlyBatchDeltas.map((item) => item.delta).join(''), expectedToolProgress);

const workingOnly = [{ type: 'task_status', data: { status: 'WORKING' } }];
const missingTerminal = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  workingOnly,
  'super',
  fakeDeps()
);
assert.equal(missingTerminal.status, 'incomplete');
assert.equal(missingTerminal.incomplete_details.reason, 'tianxi_terminal_status_missing');
assert.equal(missingTerminal.output[0].summary[0].text, 'Tianxi native task is working.\n');
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
assert.ok(missingTerminalStreamRes.text().includes('Tianxi native task is working.'));

const missingTerminalWithOutput = [
  { type: 'act_exec', data: { exec_mode: 'cli', actions: [{ id: 'read_done', name: 'Read' }] } },
  { type: 'act_resp', data: { actions: [{ id: 'read_done', result: 'private source text' }] } },
  { type: 'task_output', data: { content_type: 'text', content: 'Audit summary' } },
];
const recoveredMissingTerminal = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'inspect' },
  missingTerminalWithOutput,
  'super',
  fakeDeps()
);
assert.equal(recoveredMissingTerminal.status, 'incomplete');
assert.equal(recoveredMissingTerminal.incomplete_details.reason, 'tianxi_terminal_status_missing');
assert.deepEqual(
  recoveredMissingTerminal.output.map((item) => item.type),
  ['reasoning', 'message']
);
assert.ok(!JSON.stringify(recoveredMissingTerminal).includes('private source text'));
const recoveredMissingTerminalStreamRes = fakeRes();
writeTianxiResponsesStream(
  recoveredMissingTerminalStreamRes,
  { model: 'tianxi/super', input: 'inspect' },
  missingTerminalWithOutput,
  'super',
  fakeDeps()
);
assert.ok(!recoveredMissingTerminalStreamRes.text().includes('event: response.completed'));
assert.ok(recoveredMissingTerminalStreamRes.text().includes('event: response.incomplete'));

const workingInternalToolsWithoutResponses = [
  { type: 'act_exec', data: { exec_mode: 'cli', actions: [{ id: 'read_a', name: 'Read' }] } },
  { type: 'act_exec', data: { exec_mode: 'cli', actions: [{ id: 'grep_b', name: 'Grep' }] } },
  { type: 'task_status', data: { status: 'WORKING' } },
];
const recoveredWorkingInternalTools = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'audit' },
  workingInternalToolsWithoutResponses,
  'super',
  fakeDeps()
);
assert.equal(recoveredWorkingInternalTools.status, 'incomplete');
assert.equal(
  recoveredWorkingInternalTools.incomplete_details.reason,
  'tianxi_terminal_status_missing'
);
assert.deepEqual(
  recoveredWorkingInternalTools.output.map((item) => item.type),
  ['reasoning']
);
assert.equal(
  recoveredWorkingInternalTools.output[0].summary[0].text,
  '\n- Tianxi native tool Read (1 call) started.\n\n- Tianxi native tool Grep (1 call) started.\nTianxi native task is working.\n'
);
const recoveredWorkingInternalToolsStreamRes = fakeRes();
const recoveredWorkingInternalToolsStream = createTianxiResponsesStream(
  recoveredWorkingInternalToolsStreamRes,
  { model: 'tianxi/super', input: 'audit' },
  'super',
  fakeDeps()
);
for (const frame of workingInternalToolsWithoutResponses) {
  recoveredWorkingInternalToolsStream.writeFrame(frame);
}
const recoveredWorkingInternalToolsStreamResponse = recoveredWorkingInternalToolsStream.finish();
assert.equal(recoveredWorkingInternalToolsStreamResponse.status, 'incomplete');
assert.equal(recoveredWorkingInternalToolsStream.getSummary().pendingToolCalls, 0);
assert.ok(!recoveredWorkingInternalToolsStreamRes.text().includes('custom_tool_call'));
assert.ok(recoveredWorkingInternalToolsStreamRes.text().includes('event: response.incomplete'));

const emptyCompletion = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [{ type: 'task_status', data: { status: 'COMPLETED' } }],
  'super',
  fakeDeps()
);
assert.equal(emptyCompletion.status, 'incomplete');
assert.equal(emptyCompletion.incomplete_details.reason, 'tianxi_empty_completion');

const completedWithNativePermission = buildTianxiResponsesResponse(
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
assert.equal(completedWithNativePermission.status, 'incomplete');
assert.equal(
  completedWithNativePermission.incomplete_details.reason,
  'tianxi_native_permission_required'
);
assert.deepEqual(
  completedWithNativePermission.output.map((item) => item.type),
  ['reasoning']
);
assert.ok(
  completedWithNativePermission.output[0].summary[0].text.includes('tianxi_permission_request')
);

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
assert.ok(nativeInternal.output[0].summary[0].text.includes('Tianxi native tool Read'));
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
assert.ok(!nativeInternalStreamRes.text().includes('Using Read.'));
assert.ok(!nativeInternalStreamRes.text().includes('Read completed.'));
assert.ok(!nativeInternalStreamRes.text().includes('custom_tool_call'));
assert.ok(!nativeInternalStreamRes.text().includes('"type":"function_call"'));
assert.ok(nativeInternalStreamRes.text().includes('response.output_item.done'));
assert.ok(!nativeInternalStreamRes.text().includes('private source text'));

const invalidNativeToolName = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'inspect' },
  [
    {
      type: 'act_exec',
      data: { exec_mode: 'cli', actions: [{ id: 'bad_name', name: '读取 文件' }] },
    },
    { type: 'act_resp', data: { actions: [{ id: 'bad_name', result: 'private source text' }] } },
    { type: 'task_output', data: { content_type: 'text', content: 'Project summary' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(invalidNativeToolName.status, 'incomplete');
assert.ok(invalidNativeToolName.output[0].summary[0].text.includes('Tianxi native tool tool'));
assert.ok(!JSON.stringify(invalidNativeToolName).includes('private source text'));

const failed = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [{ type: 'task_status', data: { status: 'FAILED', error_detail: 'boom' } }],
  'super',
  fakeDeps()
);
assert.strictEqual(failed.status, 'failed');
assert.strictEqual(failed.error.message, 'boom');
const structuredErrorFrames = [
  {
    type: 'task_status',
    data: {
      status: 'FAILED',
      error_detail: { unsupported: true },
      error: 'model unavailable sat-secret-token',
    },
  },
];
const structuredFailure = buildTianxiResponsesResponse(
  { model: 'tianxi/chat', input: 'ping' },
  structuredErrorFrames,
  'chat',
  fakeDeps()
);
assert.equal(structuredFailure.error.message, 'model unavailable sat-<redacted>');
const structuredStream = fakeRes();
writeTianxiResponsesStream(
  structuredStream,
  { model: 'tianxi/chat', input: 'ping' },
  structuredErrorFrames,
  'chat',
  fakeDeps()
);
assert.ok(structuredStream.text().includes('model unavailable sat-<redacted>'));
assert.ok(!structuredStream.text().includes('sat-secret-token'));
assert.ok(!structuredStream.text().includes('[object Object]'));
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
assert.strictEqual(failedWithPendingPermission.incomplete_details, null);
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
assert.equal(alternateReasoningFields.output_text, 'Final.');
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
assert.equal(
  (alternateReasoningStream.match(/event: response.reasoning_summary_text.delta/g) || []).length,
  3
);
assert.equal(
  (alternateReasoningStream.match(/event: response.output_text.delta/g) || []).length,
  1
);

const alternateTextFields = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    { type: 'task_output', data: { content_type: 'markdown', text: 'Markdown.' } },
    { type: 'task_output', data: { message: ' Message.' } },
    { type: 'task_output', data: { content_schema: 'final', answer: ' Answer.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(alternateTextFields.status, 'completed');
assert.equal(alternateTextFields.output[0].content[0].text, 'Markdown. Message. Answer.');
assert.equal(alternateTextFields.output_text, 'Markdown. Message. Answer.');

for (const scenario of [
  { data: { final: 'Final alias.' }, text: 'Final alias.' },
  {
    data: { content_schema: 'final', final: ['Nested', { final: ' answer.' }] },
    text: 'Nested answer.',
  },
  { data: { final: '' }, text: '' },
  { data: { final: null }, text: '' },
  { data: { content_type: 'text', content: '', final: 'SECRET fallback' }, text: '' },
  { data: { content_type: 'opaque', final: 'SECRET unknown output' }, text: '' },
  { data: { final: { type: 'function_call', arguments: 'SECRET tool args' } }, text: '' },
  {
    data: { final: Array.from({ length: 7 }).reduce((final) => ({ final }), 'SECRET deep') },
    text: '',
  },
]) {
  const aliasFrames = [
    { type: 'task_output', data: scenario.data },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ];
  const result = buildTianxiResponsesResponse({}, aliasFrames, 'super', fakeDeps());
  const res = fakeRes();
  const stream = createTianxiResponsesStream(res, {}, 'super', fakeDeps());
  stream.writeFrame(aliasFrames[0]);
  if (scenario.text) assert.ok(res.text().includes('response.output_text.delta'));
  const final = stream.finish(aliasFrames);
  assert.equal(result.output_text, scenario.text || undefined);
  assert.equal(result.status, scenario.text ? 'completed' : 'incomplete');
  assert.deepStrictEqual(final.output, result.output);
  assert.ok(!res.text().includes('SECRET'));
}

for (const terminalStatus of ['COMPLETED', 'FAILED', null]) {
  let idCalls = 0;
  let createdCalls = 0;
  const res = fakeRes();
  const stream = createTianxiResponsesStream(res, {}, 'super', {
    fallbackId: (prefix) => prefix + '_' + ++idCalls,
    stableCreated: () => ++createdCalls,
  });
  stream.writeFrame({ type: 'task_output', data: { final: 'unit answer' } });
  stream.writeFrame({ type: 'task_output', data: { reasoning_content: 'unit summary' } });
  const frames = terminalStatus ? [{ type: 'task_status', data: { status: terminalStatus } }] : [];
  const result = stream.finish(frames, { interrupted: terminalStatus === null });
  const events = res
    .text()
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const created = events.find((event) => event.type === 'response.created').response;
  assert.equal(idCalls, 1);
  assert.equal(createdCalls, 1);
  assert.equal(result.id, created.id);
  assert.equal(result.created_at, created.created_at);
  assert.equal(
    result.status,
    terminalStatus === 'COMPLETED'
      ? 'completed'
      : terminalStatus === 'FAILED'
        ? 'failed'
        : 'incomplete'
  );
  for (const event of events) {
    if (event.response_id) assert.equal(event.response_id, created.id);
    if (event.response) assert.equal(event.response.id, created.id);
    if (event.item_id) assert.equal(event.item_id, result.output[event.output_index].id);
    if (event.type === 'response.output_item.done')
      assert.deepStrictEqual(event.item, result.output[event.output_index]);
  }
}

const markerlessProgressFields = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    { type: 'task_output', data: { content: 'Inspecting project. ' } },
    { type: 'task_output', data: { text: 'Reading files. ' } },
    { type: 'task_output', data: { content_type: 'text', content: 'Final answer.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(markerlessProgressFields.status, 'completed');
assert.equal(markerlessProgressFields.output[0].type, 'reasoning');
assert.equal(
  markerlessProgressFields.output[0].summary[0].text,
  'Inspecting project. Reading files. '
);
assert.equal(markerlessProgressFields.output[1].type, 'message');
assert.equal(markerlessProgressFields.output_text, 'Final answer.');

const nestedTextFields = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'ping' },
  [
    {
      type: 'task_output',
      data: {
        content_type: 'text',
        content: [
          { type: 'text', text: 'Nested ' },
          { type: 'output_text', content: [{ type: 'text', text: 'parts.' }] },
        ],
      },
    },
    {
      type: 'task_output',
      data: {
        content_schema: 'reasoning',
        content: { parts: [{ text: 'Nested reasoning.' }] },
      },
    },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  'super',
  fakeDeps()
);
assert.equal(nestedTextFields.status, 'completed');
assert.equal(nestedTextFields.output_text, 'Nested parts.');
assert.equal(
  nestedTextFields.output.find((item) => item.type === 'reasoning').summary[0].text,
  'Nested reasoning.'
);

const liveTextFrames = [
  { type: 'task_output', data: { content_type: 'text', content: 'Inspecting ' } },
  { type: 'task_output', data: { content_type: 'text', content: 'files.' } },
  { type: 'act_exec', data: { exec_mode: 'cli', actions: [{ id: 'read_1', name: 'Read' }] } },
  { type: 'act_resp', data: { actions: [{ id: 'read_1', result: 'private data' }] } },
  { type: 'task_output', data: { content_type: 'text', content: 'Done.' } },
  { type: 'task_status', data: { status: 'COMPLETED' } },
];
const liveTextResponse = buildTianxiResponsesResponse(
  { model: 'tianxi/super', input: 'inspect' },
  liveTextFrames,
  'super',
  fakeDeps()
);
const liveTextProgress =
  'Inspecting files.\n- Tianxi native tool Read (1 call) started.\n' +
  '\n- Tianxi native tool Read (1 call) returned.\n';
assert.equal(
  liveTextResponse.output.find((item) => item.type === 'reasoning').summary[0].text,
  liveTextProgress
);
assert.equal(liveTextResponse.output_text, 'Done.');
const liveTextRes = fakeRes();
const liveTextStream = writeTianxiResponsesStream(
  liveTextRes,
  { model: 'tianxi/super', input: 'inspect' },
  liveTextFrames,
  'super',
  fakeDeps()
);
const liveTextEvents = liveTextRes
  .text()
  .split('\n')
  .filter((line) => line.startsWith('data: {'))
  .map((line) => JSON.parse(line.slice(6)));
assert.equal(
  liveTextEvents
    .filter((item) => item.type === 'response.reasoning_summary_text.delta')
    .map((item) => item.delta)
    .join(''),
  liveTextProgress
);
assert.equal(
  liveTextEvents
    .filter((item) => item.type === 'response.output_text.delta')
    .map((item) => item.delta)
    .join(''),
  'Done.'
);
assert.deepStrictEqual(
  liveTextEvents.find((item) => item.type === 'response.completed').response.output,
  liveTextResponse.output
);
assert.equal(liveTextStream.getSummary().reasoningChars, liveTextProgress.length);
assert.equal(liveTextStream.getSummary().textChars, 'Done.'.length);
assert.ok(!liveTextRes.text().includes('"type":"function_call"'));
assert.ok(!liveTextRes.text().includes('"type":"custom_tool_call"'));

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

for (const interruptedFrames of [
  [],
  [{ type: 'task_output', data: { content_type: 'text', content: 'Partial answer' } }],
  [
    { type: 'task_output', data: { content_type: 'text', content: 'Partial answer' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
]) {
  const res = fakeRes();
  const stream = createTianxiResponsesStream(res, {}, 'super', fakeDeps());
  for (const frame of interruptedFrames) stream.writeFrame(frame);
  const response = stream.finish([], { interrupted: true });
  assert.strictEqual(response.status, 'incomplete');
  assert.strictEqual(response.incomplete_details.reason, 'tianxi_native_stream_interrupted');
  assert.strictEqual((res.text().match(/event: response.completed/g) || []).length, 0);
  assert.strictEqual((res.text().match(/event: response.incomplete/g) || []).length, 1);
  if (interruptedFrames.length) {
    assert.strictEqual(response.output_text, 'Partial answer');
    assert.strictEqual(
      response.output.find((item) => item.type === 'message').status,
      'incomplete'
    );
    assert.ok(res.text().includes('"status":"incomplete","role":"assistant"'));
  }
  assert.strictEqual(stream.finish([], { interrupted: true }), null);
}
const failedInterrupted = buildTianxiResponsesResponse(
  {},
  [{ type: 'task_status', data: { status: 'FAILED' } }],
  'super',
  fakeDeps(),
  { interrupted: true }
);
assert.strictEqual(failedInterrupted.status, 'failed');

const alignmentRequest = { model: 'tianxi/super', input: 'hello' };
for (const alignmentFrames of [
  [
    { type: 'task_output', data: { reasoning_content: 'Progress' } },
    { type: 'task_output', data: { content_schema: 'final', content: 'Answer' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  [
    { type: 'task_output', data: { content_schema: 'final', content: 'Answer' } },
    { type: 'task_output', data: { reasoning_content: 'Late progress' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  [
    { type: 'task_output', data: { content_schema: 'final', content: 'x'.repeat(65536) } },
    { type: 'task_status', data: { status: 'FAILED' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  [
    { type: 'task_output', data: { reasoning_content: 'Progress' } },
    { type: 'task_status', data: { status: 'CANCELED' } },
    { type: 'task_status', data: { status: 'WORKING' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ],
  [],
]) {
  const res = fakeRes();
  const alignedStream = createTianxiResponsesStream(
    res,
    alignmentRequest,
    'internal-route',
    fakeDeps()
  );
  alignmentFrames.forEach(alignedStream.writeFrame);
  const result = alignedStream.finish();
  const events = res
    .text()
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  assert.strictEqual(result.model, 'tianxi/super');
  assert.ok(Object.hasOwn(result, 'incomplete_details'));
  const providerFailed = alignmentFrames.some((frame) =>
    ['FAILED', 'CANCELED'].includes(frame.data?.status)
  );
  if (providerFailed) assert.strictEqual(result.status, 'failed');
  events.forEach((event, index) => {
    assert.strictEqual(event.sequence_number, index);
    assert.ok(!['response.reasoning.delta', 'response.reasoning.done'].includes(event.type));
    if (['response.created', 'response.in_progress'].includes(event.type)) {
      assert.strictEqual(event.response.model, result.model);
      assert.strictEqual(event.response.error, null);
      assert.strictEqual(event.response.incomplete_details, null);
      assert.strictEqual(event.response.usage, null);
    }
    if (['response.output_text.delta', 'response.output_text.done'].includes(event.type)) {
      assert.deepStrictEqual(event.logprobs, []);
    }
    if (event.type === 'response.output_item.added' && event.item.type === 'reasoning') {
      assert.deepStrictEqual(event.item.summary, []);
    }
    if (event.type === 'response.output_item.done') {
      assert.deepStrictEqual(event.item, result.output[event.output_index]);
    }
    if (event.item_id) assert.strictEqual(event.item_id, result.output[event.output_index].id);
  });
  for (const item of result.output) {
    if (item.type !== 'message') continue;
    assert.strictEqual(item.status, result.status === 'completed' ? 'completed' : 'incomplete');
    assert.deepStrictEqual(item.content[0].annotations, []);
    assert.deepStrictEqual(item.content[0].logprobs, []);
  }
  assert.deepStrictEqual(events.at(-1).response, result);
}

const lifecycleFrames = [
  { type: 'task_output', data: { reasoning_content: 'Inspecting inputs.\n' } },
  {
    type: 'act_exec',
    data: {
      exec_mode: 'cli',
      actions: [
        {
          id: 'batch_a',
          name: 'Read',
          parameters: { token: 'sat-private-token', path: 'private/file' },
        },
        null,
        'invalid',
        [],
        { id: 'batch_b', name: 'Grep', parameters: { pattern: 'private-content' } },
      ],
    },
  },
  { type: 'task_output', data: { content_type: 'text', content: 'Checking tool progress.\n' } },
  {
    type: 'act_resp',
    data: {
      actions: [
        { id: 'batch_b', status: 'FAILED', result: 'private-content' },
        { id: 'batch_a', result: 'private-file-text', error_detail: 'sat-private-token' },
      ],
    },
  },
  { type: 'act_exec', data: { exec_mode: 'cli', actions: [{ id: 'batch_a', name: 'Read' }] } },
  { type: 'act_resp', data: { actions: [{ id: 'batch_a', result: 'private-file-text' }] } },
  { type: 'act_resp', data: { actions: [{ id: 'unknown', result: 'private-file-text' }] } },
  {
    type: 'act_exec',
    data: { exec_mode: 'cli', actions: [{ id: 'secret_name', name: 'sat-private-token' }] },
  },
  {
    type: 'act_resp',
    data: { action_id: 'secret_name', success: false, output: 'private-content' },
  },
];
const lifecycleRes = fakeRes();
const lifecycleStream = createTianxiResponsesStream(
  lifecycleRes,
  alignmentRequest,
  'super',
  fakeDeps()
);
for (const frame of lifecycleFrames) lifecycleStream.writeFrame(frame);
const lifecycleLiveEvents = lifecycleRes
  .text()
  .split('\n')
  .filter((line) => line.startsWith('data: {'))
  .map((line) => JSON.parse(line.slice(6)));
const lifecycleDeltas = lifecycleLiveEvents.filter(
  (event) => event.type === 'response.reasoning_summary_text.delta'
);
const lifecycleLiveText = lifecycleDeltas.map((event) => event.delta).join('');
assert.strictEqual(lifecycleRes.ended, false);
assert.ok(lifecycleLiveText.includes('Checking tool progress.'));
assert.strictEqual((lifecycleLiveText.match(/Read \(1 call\) started\./g) || []).length, 1);
assert.strictEqual((lifecycleLiveText.match(/Read \(1 call\) returned\./g) || []).length, 1);
assert.ok(lifecycleLiveText.includes('Grep (1 call) failed.'));
assert.ok(lifecycleLiveText.includes('tool (1 call) failed.'));
for (const secret of [
  'sat-private-token',
  'private/file',
  'private-content',
  'private-file-text',
]) {
  assert.ok(!lifecycleRes.text().includes(secret));
}
assert.ok(!lifecycleRes.text().includes('"type":"function_call"'));
const lifecycleFinalFrames = [
  ...lifecycleFrames,
  { type: 'task_output', data: { content_schema: 'final', content: 'Final answer.' } },
  { type: 'task_status', data: { status: 'COMPLETED' } },
];
const lifecycleResult = lifecycleStream.finish(lifecycleFinalFrames);
assert.strictEqual(lifecycleResult.status, 'completed');
assert.strictEqual(lifecycleResult.output_text, 'Final answer.');
assert.strictEqual(
  lifecycleResult.output.find((item) => item.type === 'reasoning').summary[0].text,
  lifecycleLiveText
);
assert.deepStrictEqual(
  lifecycleResult,
  buildTianxiResponsesResponse(alignmentRequest, lifecycleFinalFrames, 'super', fakeDeps())
);

const boundedBatch = buildTianxiResponsesResponse(
  alignmentRequest,
  [
    {
      type: 'act_exec',
      data: {
        exec_mode: 'cli',
        actions: Array.from({ length: 129 }, (_, index) => ({
          id: 'bounded_' + index,
          name: 'Read',
        })),
      },
    },
  ],
  'super',
  fakeDeps()
);
assert.strictEqual(
  (boundedBatch.output[0].summary[0].text.match(/Tianxi native tool/g) || []).length,
  128
);

const stalledAuditFrames = [
  ...Array.from({ length: 4 }, (_, index) => ({
    type: 'act_exec',
    data: {
      exec_mode: 'cli',
      actions: [{ id: 'stalled_' + index, name: 'Read' }],
    },
  })),
  {
    type: 'task_output',
    data: { content_type: 'text', content: 'I will start exploring the project.' },
  },
  { type: 'task_status', data: { status: 'WORKING' } },
];
const stalledRes = fakeRes();
const stalledStream = createTianxiResponsesStream(
  stalledRes,
  alignmentRequest,
  'super',
  fakeDeps()
);
stalledAuditFrames.forEach(stalledStream.writeFrame);
const stalledResponse = stalledStream.finish();
assert.equal(stalledResponse.status, 'incomplete');
assert.equal(stalledResponse.incomplete_details.reason, 'tianxi_terminal_status_missing');
assert.equal(stalledResponse.output.find((item) => item.type === 'message').status, 'incomplete');
assert.ok(stalledRes.text().includes('event: response.incomplete'));
assert.ok(!stalledRes.text().includes('event: response.completed'));

for (const [message, secret] of [
  ['Authorization: Bearer short-private-credential', 'short-private-credential'],
  ['Proxy-Authorization: Basic c2VjcmV0', 'c2VjcmV0'],
  ['Cookie: session=private-session; other=private-cookie', 'private-cookie'],
  ['upstream rejected api_key="private key with spaces"', 'private key with spaces'],
  ['upstream rejected {"access_token":"private-json-token"}', 'private-json-token'],
]) {
  const frames = [{ type: 'task_status', data: { status: 'FAILED', error: message } }];
  const result = buildTianxiResponsesResponse({ input: 'ping' }, frames, 'chat', fakeDeps());
  assert.ok(!JSON.stringify(result).includes(secret), 'public JSON must redact credential values');
  const sink = fakeRes();
  writeTianxiResponsesStream(sink, { input: 'ping' }, frames, 'chat', fakeDeps());
  assert.ok(!sink.text().includes(secret), 'public SSE must redact credential values');
}
console.log('[tianxi-responses.test] ok');
const diagnosticFailure = buildTianxiResponsesResponse(
  { input: 'ping' },
  [
    {
      type: 'task_status',
      data: {
        status: 'FAILED',
        error: 'failed',
        qoder_runtime_state: { note: 'Bearer private-diag-token' },
      },
    },
  ],
  'chat',
  fakeDeps()
);
assert.ok(
  !JSON.stringify(diagnosticFailure).includes('private-diag-token'),
  'nested diagnostic strings must redact credentials'
);
const diagnosticFailureSink = fakeRes();
writeTianxiResponsesStream(
  diagnosticFailureSink,
  { input: 'ping' },
  [
    {
      type: 'task_status',
      data: {
        status: 'FAILED',
        error: 'failed',
        qoder_runtime_state: { note: 'Bearer private-diag-token' },
      },
    },
  ],
  'chat',
  fakeDeps()
);
assert.ok(!diagnosticFailureSink.text().includes('private-diag-token'));
