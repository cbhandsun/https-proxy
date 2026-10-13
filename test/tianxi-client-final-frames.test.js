'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { clientFinalFrames } = require('../lib/proxy/tianxi-client-final-frames');
const { buildTianxiResponsesResponse } = require('../lib/proxy/tianxi-responses');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const path = require('node:path');
const text = (content, content_type = 'text') => ({
  type: 'task_output',
  data: { content_type, content },
});
const tool = (id, type = 'act_exec', server = 'codex_readonly') => ({
  type,
  data: {
    exec_mode: 'local',
    actions: [{ id, name: 'read_file', mcpServerName: server, parameters: {} }],
  },
});
const done = { type: 'task_status', data: { status: 'COMPLETED' } };
const finalText = (frames) =>
  buildTianxiResponsesResponse({}, frames, 'tianxi/super')
    .output.filter((item) => item.type === 'message' && item.phase !== 'commentary')
    .flatMap((item) => item.content)
    .map((part) => part.text || '')
    .join('');

test('completed client calls retain process/final boundaries without phantom calls or private output', () => {
  const frames = [
    text('check first'),
    tool('a'),
    tool('a', 'act_resp'),
    text('check second', 'markdown'),
    tool('b'),
    text('private fixture', 'thinking'),
    text('EXACT FINAL'),
    done,
  ];
  const snapshot = JSON.stringify(frames);
  const selected = clientFinalFrames(frames, new Set(['a', 'b']));
  assert.equal(finalText(selected), 'EXACT FINAL');
  assert.equal(JSON.stringify(frames), snapshot);
  assert.equal(selected[0].data.content_type, 'summary');
  const response = buildTianxiResponsesResponse({}, selected, 'tianxi/super');
  assert.ok(!response.output.some((item) => item.type === 'function_call'));
  assert.ok(!finalText(selected).includes('private fixture'));
});

test('explicit answers, post-tool final deltas and tasks without client starts are preserved', () => {
  const frames = [
    text('explicit prefix ', 'answer'),
    tool('a'),
    text('part one '),
    text('part two'),
    done,
  ];
  assert.equal(
    finalText(clientFinalFrames(frames, new Set(['a']))),
    'explicit prefix part one part two'
  );
  const noTools = [text('plain final'), done];
  assert.deepEqual(clientFinalFrames(noTools, new Set()), noTools);
  assert.equal(finalText(clientFinalFrames(noTools, new Set())), 'plain final');
  const responseOnly = [text('retain'), tool('a', 'act_resp'), done];
  assert.equal(finalText(clientFinalFrames(responseOnly, new Set(['a']))), 'retain');
});

test('mixed message/output markers before client tools cannot contaminate final answers', () => {
  for (const marker of ['message', 'assistant', 'output', 'text']) {
    const narration = {
      ...text('Observed first step; checking next.', marker),
      data: {
        ...text('Observed first step; checking next.', marker).data,
        content_schema: 'output',
        content_stage: 'text',
      },
    };
    assert.equal(
      finalText(clientFinalFrames([narration, tool('a'), text('EXACT'), done], new Set(['a']))),
      'EXACT'
    );
    narration.data.content_schema = 'native-schema';
    narration.data.content_stage = 'native-stage';
    assert.equal(
      finalText(clientFinalFrames([narration, tool('a'), text('EXACT'), done], new Set(['a']))),
      'EXACT'
    );
  }
  for (const [field, value] of [
    ['content_stage', 'final'],
    ['content_schema', 'result'],
    ['phase', 'final_answer'],
  ]) {
    const explicit = { ...text('explicit '), data: { ...text('explicit ').data, [field]: value } };
    assert.equal(
      finalText(clientFinalFrames([explicit, tool('a'), text('EXACT'), done], new Set(['a']))),
      'explicit EXACT'
    );
  }
  const markerless = { type: 'task_output', data: { content: 'process only' } };
  assert.equal(
    finalText(clientFinalFrames([markerless, tool('a'), text('EXACT'), done], new Set(['a']))),
    'EXACT'
  );
});

test('malformed and unreturned/mixed/native calls do not acquire completed-client semantics', () => {
  for (const invalid of [null, undefined, {}, 'invalid'])
    assert.deepEqual(clientFinalFrames(invalid, new Set()), []);
  assert.deepEqual(clientFinalFrames([], null), []);
  for (const frame of [
    null,
    {},
    tool('unreturned'),
    tool('a', 'act_exec', 'other'),
    { type: 'act_exec', data: { actions: [] } },
    { type: 'act_exec', data: { actions: [null] } },
    {
      type: 'act_exec',
      data: {
        actions: [tool('a').data.actions[0], tool('b', 'act_exec', 'other').data.actions[0]],
      },
    },
  ])
    assert.deepEqual(clientFinalFrames([text('retain'), frame], new Set(['a', 'b'])), [
      text('retain'),
      frame,
    ]);
  assert.deepEqual(clientFinalFrames([tool('a')], {}), [tool('a')]);
});

test('capacity-sized sequences retain order and are selected by unified CI', () => {
  const frames = Array.from({ length: 65532 }, (_, index) => text(String(index)));
  frames.push(tool('a'), text('last'), done);
  const result = clientFinalFrames(frames, new Set(['a']));
  assert.equal(result.length, frames.length - 1);
  assert.equal(result[0].data.content, '0');
  assert.equal(result.at(-2).data.content, 'last');
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(
      'test/tianxi-client-final-frames.test.js'
    )
  );
});
