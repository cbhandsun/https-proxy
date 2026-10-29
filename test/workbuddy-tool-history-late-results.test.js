'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeWorkBuddyToolHistory: normalize,
  workBuddyToolHistoryError,
} = require('../lib/proxy/workbuddy-tool-history');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const call = (...ids) => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => ({
    id,
    type: 'function',
    function: { name: 'synthetic', arguments: '{}' },
  })),
});
const result = (id, content = 'synthetic', extra = {}) => ({
  role: 'tool',
  tool_call_id: id,
  content,
  ...extra,
});
const progress = (content) => ({ role: 'assistant', content });
const rejects = (messages, reason, options) =>
  assert.throws(
    () => normalize(messages, options),
    (error) => error.reason === reason
  );
const parts = (message) =>
  Array.isArray(message.content) ? message.content : [{ text: message.content }];

test('reported late supplemental output across a subsequent complete call remains paired and causally qualified', () => {
  const messages = [
    call('a'),
    result('a', 'first failure', { is_error: true }),
    call('b'),
    result('b', 'b result'),
    result('a', 'later success'),
  ];
  const original = JSON.stringify(messages);
  const repaired = normalize(messages);
  assert.equal(repaired.changed, true);
  assert.deepEqual(
    repaired.messages.map((m) => m.role),
    ['assistant', 'tool', 'assistant', 'tool']
  );
  assert.equal(repaired.messages[2], messages[2]);
  assert.equal(repaired.messages[3], messages[3]);
  assert.equal(repaired.messages[1].is_error, true);
  const text = JSON.stringify(repaired.messages[1].content);
  assert.match(text, /first failure/);
  assert.match(text, /later success/);
  assert.match(text, /not evidence of event order or success/);
  assert.match(
    text,
    /Do not infer that subsequent calls or assistant messages observed outputs recorded later/
  );
  assert.match(text, /original message index 1/);
  assert.match(text, /original message index 4/);
  assert.equal(repaired.diagnostics.combinedCalls, 1);
  assert.equal(repaired.diagnostics.combinedResults, 1);
  assert.equal(repaired.diagnostics.lateResultsAcrossCallBatches, 1);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(normalize(repaired.messages).changed, false);
  assert.equal(normalize(repaired.messages, { repair: false }).changed, false);
  rejects(messages, 'orphan_result', { repair: false });
});

test('several complete batches retain every distinct late record and exact subsequent call order', () => {
  const a = call('a'),
    b = call('b'),
    c = call('c');
  const repaired = normalize([
    a,
    result('a', 'a1'),
    b,
    result('b', 'b1'),
    result('a', 'a2'),
    c,
    result('c', 'c1'),
    result('b', 'b2'),
    result('a', 'a3'),
  ]);
  assert.deepEqual(
    repaired.messages.filter((m) => m.tool_calls),
    [a, b, c]
  );
  assert.equal(repaired.diagnostics.lateResultsAcrossCallBatches, 3);
  assert.equal(repaired.diagnostics.combinedCalls, 2);
  const text = JSON.stringify(repaired.messages[1].content);
  for (const value of ['a1', 'a2', 'a3']) assert.ok(text.includes(value));
  assert.match(text, /original message indices 2 through 5/);
  normalize(repaired.messages, { repair: false });
});

test('identical late outputs are deduplicated without falsely claiming original chronology', () => {
  const repaired = normalize([
    call('a'),
    result('a', 'same'),
    call('b'),
    result('a', 'same'),
    result('b'),
  ]);
  assert.equal(repaired.diagnostics.deduplicatedResults, 1);
  assert.equal(repaired.diagnostics.combinedCalls, 0);
  assert.equal(repaired.diagnostics.lateResultsAcrossCallBatches, 1);
  assert.equal(parts(repaired.messages[1]).filter((part) => part.text === 'same').length, 1);
  assert.match(parts(repaired.messages[1])[0].text, /not evidence of event order/);
  normalize(repaired.messages, { repair: false });
});

test('parallel old and new batches only combine records for their uniquely recorded call', () => {
  const repaired = normalize([
    call('a', 'b'),
    result('b', 'b1'),
    result('a', 'a1'),
    call('c', 'd'),
    result('a', 'a2'),
    result('d', 'd1'),
    result('b', 'b2'),
    result('c', 'c1'),
  ]);
  assert.deepEqual(
    repaired.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    ['b', 'a', 'd', 'c']
  );
  assert.equal(repaired.diagnostics.combinedCalls, 2);
  normalize(repaired.messages, { repair: false });
});

test('old and current progress keep their exact content, role and relative order', () => {
  const p1 = progress('old first'),
    p2 = progress('old second'),
    p3 = progress('current first'),
    p4 = progress('current second');
  const repaired = normalize([
    call('a'),
    p1,
    result('a', 'a1'),
    p2,
    call('b'),
    p3,
    result('a', 'a2'),
    result('b'),
    p4,
  ]);
  assert.deepEqual(
    repaired.messages.filter((m) => m.role === 'assistant' && !m.tool_calls),
    [p1, p2, p3, p4]
  );
  assert.match(
    JSON.stringify(repaired.messages[1].content),
    /original message indices 1 through 1/
  );
  assert.match(JSON.stringify(repaired.messages[1].content), /subsequent tool-call batches/);
  normalize(repaired.messages, { repair: false });
});

test('user, system, developer and explicit empty batches revoke late-result repair', () => {
  for (const boundary of [
    ...['user', 'system', 'developer'].map((role) => ({ role, content: 'boundary' })),
    { role: 'assistant', tool_calls: [], content: null },
  ]) {
    const messages = [call('a'), result('a'), call('b'), result('b'), boundary, result('a')];
    rejects(messages, 'orphan_result');
    try {
      normalize(messages);
    } catch (error) {
      const diagnostics = workBuddyToolHistoryError(error).diagnostics;
      assert.equal(diagnostics.boundaryMessageIndex, 4);
      assert.equal(
        diagnostics.boundaryType,
        boundary.role === 'assistant' ? 'empty_call_batch' : boundary.role
      );
    }
  }
});

test('a previously incomplete batch cannot borrow later outputs and current pending calls still fail', () => {
  rejects([call('a'), call('b'), result('a'), result('b')], 'missing_result');
  rejects([call('a', 'b'), result('a'), call('c'), result('b'), result('c')], 'missing_result');
  rejects([call('a'), result('a'), call('b'), result('a', 'late')], 'missing_result');
  rejects([call('a'), result('a'), call('b'), result('unknown'), result('b')], 'orphan_result');
  rejects([call('a'), result('a'), call('a'), result('a')], 'duplicate_call');
});

test('null, empty, media and conflicting error status remain exact recorded evidence', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } };
  for (const content of [null, '', [], [image]]) {
    const repaired = normalize([
      call('a'),
      result('a', content),
      call('b'),
      result('b'),
      result('a', 'failure', { status: 'error' }),
    ]);
    assert.equal(repaired.messages[1].is_error, true);
    assert.equal(repaired.messages[1].status, undefined);
    assert.ok(parts(repaired.messages[1]).some((part) => part.text === 'failure'));
    if (content === null) assert.match(JSON.stringify(repaired.messages[1]), /null content/);
    if (Array.isArray(content) && content.length)
      assert.ok(parts(repaired.messages[1]).includes(image));
    normalize(repaired.messages, { repair: false });
  }
});

test('late records share the existing per-call limit across every intervening batch', () => {
  const make = (count) => [
    call('a'),
    result('a'),
    ...Array.from({ length: count - 1 }, (_, i) => [
      call(`b${i}`),
      result(`b${i}`),
      result('a'),
    ]).flat(),
  ];
  const repaired = normalize(make(64));
  assert.equal(repaired.diagnostics.deduplicatedResults, 63);
  assert.equal(repaired.diagnostics.lateResultsAcrossCallBatches, 63);
  normalize(repaired.messages, { repair: false });
  rejects(make(65), 'result_limit');
});

test('malformed late content, unsafe hooks and traversal/byte exhaustion cannot bypass validation', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      invoked = true;
      return 'SECRET';
    },
  });
  const hook = {
    toJSON() {
      invoked = true;
      return 'SECRET';
    },
  };
  const cyclic = {};
  cyclic.child = cyclic;
  for (const content of [42, {}, undefined, [getter], [hook], [cyclic]])
    rejects(
      [call('a'), result('a'), call('b'), result('b'), { ...result('a'), content }],
      'invalid_shape'
    );
  assert.equal(invoked, false);
  rejects(
    [call('a'), result('a'), call('b'), result('b'), result('a', Array(262145).fill(null))],
    'invalid_shape'
  );
  const large = 'x'.repeat(33 * 1024 * 1024);
  rejects(
    [call('a'), result('a', large), call('b'), result('b'), result('a', large)],
    'invalid_shape'
  );
});

test('late repair composes with conversion and forced compaction without relaxing final admission', () => {
  const protocol = createOpenAIProtocol({
    fallbackId: (prefix) => `${prefix}_fixture`,
    cleanToolArgs: (_name, args) => args,
    stableCreated: () => 1,
    protocolOptions: { contextWindowPolicy: 'disabled' },
  });
  const input = [{ role: 'user', content: 'synthetic task' }];
  for (let i = 0; i < 12; i++)
    input.push(
      { type: 'function_call', name: 'synthetic', call_id: `old${i}`, arguments: '{}' },
      { type: 'function_call_output', call_id: `old${i}`, output: 'synthetic'.repeat(200) }
    );
  input.push(
    { type: 'custom_tool_call', name: 'synthetic', call_id: 'a', input: 'synthetic' },
    { type: 'custom_tool_call_output', call_id: 'a', output: 'SECRET_FIRST_ERROR', is_error: true },
    { type: 'custom_tool_call', name: 'synthetic', call_id: 'b', input: 'synthetic' },
    { type: 'custom_tool_call_output', call_id: 'b', output: 'SECRET_B_RESULT' },
    { type: 'custom_tool_call_output', call_id: 'a', output: 'SECRET_LATE_RESULT' }
  );
  const chat = protocol.openAIResponsesToChat({ input, model: 'deepseek-v4.1-flash' });
  const repaired = normalize(chat.messages);
  const plan = planWorkBuddyWbipcRequest(
    { ...chat, messages: repaired.messages },
    { force: true, targetBodyBytes: 8192 }
  );
  assert.equal(plan.fits, true);
  assert.ok(plan.diagnostics.evictedToolRounds > 0);
  normalize(plan.body.messages, { repair: false });
  const outputs = plan.body.messages.filter((m) => m.tool_call_id === 'a');
  assert.equal(outputs.length, 1);
  const text = JSON.stringify(outputs[0].content);
  assert.match(text, /SECRET_FIRST_ERROR/);
  assert.match(text, /SECRET_LATE_RESULT/);
  assert.match(text, /Do not infer that subsequent calls/);
});
