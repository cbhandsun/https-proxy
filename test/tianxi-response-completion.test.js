'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildTianxiResponsesResponse,
  createTianxiResponsesStream,
} = require('../lib/proxy/tianxi-responses');

const deps = {
  responseId: 'resp_completion',
  createdAt: 123,
  nativeProgressMessages: true,
  nativeReasoningSegments: true,
};
const done = { type: 'task_status', data: { status: 'COMPLETED' } };
const answer = { type: 'task_output', data: { final: 'Synthetic answer' } };
const start = {
  type: 'act_exec',
  data: { exec_mode: 'local', actions: [{ id: 'synthetic_read', name: 'Read', args: {} }] },
};
const returned = {
  type: 'act_resp',
  data: { actions: [{ id: 'synthetic_read', result: 'synthetic result' }] },
};

function assertCompletion(frames, status, reason, termination = {}) {
  const chunks = [];
  const res = {
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      this.writableEnded = true;
    },
  };
  const stream = createTianxiResponsesStream(res, {}, 'super', deps);
  for (const frame of frames) stream.writeFrame(frame);
  assert.equal(
    stream.getSummary().pendingNativeToolCalls,
    frames.includes(start) && !frames.includes(returned) ? 1 : 0
  );
  const streamed = stream.finish([], termination);
  const json = buildTianxiResponsesResponse({}, frames, 'super', deps, termination);
  assert.deepEqual(streamed, json);
  assert.equal(json.status, status);
  assert.equal(json.incomplete_details?.reason, reason);
  const events = chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const terminals = events.filter((event) =>
    /^response\.(completed|incomplete|failed)$/.test(event.type)
  );
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'response.' + status);
  assert.deepEqual(terminals[0].response, json);
  assert.equal(stream.finish(), null);
  events.forEach((event, index) => {
    assert.equal(event.sequence_number, index);
    if (event.item_id) assert.equal(event.item_id, json.output[event.output_index].id);
    if (event.type === 'response.output_item.done')
      assert.deepEqual(event.item, json.output[event.output_index]);
  });
  assert.equal(
    stream.getSummary().pendingNativeToolCalls,
    frames.includes(start) && !frames.includes(returned) ? 1 : 0
  );
  return { json, events };
}

test('Reasoning and native commentary do not masquerade as a final answer', () => {
  for (const frames of [
    [done],
    [{ type: 'task_status', data: { status: 'WORKING' } }, done],
    [{ type: 'task_output', data: { reasoning_content: 'Synthetic reasoning' } }, done],
    [start, returned, done],
    [{ type: 'task_output', data: { final: '   ' } }, done],
  ])
    assertCompletion(frames, 'incomplete', 'tianxi_empty_completion');
});

test('Unresolved native permission prevents success even with final text and terminal status', () => {
  const permission = {
    type: 'risk_exec',
    data: { action_id: 'synthetic_read', action_name: 'Read' },
  };
  assertCompletion([permission, done], 'incomplete', 'tianxi_native_permission_required');
  assertCompletion([permission, answer, done], 'incomplete', 'tianxi_native_permission_required');
  assertCompletion([permission, start, returned, answer, done], 'completed', undefined);
  assertCompletion(
    [
      permission,
      { type: 'act_resp', data: { actions: [{ id: 'unrelated', result: 'ok' }] } },
      answer,
      done,
    ],
    'incomplete',
    'tianxi_native_permission_required'
  );
});

test('An unfinished native tool prevents successful completion even with an answer', () => {
  assertCompletion([start, answer, done], 'incomplete', 'tianxi_native_tools_pending');
  assertCompletion([start, returned, answer, done], 'completed', undefined);
});

test('Failure, interruption and missing native terminal retain precedence', () => {
  assertCompletion(
    [start, { type: 'task_status', data: { status: 'FAILED' } }],
    'failed',
    undefined
  );
  assertCompletion([start, answer, done], 'incomplete', 'tianxi_native_stream_interrupted', {
    interrupted: true,
  });
  assertCompletion([answer], 'incomplete', 'tianxi_terminal_status_missing');
  assertCompletion([start, answer], 'incomplete', 'tianxi_terminal_status_missing');
  assertCompletion([], 'incomplete', 'tianxi_terminal_status_missing');
});

test('Client-owned tools retain their continuation contract', () => {
  const external = {
    type: 'act_exec',
    data: { action_id: 'client_tool', action_name: 'probe', args: {} },
  };
  assertCompletion([external, done], 'incomplete', 'tianxi_tool_calls_pending');
  assertCompletion(
    [
      external,
      { type: 'act_resp', data: { action_id: 'client_tool', output: 'Synthetic result' } },
      done,
    ],
    'completed',
    undefined
  );
});

test('A 135-tool execution preserves event identities and a separate Unicode final answer', () => {
  const frames = [{ type: 'task_status', data: { status: 'WORKING' } }];
  for (let i = 0; i < 135; i++) {
    frames.push({
      type: 'act_exec',
      data: { exec_mode: 'local', actions: [{ id: 'read_' + i, name: 'Read' }] },
    });
    frames.push({
      type: 'act_resp',
      data: { actions: [{ id: 'read_' + i, result: 'PRIVATE_TOOL_RESULT' }] },
    });
  }
  frames.push({ type: 'task_output', data: { final: '完成 ✓' } }, done, done);
  const result = assertCompletion(frames, 'completed', undefined);
  assert.equal(result.json.output_text, '完成 ✓');
  assert.equal(result.json.output.filter((item) => item.phase === 'final_answer').length, 1);
  assert.ok(!JSON.stringify(result.events).includes('PRIVATE_TOOL_RESULT'));
});
