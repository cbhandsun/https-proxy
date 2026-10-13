'use strict';

const assert = require('node:assert/strict');
const {
  createWorkBuddyMixedToolPhase,
  MAX_MIXED_TOOL_CALLS,
  MAX_EXTERNAL_ARGUMENT_BYTES,
} = require('../lib/proxy/workbuddy-mixed-tool-phase');
const {
  CONTEXT_ARTIFACT_TOOL_NAME,
  parseBufferedChatCompletion,
  contextArtifactToolDefinition,
} = require('../lib/proxy/context-artifact-tool');

const maxBytes = 16 * 1024 * 1024;
const call = (id, name = CONTEXT_ARTIFACT_TOOL_NAME, args = '{}') => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const internal = call('internal');
const external1 = call('external1', 'write', '{ "path": "a", "text": "汉🙂" }');
const external2 = call('external2', 'read');
const body = (stream = false) => ({
  messages: [{ role: 'user', content: 'do not change my requirements' }],
  stream,
  tools: [
    contextArtifactToolDefinition(),
    ...['read', 'write'].map((name) => ({
      type: 'function',
      function: { name, parameters: { type: 'object' } },
    })),
  ],
});
const completion = (calls = [external1, internal, external2], finish = 'tool_calls') => ({
  id: 'chat_original',
  model: 'fixture',
  created: 1,
  usage: { total_tokens: 7 },
  choices: [
    {
      index: 0,
      finish_reason: finish,
      message: {
        role: 'assistant',
        content: 'Original assistant text',
        reasoning_content: 'Original assistant reasoning',
        ...(calls ? { tool_calls: calls } : {}),
      },
    },
  ],
});
const wire = (payload, stream) =>
  stream
    ? 'data: ' +
      JSON.stringify({
        ...payload,
        object: 'chat.completion.chunk',
        choices: payload.choices.map(({ message, ...choice }) => ({
          ...choice,
          delta: {
            ...message,
            ...(message.tool_calls
              ? { tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) }
              : {}),
          },
        })),
      }) +
      '\n\ndata: [DONE]\n\n'
    : JSON.stringify(payload);

for (const stream of [false, true]) {
  const sent = body(stream);
  const compacted = {
    ...sent,
    tools: [contextArtifactToolDefinition()],
    messages: [{ role: 'user', content: 'compacted history' }],
  };
  const phase = createWorkBuddyMixedToolPhase();
  const recovered = phase.prepare(wire(completion(), stream), compacted, maxBytes, undefined, sent);
  assert.equal(
    recovered.ok,
    true,
    'Original offered external tools remain valid after background compaction'
  );
  const released = phase.prepare(wire(completion(null, 'stop'), stream), recovered.body, maxBytes);
  assert.deepEqual(released.body.tools, sent.tools);
  assert.deepEqual(released.body.messages, compacted.messages);
  const invented = {
    ...compacted,
    tools: [...compacted.tools, { type: 'function', function: { name: 'new_tool' } }],
  };
  assert.equal(
    createWorkBuddyMixedToolPhase().prepare(
      wire(completion([internal, call('new', 'new_tool')]), stream),
      invented,
      maxBytes,
      undefined,
      sent
    ).ok,
    false,
    'Candidate tools never authorize an earlier response'
  );
}

for (const stream of [false, true]) {
  const phase = createWorkBuddyMixedToolPhase();
  const originalBody = body(stream);
  const original = wire(completion(), stream);
  const before = JSON.stringify(originalBody);
  const first = phase.prepare(original, originalBody, maxBytes);
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'recover');
  assert.equal(phase.hasDeferredCalls(), true);
  assert.equal(JSON.stringify(originalBody), before);
  assert.equal(first.body.tool_choice, 'auto');
  assert.deepEqual(first.body.tools, [contextArtifactToolDefinition()]);
  const privateCompletion = parseBufferedChatCompletion(first.responseBody, stream, maxBytes);
  assert.deepEqual(privateCompletion.choices[0].message.tool_calls, [internal]);
  assert.equal(privateCompletion.choices[0].message.content, null);
  assert.equal(privateCompletion.choices[0].message.reasoning_content, undefined);
  const withHistory = {
    ...first.body,
    messages: [
      ...first.body.messages,
      privateCompletion.choices[0].message,
      { role: 'tool', tool_call_id: internal.id, content: 'page' },
    ],
  };
  const second = phase.prepare(wire(completion([call('another')]), stream), withHistory, maxBytes);
  assert.equal(second.mode, 'recover');
  const ack = wire(completion(null, 'stop'), stream);
  const released = phase.prepare(ack, second.body, maxBytes);
  assert.equal(released.mode, 'release');
  assert.equal(phase.hasDeferredCalls(), false);
  assert.deepEqual(released.body.tools, originalBody.tools);
  assert.equal(Object.hasOwn(released.body, 'tool_choice'), false);
  assert.deepEqual(released.body.messages, withHistory.messages.slice(1));
  assert.ok(
    !released.body.messages.some((item) =>
      item.content?.includes('internal context-evidence recovery phase')
    )
  );
  const output = parseBufferedChatCompletion(released.responseBody, stream, maxBytes);
  assert.deepEqual(output.choices[0].message.tool_calls, [external1, external2]);
  assert.equal(output.choices[0].message.content, 'Original assistant text');
  assert.equal(output.choices[0].message.reasoning_content, 'Original assistant reasoning');
  assert.deepEqual(output.usage, { total_tokens: 7 });
  assert.deepEqual(phase.prepare(ack, released.body, maxBytes), { matched: false });
}

for (const payload of [completion(null, 'stop'), completion([external1]), completion([internal])]) {
  assert.deepEqual(
    createWorkBuddyMixedToolPhase().prepare(JSON.stringify(payload), body(), maxBytes),
    { matched: false }
  );
}
for (const calls of [
  [internal, call('internal', 'read')],
  [internal, call('', 'read')],
  [internal, call('bad\nID', 'read')],
  [internal, call('x'.repeat(257), 'read')],
  [internal, call('unknown', 'not_offered')],
  [internal, call('badArgs', 'read', '{bad')],
  [internal, call('badArgs', 'read', 'null')],
  [internal, call('badArgs', 'read', '[]')],
  [internal, call('bigArgs', 'read', 'x'.repeat(MAX_EXTERNAL_ARGUMENT_BYTES + 1))],
  [internal, { id: 'badType', type: 'custom', function: { name: 'read', arguments: '{}' } }],
  [
    internal,
    ...Array.from({ length: MAX_MIXED_TOOL_CALLS }, (_, index) => call('ext' + index, 'read')),
  ],
  [...Array.from({ length: 9 }, (_, index) => call('int' + index)), external1],
]) {
  const rejected = createWorkBuddyMixedToolPhase().prepare(
    JSON.stringify(completion(calls)),
    body(),
    maxBytes
  );
  assert.equal(rejected.ok, false);
}
for (const invalidBody of [
  { ...body(), tool_choice: 'none' },
  { ...body(), tool_choice: { type: 'function', function: { name: 'read' } } },
  { ...body(), messages: [{ role: 'assistant', tool_calls: [external1] }] },
  { ...body(), messages: [{ role: 'tool', tool_call_id: external1.id, content: 'old result' }] },
])
  assert.equal(
    createWorkBuddyMixedToolPhase().prepare(JSON.stringify(completion()), invalidBody, maxBytes).ok,
    false
  );
for (const mutate of [
  (value) => {
    value.choices.push(value.choices[0]);
  },
  (value) => {
    value.choices[0].finish_reason = 'length';
  },
  (value) => {
    value.choices[0].message.role = 'user';
  },
  (value) => {
    value.choices[0].message.refusal = 'refused';
  },
  (value) => {
    value.choices[0].message.function_call = { name: 'read' };
  },
  (value) => {
    value.choices[0].message.content = {};
  },
  (value) => {
    value.choices[0].message.reasoning_content = {};
  },
]) {
  const value = completion();
  mutate(value);
  assert.equal(
    createWorkBuddyMixedToolPhase().prepare(JSON.stringify(value), body(), maxBytes).ok,
    false
  );
}
for (const badAck of [
  '',
  'null',
  '{}',
  '{bad',
  JSON.stringify(completion(null, 'length')),
  JSON.stringify(completion([external1])),
  JSON.stringify(completion([call('external1')])),
  JSON.stringify(completion(null, null)),
  'data: {"choices":[{"index":0,"delta":{"content":"unfinished"}}]}\n\n',
]) {
  const phase = createWorkBuddyMixedToolPhase();
  const start = phase.prepare(JSON.stringify(completion()), body(), maxBytes);
  assert.equal(phase.prepare(badAck, start.body, maxBytes).ok, false);
  assert.equal(phase.hasDeferredCalls(), true);
}
const forced = { ...body(), tool_choice: { type: 'function', function: { name: 'read' } } };
const forcedPhase = createWorkBuddyMixedToolPhase();
const forcedStart = forcedPhase.prepare(
  JSON.stringify(completion([internal, external2])),
  forced,
  maxBytes
);
assert.equal(forcedStart.ok, true);
const forcedEnd = forcedPhase.prepare(
  JSON.stringify(completion(null, 'stop')),
  forcedStart.body,
  maxBytes
);
assert.deepEqual(forcedEnd.body.tool_choice, forced.tool_choice);
const oversizedPhase = createWorkBuddyMixedToolPhase();
const oversizedStart = oversizedPhase.prepare(JSON.stringify(completion()), body(), maxBytes);
assert.equal(
  oversizedPhase.prepare(JSON.stringify(completion(null, 'stop')), oversizedStart.body, 1).ok,
  false
);
assert.equal({}.polluted, undefined);
console.log('[workbuddy-mixed-tool-phase.test] ok');
