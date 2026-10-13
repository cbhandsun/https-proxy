'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTianxiResponsesStream } = require('../lib/proxy/tianxi-responses');
const { replayTianxiResult } = require('../lib/proxy/tianxi-tool-result-replay');
const { createTianxiToolResultCache } = require('../lib/proxy/tianxi-tool-result-cache');

function sink() {
  return {
    data: '',
    headersSent: false,
    writeHead() {
      this.headersSent = true;
    },
    write(text) {
      this.data += text;
    },
    end() {
      this.writableEnded = true;
    },
    events() {
      return this.data
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
    },
  };
}

function assertLifecycle(events, terminal) {
  const added = new Map();
  const closed = new Set();
  const parts = new Map();
  events.forEach((event, index) => {
    assert.equal(event.sequence_number, index);
    if (event.type === 'response.output_item.added') {
      assert.equal(added.has(event.output_index), false);
      added.set(event.output_index, event.item.id);
      assert.equal(event.item.status, 'in_progress');
    }
    if (event.item_id) {
      assert.equal(event.item_id, added.get(event.output_index));
      assert.equal(event.item_id, terminal.output[event.output_index].id);
      assert.equal(closed.has(event.output_index), false);
    }
    if (event.type === 'response.content_part.added') {
      parts.set(event.output_index + ':' + event.content_index, '');
      assert.equal(event.part.text, '');
    }
    if (event.type === 'response.reasoning_summary_part.added') {
      parts.set('reasoning:' + event.output_index + ':' + event.summary_index, '');
      assert.equal(event.part.text, '');
    }
    if (event.type === 'response.reasoning_summary_text.delta') {
      const key = 'reasoning:' + event.output_index + ':' + event.summary_index;
      assert.ok(parts.has(key));
      parts.set(key, parts.get(key) + event.delta);
    }
    if (event.type === 'response.reasoning_summary_text.done') {
      assert.equal(
        event.text,
        parts.get('reasoning:' + event.output_index + ':' + event.summary_index)
      );
      assert.equal(
        event.text,
        terminal.output[event.output_index].summary[event.summary_index].text
      );
    }
    if (event.type === 'response.output_text.delta') {
      const key = event.output_index + ':' + event.content_index;
      assert.ok(parts.has(key));
      parts.set(key, parts.get(key) + event.delta);
      assert.deepEqual(event.logprobs, []);
    }
    if (event.type === 'response.output_text.done') {
      assert.equal(event.text, parts.get(event.output_index + ':' + event.content_index));
      assert.equal(
        event.text,
        terminal.output[event.output_index].content[event.content_index].text
      );
    }
    if (event.type === 'response.output_item.done') {
      assert.equal(closed.has(event.output_index), false);
      closed.add(event.output_index);
      assert.equal(event.item.id, added.get(event.output_index));
      assert.deepEqual(event.item, terminal.output[event.output_index]);
    }
  });
  assert.equal(added.size, terminal.output.length);
  assert.equal(closed.size, terminal.output.length);
  assert.equal(
    events.filter((event) =>
      ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)
    ).length,
    1
  );
}

test('deferred no-tool answer keeps item indexes aligned when progress follows answer text', () => {
  const res = sink();
  const stream = createTianxiResponsesStream(res, {}, 'super', {
    responseId: 'resp_contract',
    createdAt: 123,
    nativeProgressMessages: true,
    resultBridge: { hasCalls: false, start: () => null },
  });
  const frames = [
    { type: 'task_output', data: { content_type: 'answer', content: 'A' } },
    { type: 'task_status', data: { status: 'WORKING' } },
    { type: 'task_output', data: { reasoning_content: 'Summary' } },
    { type: 'task_output', data: { content_type: 'answer', content: 'B' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ];
  frames.forEach(stream.writeFrame);
  const final = stream.finish();
  assert.equal(final.output_text, 'AB');
  assert.equal(final.output.at(-1).phase, 'final_answer');
  assertLifecycle(res.events(), final);
});

function cachedResponse(status = 'completed') {
  return {
    id: 'resp_old',
    object: 'response',
    created_at: 123,
    model: 'tianxi/super',
    status,
    error: status === 'failed' ? { code: 'native_failed', message: 'Native failed.' } : null,
    incomplete_details:
      status === 'incomplete' ? { reason: 'tianxi_native_stream_interrupted' } : null,
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    output: [
      {
        id: 'msg_old',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        status: status === 'completed' ? 'completed' : 'incomplete',
        content: [
          { type: 'output_text', text: 'A', annotations: [] },
          { type: 'output_text', text: 'B', annotations: [] },
        ],
      },
    ],
  };
}

test('replay snapshots start in progress without final errors or usage and preserve terminal state', () => {
  for (const status of ['completed', 'failed', 'incomplete']) {
    const original = cachedResponse(status);
    const res = sink();
    const final = replayTianxiResult(original, res, true);
    const events = res.events();
    assert.equal(events[0].type, 'response.created');
    assert.equal(events[1].type, 'response.in_progress');
    for (const event of events.slice(0, 2)) {
      assert.equal(event.response.status, 'in_progress');
      assert.deepEqual(event.response.output, []);
      assert.equal(event.response.error, null);
      assert.equal(event.response.incomplete_details, null);
      assert.equal(event.response.usage, null);
      assert.equal(event.response.output_text, '');
    }
    assert.equal(final.output_text, 'AB');
    assert.equal(events.at(-1).type, 'response.' + status);
    assert.deepEqual(final.error, original.error);
    assert.deepEqual(final.incomplete_details, original.incomplete_details);
    assert.deepEqual(final.usage, original.usage);
    assert.notEqual(final.id, original.id);
    assert.equal(final.output[0].phase, 'final_answer');
    assertLifecycle(events, final);
  }
});

test('cache and replay reject malformed final messages before any stream headers', () => {
  const malformed = [
    { type: 'message', role: 'assistant' },
    { ...cachedResponse().output[0], content: null },
    { ...cachedResponse().output[0], content: [{ type: 'output_text', text: {} }] },
    {
      ...cachedResponse().output[0],
      content: [{ type: 'output_text', text: 'x', annotations: {} }],
    },
    { ...cachedResponse().output[0], content: [{ type: 'function_call', name: 'Read' }] },
    { ...cachedResponse().output[0], phase: 'commentary' },
    { ...cachedResponse().output[0], phase: 'analysis' },
    { ...cachedResponse().output[0], status: 'in_progress' },
    { ...cachedResponse().output[0], id: '' },
    {
      ...cachedResponse().output[0],
      content: Array(129).fill({ type: 'output_text', text: '', annotations: [] }),
    },
    {
      ...cachedResponse().output[0],
      content: [{ type: 'output_text', text: 'x'.repeat(1024 * 1024 + 1), annotations: [] }],
    },
  ];
  const cache = createTianxiToolResultCache();
  const task = cache.begin('owner');
  for (const item of malformed) {
    const value = { ...cachedResponse(), output: [item] };
    assert.equal(cache.settle('owner', task, 'completed', value), false);
    const res = sink();
    assert.throws(() => replayTianxiResult(value, res, true), /Invalid cached Tianxi response/);
    assert.equal(res.headersSent, false);
    assert.equal(res.data, '');
  }
  for (const value of [
    null,
    {},
    { ...cachedResponse(), output_text: 'wrong' },
    { ...cachedResponse(), output: Array(129).fill(cachedResponse().output[0]) },
  ]) {
    const res = sink();
    assert.throws(() => replayTianxiResult(value, res, true));
    assert.equal(res.headersSent, false);
  }
  assert.equal(cache.settle('owner', task, 'completed', cachedResponse()), true);
});

test('empty incomplete replay remains incomplete and never emits fabricated text', () => {
  const res = sink();
  const final = replayTianxiResult({ ...cachedResponse('incomplete'), output: [] }, res, true);
  assert.equal(final.output_text, '');
  assert.equal(
    res.events().some((event) => event.type === 'response.output_text.delta'),
    false
  );
  assert.equal(res.events().at(-1).type, 'response.incomplete');
  assertLifecycle(res.events(), final);
});

test('pending tool items close once with incomplete status before every terminal outcome', () => {
  for (const outcome of ['missing', 'COMPLETED', 'FAILED', 'interrupted']) {
    const res = sink();
    const stream = createTianxiResponsesStream(res, {}, 'super', {
      responseId: 'resp_pending_contract',
      createdAt: 123,
    });
    stream.writeFrame({
      type: 'act_exec',
      data: { actions: [{ id: 'pending-call', name: 'Read', args: { path: 'PRIVATE' } }] },
    });
    if (outcome === 'COMPLETED' || outcome === 'FAILED') {
      stream.writeFrame({ type: 'task_status', data: { status: outcome } });
    }
    const final = stream.finish([], { interrupted: outcome === 'interrupted' });
    assert.equal(final.status, outcome === 'FAILED' ? 'failed' : 'incomplete');
    assert.equal(final.output[0].status, 'incomplete');
    assertLifecycle(res.events(), final);
    const before = res.data;
    stream.finish();
    assert.equal(res.data, before);
  }
});

test('reasoning accumulates within segments and closes before tool progress and final answer', () => {
  const res = sink();
  const stream = createTianxiResponsesStream(res, {}, 'super', {
    responseId: 'resp_segments',
    createdAt: 123,
    nativeProgressMessages: true,
    nativeReasoningSegments: true,
  });
  stream.writeFrame({ type: 'task_output', data: { reasoning_content: 'A' } });
  stream.writeFrame({ type: 'task_output', data: { reasoning_content: 'B' } });
  assert.equal(
    res.events().filter((event) => event.type === 'response.output_item.done').length,
    0
  );
  stream.writeFrame({
    type: 'act_exec',
    data: { exec_mode: 'native', actions: [{ id: 'read', name: 'Read' }] },
  });
  const early = res.events().find((event) => event.type === 'response.output_item.done');
  assert.equal(early.item.type, 'reasoning');
  assert.equal(early.item.summary[0].text, 'AB');
  assert.equal(early.item.status, 'completed');
  assert.equal(res.writableEnded, undefined);
  stream.writeFrame({ type: 'act_resp', data: { actions: [{ id: 'read', status: 'COMPLETED' }] } });
  stream.writeFrame({ type: 'task_output', data: { reasoning_content: 'C' } });
  stream.writeFrame({ type: 'task_output', data: { content_type: 'answer', content: 'ANSWER' } });
  stream.writeFrame({ type: 'task_status', data: { status: 'COMPLETED' } });
  const final = stream.finish();
  assert.deepEqual(
    final.output.filter((item) => item.type === 'reasoning').map((item) => item.summary[0].text),
    ['AB', 'C']
  );
  assertLifecycle(res.events(), final);
});

test('unfinished reasoning segment stays incomplete while earlier segments remain closed', () => {
  for (const status of ['FAILED', 'missing']) {
    const res = sink();
    const stream = createTianxiResponsesStream(res, {}, 'super', {
      responseId: 'resp_segment_failed',
      nativeProgressMessages: true,
      nativeReasoningSegments: true,
    });
    stream.writeFrame({ type: 'task_output', data: { reasoning_content: 'Before' } });
    stream.writeFrame({
      type: 'act_exec',
      data: { exec_mode: 'native', actions: [{ id: 'read', name: 'Read' }] },
    });
    stream.writeFrame({ type: 'task_output', data: { reasoning_content: 'After' } });
    if (status === 'FAILED') stream.writeFrame({ type: 'task_status', data: { status } });
    const final = stream.finish();
    assert.deepEqual(
      final.output.filter((item) => item.type === 'reasoning').map((item) => item.status),
      ['completed', 'incomplete']
    );
    assertLifecycle(res.events(), final);
  }
});
