'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createTianxiResponsesStream,
  buildTianxiResponsesResponse,
} = require('../lib/proxy/tianxi-responses');

function responseSink() {
  let buffer = '';
  return {
    ended: false,
    writeHead() {
      this.headersSent = true;
    },
    write(chunk) {
      buffer += String(chunk);
    },
    end() {
      this.ended = true;
    },
    events() {
      return buffer
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
    },
    text() {
      return buffer;
    },
  };
}

const deps = { nativeProgressItems: true, responseId: 'resp_progress', createdAt: 123 };
const messageDeps = { ...deps, nativeProgressMessages: true };
const working = { type: 'task_status', data: { status: 'WORKING' } };
const started = {
  type: 'act_exec',
  data: {
    exec_mode: 'cli',
    actions: [{ id: 'read_a', name: 'Read', parameters: { path: 'SECRET path' } }],
  },
};
const returned = {
  type: 'act_resp',
  data: { actions: [{ id: 'read_a', result: 'SECRET result' }] },
};

test('Intermediate native returns stay pending until terminal results, with ordered JSON/SSE parity', () => {
  for (const intermediate of ['RUNNING', 'IN_PROGRESS', 'UNKNOWN', { secret: 'SECRET' }]) {
    const options = { ...messageDeps, nativeProgressDetails: true, nativeReasoningSegments: true };
    const res = responseSink();
    const stream = createTianxiResponsesStream(res, {}, 'super', options);
    const frames = [
      working,
      started,
      {
        type: 'act_resp',
        data: { actions: [{ id: 'read_a', status: intermediate, result: 'SECRET' }] },
      },
    ];
    for (const frame of frames) stream.writeFrame(frame);
    assert.equal(
      res.events().filter((event) => event.type === 'response.output_item.done').length,
      2
    );
    const unfinished = buildTianxiResponsesResponse(
      {},
      [
        ...frames,
        { type: 'task_output', data: { final: 'Answer.' } },
        { type: 'task_status', data: { status: 'COMPLETED' } },
      ],
      'super',
      options
    );
    assert.equal(unfinished.status, 'incomplete');
    assert.equal(unfinished.incomplete_details.reason, 'tianxi_native_tools_pending');
    for (const frame of [
      returned,
      returned,
      { type: 'task_output', data: { final: 'Answer.' } },
      { type: 'task_status', data: { status: 'COMPLETED' } },
    ]) {
      frames.push(frame);
      stream.writeFrame(frame);
    }
    const final = stream.finish();
    assert.equal(final.status, 'completed');
    assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', options));
    assert.equal(final.output.filter((item) => item.phase === 'commentary').length, 3);
    assert.equal(final.output.at(-1).phase, 'final_answer');
    for (const [index, event] of res.events().entries()) {
      assert.equal(event.sequence_number, index);
      if (event.type === 'response.output_item.done')
        assert.deepEqual(event.item, final.output[event.output_index]);
    }
    assert.ok(!res.text().includes('SECRET'));
    assert.ok(!res.events().some((event) => event.item?.type === 'function_call'));
  }
});

test('Native cancellation aliases never display successful completion', () => {
  for (const status of ['CANCELED', 'CANCELLED', 'ABORTED']) {
    const frames = [
      started,
      {
        type: 'act_resp',
        data: {
          actions: [{ id: 'read_a', status, success: false, result: 'SECRET' }],
        },
      },
      { type: 'task_output', data: { final: 'Partial answer.' } },
      { type: 'task_status', data: { status: 'COMPLETED' } },
    ];
    const options = { ...messageDeps, nativeProgressDetails: true };
    const res = responseSink();
    const stream = createTianxiResponsesStream(res, {}, 'super', options);
    frames.forEach((frame) => stream.writeFrame(frame));
    const final = stream.finish();
    assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', options));
    assert.match(final.output[1].content[0].text, /\u5df2\u53d6\u6d88/);
    assert.doesNotMatch(final.output[1].content[0].text, /\u5df2\u5b8c\u6210/);
    assert.ok(!res.text().includes('SECRET'));
  }
});

test('Native progress items complete during the request and preserve final IDs/content', () => {
  const res = responseSink();
  const stream = createTianxiResponsesStream(res, {}, 'super', deps);
  const frames = [
    working,
    working,
    started,
    { type: 'task_output', data: { reasoning_content: 'Provider summary A.' } },
    returned,
    { type: 'task_output', data: { reasoning_content: ' Summary B.' } },
  ];
  for (const frame of frames) stream.writeFrame(frame);
  const early = res.events().filter((event) => event.type === 'response.output_item.done');
  assert.equal(early.length, 3);
  assert.equal(new Set(early.map((event) => event.item.id)).size, 3);
  assert.ok(
    early.every((event) => event.item.type === 'reasoning' && event.item.status === 'completed')
  );
  assert.equal(res.ended, false);
  assert.ok(!res.events().some((event) => event.type === 'response.completed'));
  frames.push(
    { type: 'task_output', data: { final: 'Final answer.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } }
  );
  const final = stream.finish(frames);
  assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', deps));
  const providerSummary = final.output.find((item) => item.id === 'rsn_resp_progress');
  assert.equal(providerSummary.summary[0].text, 'Provider summary A. Summary B.');
  const events = res.events();
  for (const [index, event] of events.entries()) assert.equal(event.sequence_number, index);
  const done = events.filter((event) => event.type === 'response.output_item.done');
  assert.equal(new Set(done.map((event) => event.item.id)).size, done.length);
  for (const event of done) assert.deepEqual(event.item, final.output[event.output_index]);
  for (const event of events) {
    if (event.item_id) assert.equal(event.item_id, final.output[event.output_index].id);
    if (event.type === 'response.reasoning_summary_text.done') {
      assert.equal(event.text, final.output[event.output_index].summary[0].text);
    }
  }
  assert.ok(!res.text().includes('SECRET'));
  assert.ok(!res.text().includes('"type":"function_call"'));
  assert.equal(final.output_text, 'Final answer.');
});

test('Provider-first summaries, bounded tool batches and permission progress retain event parity', () => {
  const res = responseSink();
  const stream = createTianxiResponsesStream(res, {}, 'super', deps);
  const actions = Array.from({ length: 129 }, (_, index) => ({
    id: `batch_${index}`,
    name: index === 0 ? 'sat_SECRET' : 'Read',
    parameters: { path: 'SECRET path' },
  }));
  const frames = [
    { type: 'task_output', data: { reasoning_content: 'Provider first.' } },
    working,
    { type: 'act_exec', data: { exec_mode: 'cli', actions } },
    { type: 'risk_exec', data: { id: 'permission', parameters: { token: 'SECRET' } } },
    {
      type: 'act_resp',
      data: {
        actions: actions.map((action, index) => ({
          id: action.id,
          status: index === 0 ? 'FAILED' : 'CANCELED',
          result: 'SECRET output',
        })),
      },
    },
    { type: 'act_resp', data: { actions: [{ id: 'batch_0', result: 'SECRET duplicate' }] } },
    { type: 'task_output', data: { reasoning_content: ' Provider last.' } },
    { type: 'task_output', data: { final: 'Answer.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ];
  for (const frame of frames) stream.writeFrame(frame);
  const early = res.events().filter((event) => event.type === 'response.output_item.done');
  assert.equal(early.length, 4);
  assert.equal(early[1].item.summary[0].text.match(/started/g).length, 128);
  assert.match(early[2].item.summary[0].text, /awaiting permission/);
  assert.match(early[3].item.summary[0].text, /failed/);
  assert.equal(early[3].item.summary[0].text.match(/canceled/g).length, 127);
  assert.ok(!res.text().includes('SECRET'));
  assert.ok(!res.events().some((event) => event.item?.type === 'function_call'));
  const final = stream.finish();
  assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', deps));
  assert.equal(final.output[0].summary[0].text, 'Provider first. Provider last.');
  assert.equal(final.output_text, 'Answer.');
  for (const event of res.events().filter((event) => event.type === 'response.output_item.done')) {
    assert.deepEqual(event.item, final.output[event.output_index]);
  }
});

test('Completed progress steps do not complete a failed or interrupted task', () => {
  for (const [modeDeps, outcome] of [deps, messageDeps].flatMap((mode) =>
    ['FAILED', 'CANCELED', 'interrupted'].map((outcome) => [mode, outcome])
  )) {
    const res = responseSink();
    const stream = createTianxiResponsesStream(res, {}, 'super', modeDeps);
    const frames = [working, started];
    for (const frame of frames) stream.writeFrame(frame);
    if (outcome !== 'interrupted') frames.push({ type: 'task_status', data: { status: outcome } });
    const final = stream.finish(frames, { interrupted: outcome === 'interrupted' });
    assert.equal(final.status, outcome === 'interrupted' ? 'incomplete' : 'failed');
    assert.ok(final.output.every((item) => item.status === 'completed'));
    assert.ok(!res.events().some((event) => event.type === 'response.completed'));
    for (const event of res
      .events()
      .filter((event) => event.type === 'response.output_item.done')) {
      assert.deepEqual(event.item, final.output[event.output_index]);
    }
  }
});

test('Commentary messages accumulate separately from model reasoning and the final answer', () => {
  const res = responseSink();
  const stream = createTianxiResponsesStream(res, {}, 'super', messageDeps);
  const frames = [
    { type: 'task_output', data: { reasoning_content: 'Provider reasoning.' } },
    working,
    working,
    started,
    returned,
  ];
  for (const frame of frames) stream.writeFrame(frame);
  const early = res.events().filter((event) => event.type === 'response.output_item.done');
  assert.equal(early.length, 2);
  assert.equal(new Set(early.map((event) => event.item.id)).size, 2);
  assert.ok(
    early.every((event) => event.item.type === 'message' && event.item.phase === 'commentary')
  );
  assert.equal(res.ended, false);
  frames.push(
    { type: 'task_output', data: { final: 'Answer.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } }
  );
  const final = stream.finish(frames);
  assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', messageDeps));
  assert.equal(final.output_text, 'Answer.');
  assert.equal(final.output[0].type, 'reasoning');
  assert.equal(final.output.at(-1).phase, 'final_answer');
  assert.equal(final.output.at(-1).content[0].text, 'Answer.');
  assert.ok(!res.text().includes('SECRET'));
  const events = res.events();
  for (const [index, event] of events.entries()) {
    assert.equal(event.sequence_number, index);
    if (event.item_id) assert.equal(event.item_id, final.output[event.output_index].id);
    if (event.type === 'response.output_item.done') {
      assert.deepEqual(event.item, final.output[event.output_index]);
    }
    if (event.type === 'response.output_text.done') {
      assert.equal(event.text, final.output[event.output_index].content[0].text);
      assert.deepEqual(event.logprobs, []);
    }
  }
});

test('Public narration survives successful return suppression without becoming final output', () => {
  const res = responseSink();
  const stream = createTianxiResponsesStream(res, {}, 'super', messageDeps);
  const frames = [
    working,
    { type: 'task_output', data: { content_type: 'text', content: 'Inspecting files.' } },
    started,
    { type: 'task_output', data: { content_type: 'text', content: 'Checking the next step.' } },
    returned,
    returned,
  ];
  for (const frame of frames) stream.writeFrame(frame);
  const early = res.events().filter((event) => event.type === 'response.output_item.done');
  assert.equal(early.length, 4);
  assert.equal(early[1].item.content[0].text, 'Inspecting files.');
  assert.equal(early[3].item.content[0].text, 'Checking the next step.');
  assert.ok(early.every((event) => event.item.phase === 'commentary'));
  assert.ok(!res.text().includes('returned'));
  assert.ok(!res.text().includes('SECRET'));
  frames.push(
    { type: 'task_output', data: { final: 'Answer.' } },
    { type: 'task_status', data: { status: 'COMPLETED' } }
  );
  const final = stream.finish(frames);
  assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', messageDeps));
  assert.equal(final.output_text, 'Answer.');
  assert.equal(final.output.at(-1).content[0].text, 'Answer.');
  for (const event of res.events().filter((event) => event.type === 'response.output_item.done')) {
    assert.deepEqual(event.item, final.output[event.output_index]);
  }
});

test('Compact progress retains failed, canceled and permission steps without leaking results', () => {
  const res = responseSink();
  const stream = createTianxiResponsesStream(res, {}, 'super', messageDeps);
  const frames = [
    {
      type: 'act_exec',
      data: {
        exec_mode: 'cli',
        actions: [
          { id: 'a', name: 'Grep' },
          { id: 'b', name: 'Glob' },
        ],
      },
    },
    { type: 'risk_exec', data: { parameters: { token: 'SECRET permission' } } },
    {
      type: 'act_resp',
      data: {
        actions: [
          { id: 'a', status: 'FAILED', result: 'SECRET result' },
          { id: 'b', status: 'CANCELED', error_detail: 'SECRET error' },
        ],
      },
    },
    { type: 'task_output', data: { final: 'Partial answer.' } },
    { type: 'task_status', data: { status: 'FAILED' } },
  ];
  for (const frame of frames) stream.writeFrame(frame);
  const final = stream.finish();
  assert.equal(final.status, 'failed');
  assert.equal(final.output.at(-1).status, 'incomplete');
  assert.ok(final.output.slice(0, -1).every((item) => item.status === 'completed'));
  assert.match(final.output[2].content[0].text, /\u5931\u8d25/);
  assert.match(final.output[2].content[0].text, /\u5df2\u53d6\u6d88/);
  assert.match(final.output[1].content[0].text, /\u6388\u6743/);
  assert.ok(!res.text().includes('SECRET'));
  assert.ok(!res.events().some((event) => event.item?.type === 'function_call'));
  assert.deepEqual(final, buildTianxiResponsesResponse({}, frames, 'super', messageDeps));
});

test('Empty/invalid frames cannot invent progress; disconnect stops emission', () => {
  const res = responseSink();
  const stream = createTianxiResponsesStream(res, {}, 'super', deps);
  for (const frame of [
    null,
    {},
    { type: 'task_output', data: { reasoning_content: '' } },
    { type: 'act_resp', data: { actions: [] } },
  ])
    stream.writeFrame(frame);
  assert.equal(
    res.events().filter((event) => event.type === 'response.output_item.done').length,
    0
  );
  res.destroyed = true;
  stream.writeFrame(working);
  assert.equal(stream.finish(), null);
  assert.equal(
    res.events().filter((event) => event.type === 'response.output_item.done').length,
    0
  );
});
