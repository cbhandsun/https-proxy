'use strict';
const assert = require('node:assert/strict');
const {
  jsonObjectRequested,
  assertJsonObjectCompletion,
} = require('../lib/proxy/json-object-output-contract');
const request = { text: { format: { type: 'json_object' } } };
const chat = (text, finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content: text } }],
});
const responses = (text, status = 'completed') => ({
  status,
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});
function invalid(fn) {
  assert.throws(
    fn,
    (error) => error.code === 'upstream_invalid_json_object' && !error.message.includes('SECRET')
  );
}
assert.equal(jsonObjectRequested({}), false);
assert.equal(jsonObjectRequested({ responsesRequest: request }), true);
assert.equal(jsonObjectRequested({ response_format: { type: 'json_object' } }), true);
for (const kind of ['chat', 'responses']) {
  const create = kind === 'chat' ? chat : responses;
  for (const text of [
    '{}',
    '{"ok":true}',
    ' \n{"unicode":"测试"}\n ',
    '{"__proto__":{"test":true}}',
  ]) {
    const payload = create(text);
    const before = JSON.stringify(payload);
    assertJsonObjectCompletion(payload, kind, request);
    assert.equal(JSON.stringify(payload), before);
  }
  for (const text of ['', '   ', 'SECRET', 'null', '[]', '1', 'true', '"SECRET"', '{"a":'])
    invalid(() => assertJsonObjectCompletion(create(text), kind, request));
  assertJsonObjectCompletion(create('SECRET'), kind, {});
  invalid(() =>
    assertJsonObjectCompletion(create('{"ok":"测试"}'), kind, request, { maxBytes: 8 })
  );
  assert.throws(
    () => assertJsonObjectCompletion(create('{}'), kind, request, { maxBytes: Infinity }),
    /byte limit/
  );
}
assertJsonObjectCompletion(chat('{', 'length'), 'chat', request);
assertJsonObjectCompletion(chat('', 'content_filter'), 'chat', request);
assertJsonObjectCompletion(responses('{', 'incomplete'), 'responses', request);
assertJsonObjectCompletion(responses('', 'failed'), 'responses', request);
assertJsonObjectCompletion(
  { choices: [{ finish_reason: 'stop', message: { refusal: 'declined' } }] },
  'chat',
  request
);
assertJsonObjectCompletion(
  {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] }],
  },
  'responses',
  request
);
const tool = {
  id: 'call_1',
  type: 'function',
  function: { name: 'probe', arguments: '{"ok":true}' },
};
assertJsonObjectCompletion(
  { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [tool] } }] },
  'chat',
  request
);
const outputTool = {
  type: 'function_call',
  call_id: 'call_1',
  name: 'probe',
  arguments: '{"ok":true}',
};
assertJsonObjectCompletion({ status: 'completed', output: [outputTool] }, 'responses', request);
for (const argumentsValue of ['SECRET', '[1]', 'null']) {
  invalid(() =>
    assertJsonObjectCompletion(
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [{ ...tool, function: { ...tool.function, arguments: argumentsValue } }],
            },
          },
        ],
      },
      'chat',
      request
    )
  );
  invalid(() =>
    assertJsonObjectCompletion(
      { status: 'completed', output: [{ ...outputTool, arguments: argumentsValue }] },
      'responses',
      request
    )
  );
}
invalid(() =>
  assertJsonObjectCompletion(
    { status: 'completed', output: [{ ...outputTool, status: 'incomplete' }] },
    'responses',
    request
  )
);
invalid(() =>
  assertJsonObjectCompletion(
    { status: 'completed', output: [{ type: 'reasoning' }] },
    'responses',
    request
  )
);
for (const payload of [null, [], {}, { status: 'completed', output: [null] }])
  invalid(() => assertJsonObjectCompletion(payload, 'responses', request));
const customRequest = { ...request, tools: [{ type: 'custom', name: 'apply_patch' }] };
assertJsonObjectCompletion(
  {
    status: 'completed',
    output: [
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: 'patch text' },
    ],
  },
  'responses',
  customRequest
);
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { parseClaudeSseEvent } = require('../lib/proxy/sse');
const protocol = createOpenAIProtocol({
  fallbackId: (prefix) => prefix + '_fixture',
  stableCreated: () => 1,
  parseClaudeSseEvent,
  protocolOptions: {},
});
invalid(() => protocol.openAIChatToResponses(chat('   '), 'deepseek-v4-flash', request));
assert.equal(
  protocol.openAIChatToResponses(chat('{"ok":true}'), 'deepseek-v4-flash', request).status,
  'completed'
);
assert.equal(
  protocol.openAIChatToResponses(chat('{', 'length'), 'deepseek-v4-flash', request).status,
  'incomplete'
);
const refused = protocol.openAIChatToResponses(
  { choices: [{ finish_reason: 'stop', message: { refusal: 'declined' } }] },
  'deepseek-v4-flash',
  request
);
assert.deepEqual(refused.output[0].content, [{ type: 'refusal', refusal: 'declined' }]);
function streamResult(deltas, finishReason = 'stop', jsonObjectOutput = true) {
  const state = {
    id: 'resp_fixture',
    model: 'fixture',
    created_at: 1,
    outputIndex: 0,
    buffer: '',
    jsonObjectOutput,
    pendingToolCalls: [],
    toolCalls: [],
    completedOutputItems: [],
  };
  let wire = '';
  const res = {
    write: (chunk) => {
      wire += chunk;
    },
  };
  for (const delta of deltas) {
    protocol.processOpenAIChatSseChunkToResponses(
      res,
      'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n',
      state
    );
  }
  protocol.processOpenAIChatSseChunkToResponses(
    res,
    'data: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] }) +
      '\n\ndata: [DONE]\n\n',
    state
  );
  const before = wire;
  protocol.flushOpenAIChatSseToResponses(res, state);
  protocol.processOpenAIChatSseChunkToResponses(res, 'data: SECRET\n\n', state);
  assert.equal(wire, before, 'Terminal streams must suppress late output');
  const events = wire
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  return { state, wire, events };
}
for (const content of ['', '   ', 'SECRET', 'null', '[]', '{']) {
  const result = streamResult([{ content }]);
  assert.equal(result.state.failed, true);
  assert.equal(result.state.failure.code, 'upstream_invalid_json_object');
  assert.equal(result.events.filter((event) => event.type === 'response.failed').length, 1);
  assert.equal(
    result.events.some((event) => event.type === 'response.completed'),
    false
  );
  assert.equal(result.state.failure.message.includes('SECRET'), false);
}
for (const deltas of [
  [{ content: '{"ok":' }, { content: 'true}' }],
  [{ refusal: 'de' }, { refusal: 'clined' }],
]) {
  const result = streamResult(deltas);
  assert.equal(result.state.failed, undefined);
  assert.equal(result.events.filter((event) => event.type === 'response.completed').length, 1);
  if (deltas[0].refusal) {
    assert.deepEqual(result.state.completedOutputItems[0].content, [
      { type: 'refusal', refusal: 'declined' },
    ]);
    assert.equal(
      result.events.filter((event) => event.type === 'response.refusal.delta').length,
      2
    );
    assert.equal(result.events.filter((event) => event.type === 'response.refusal.done').length, 1);
  }
}
const truncated = streamResult([{ content: '{' }], 'length');
assert.equal(truncated.state.failed, undefined);
assert.equal(
  truncated.events.some((event) => event.type === 'response.incomplete'),
  true
);
assert.equal(streamResult([{ content: 'plain' }], 'stop', false).state.failed, undefined);
const toolStream = streamResult(
  [
    {
      tool_calls: [
        { index: 0, id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{' } },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: '"ok":true}' } }] },
  ],
  'tool_calls'
);
assert.equal(toolStream.state.failed, undefined);
assert.equal(
  toolStream.events.some((event) => event.type === 'response.completed'),
  true
);
const mixedRefusal = streamResult([{ content: 'explanation' }, { refusal: 'declined' }]);
assert.deepEqual(
  mixedRefusal.state.completedOutputItems.map((item) => item.content[0].type),
  ['output_text', 'refusal']
);
assert.equal(mixedRefusal.state.failed, undefined);
const legacyPayload = {
  id: 'chatcmpl_legacy',
  choices: [
    {
      finish_reason: 'function_call',
      message: {
        role: 'assistant',
        content: null,
        function_call: { name: 'probe', arguments: '{"ok":true}' },
      },
    },
  ],
};
const beforeLegacy = JSON.stringify(legacyPayload);
const legacyResponse = protocol.openAIChatToResponses(legacyPayload, 'fixture', request);
assert.equal(legacyResponse.status, 'completed');
assert.equal(legacyResponse.output.length, 1);
assert.equal(legacyResponse.output[0].type, 'function_call');
assert.equal(legacyResponse.output[0].name, 'probe');
assert.equal(legacyResponse.output[0].arguments, '{"ok":true}');
assert.ok(legacyResponse.output[0].call_id);
assert.equal(JSON.stringify(legacyPayload), beforeLegacy);
const legacyStream = streamResult(
  [
    { function_call: { name: 'pro', arguments: '{"ok":' } },
    { function_call: { name: 'be', arguments: 'true}' } },
  ],
  'function_call'
);
assert.equal(legacyStream.state.failed, undefined);
assert.equal(legacyStream.state.completedOutputItems[0].name, 'probe');
assert.equal(legacyStream.state.completedOutputItems[0].arguments, '{"ok":true}');
for (const deltas of [
  [{ function_call: { name: 'probe', arguments: 'SECRET' } }],
  [{ function_call: { arguments: '{}' } }],
  [{ function_call: [] }],
  [{ function_call: { name: 1 } }],
  [{ function_call: { name: 'probe', arguments: {} } }],
  [
    {
      function_call: { name: 'probe', arguments: '{}' },
      tool_calls: [{ index: 0, function: { name: 'probe', arguments: '{}' } }],
    },
  ],
  [
    { function_call: { name: 'probe', arguments: '{}' } },
    { tool_calls: [{ index: 0, function: { name: 'probe', arguments: '{}' } }] },
  ],
]) {
  const failed = streamResult(deltas, 'function_call');
  assert.equal(failed.state.failed, true);
  assert.equal(failed.events.filter((event) => event.type === 'response.failed').length, 1);
  assert.equal(
    failed.events.some((event) => event.type === 'response.completed'),
    false
  );
  assert.equal(failed.state.failure.message.includes('SECRET'), false);
}
const legacyTruncated = streamResult(
  [{ function_call: { name: 'probe', arguments: '{' } }],
  'length'
);
assert.equal(legacyTruncated.state.failed, undefined);
assert.equal(legacyTruncated.state.completedOutputItems[0].status, 'incomplete');
const { chatResponseToolCalls } = require('../lib/proxy/protocol-tool-completion');
const legacyMessage = legacyPayload.choices[0].message;
assert.equal(chatResponseToolCalls({ tool_calls: [tool] })[0], tool);
assert.equal(chatResponseToolCalls({}), undefined);
for (const function_call of [
  [],
  {},
  { name: '' },
  { name: 'probe', arguments: [] },
  { name: 'probe', arguments: 42 },
]) {
  assert.throws(
    () => chatResponseToolCalls({ function_call }),
    (error) => error.code === 'upstream_stream_invalid_tool_arguments'
  );
}
assert.throws(
  () => chatResponseToolCalls({ ...legacyMessage, tool_calls: [tool] }),
  (error) => error.code === 'upstream_stream_invalid_tool_arguments'
);
function reverseStream(output, { deltas = [], status = 'completed', finalDelimiter = true } = {}) {
  const state = {
    id: 'chatcmpl_fixture',
    created: 1,
    model: 'fixture',
    buffer: '',
    toolCalls: [],
    jsonObjectOutput: true,
  };
  let wire = '';
  const sink = {
    write: (chunk) => {
      wire += chunk;
    },
  };
  for (const event of deltas)
    protocol.processOpenAIResponsesSseChunkToChat(
      sink,
      'data: ' + JSON.stringify(event) + '\n\n',
      state
    );
  protocol.processOpenAIResponsesSseChunkToChat(
    sink,
    'data: ' +
      JSON.stringify({ type: 'response.' + status, response: { status, output } }) +
      (finalDelimiter ? '\n\n' : ''),
    state
  );
  protocol.flushOpenAIResponsesSseToChat(sink, state);
  const before = wire;
  protocol.processOpenAIResponsesSseChunkToChat(sink, 'data: SECRET\n\n', state);
  assert.equal(wire, before);
  assert.equal(state.jsonObjectCollector, undefined);
  return {
    state,
    events: wire
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6))),
  };
}
const messageOutput = (text) => [{ type: 'message', content: [{ type: 'output_text', text }] }];
for (const text of ['', '   ', 'SECRET', 'null', '[]', '{']) {
  for (const finalDelimiter of [true, false]) {
    const failed = reverseStream(messageOutput(text), { finalDelimiter });
    assert.equal(failed.state.failed, true);
    assert.equal(failed.events.filter((event) => event.error).length, 1);
    assert.equal(failed.events[0].error.code, 'upstream_invalid_json_object');
    assert.equal(failed.events[0].error.message.includes('SECRET'), false);
  }
}
for (const deltas of [
  [],
  [
    { type: 'response.output_text.delta', delta: '{' },
    { type: 'response.output_text.delta', delta: '}' },
  ],
]) {
  const valid = reverseStream(messageOutput('{}'), { deltas });
  assert.equal(valid.state.failed, false);
  assert.equal(
    valid.events.map((event) => event.choices?.[0]?.delta?.content || '').join(''),
    '{}'
  );
}
const mismatch = reverseStream(messageOutput('{}'), {
  deltas: [{ type: 'response.output_text.delta', delta: '{"other":true}' }],
});
assert.equal(mismatch.state.failed, true);
const reverseRefused = reverseStream([
  { type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] },
]);
assert.equal(reverseRefused.state.failed, false);
assert.equal(
  reverseRefused.events.map((event) => event.choices?.[0]?.delta?.refusal || '').join(''),
  'declined'
);
for (const deltas of [
  [{ type: 'response.refusal.delta', delta: '' }],
  [
    { type: 'response.refusal.delta', delta: 'de' },
    { type: 'response.refusal.delta', delta: 'clined' },
  ],
]) {
  const refused = reverseStream(
    [{ type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] }],
    { deltas }
  );
  assert.equal(refused.state.failed, false);
  assert.equal(
    refused.events.map((event) => event.choices?.[0]?.delta?.refusal || '').join(''),
    'declined'
  );
}
const reverseTools = reverseStream([outputTool]);
assert.equal(reverseTools.state.failed, false);
assert.equal(
  reverseTools.events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || []).length,
  1
);
assert.equal(reverseTools.events.at(-1).choices[0].finish_reason, 'tool_calls');
const deduplicatedTools = reverseStream([outputTool], {
  deltas: [{ type: 'response.output_item.done', output_index: 0, item: outputTool }],
});
assert.equal(deduplicatedTools.state.failed, false);
assert.equal(
  deduplicatedTools.events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || []).length,
  1
);
const reverseIncomplete = reverseStream(messageOutput('{'), {
  status: 'incomplete',
  deltas: [{ type: 'response.output_text.delta', delta: '{' }],
});
assert.equal(reverseIncomplete.state.failed, false);
assert.equal(reverseIncomplete.state.incomplete, true);
console.log('json-object-output-contract.test.js passed');
