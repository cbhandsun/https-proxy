'use strict';
const assert = require('node:assert/strict');
const {
  createGeminiChatHistoryAdapter,
  validateGeminiChatHistory,
} = require('../lib/proxy/gemini-chat-history');
function setup(argumentsCache, mutate = false) {
  const counts = { sanitize: 0, ids: 0, emitted: 0 };
  const adapter = createGeminiChatHistoryAdapter({
    argumentsCache,
    cleanToolArgs: (_name, args) => {
      counts.sanitize++;
      if (mutate) args.visits = (args.visits || 0) + 1;
      return { ...args };
    },
    fallbackId: () => 'generated_' + ++counts.ids,
    mergeAdjacentGeminiTextParts: (parts) => parts,
    nativeToolHistory: {
      callParts: (call, options) => {
        assert.equal(options.preserveIds, true);
        counts.emitted++;
        return [{ functionCall: { id: call.id, name: call.name, args: call.args } }];
      },
      resultParts: (result) => [
        {
          functionResponse: {
            id: result.id,
            response: { text: result.text },
            orphan: result.orphan,
          },
        },
      ],
    },
  });
  return { adapter, counts };
}
const call = (id, args = JSON.stringify({ q: '中文 😀' })) => ({
  ...(id ? { id } : {}),
  type: 'function',
  function: { name: 'lookup', arguments: args },
});
for (const explicit of [false, true]) {
  const { adapter, counts } = setup();
  const expectedId = explicit ? 'exact-id' : 'generated_1';
  const source = [
    { role: 'assistant', content: null, tool_calls: [call(explicit ? expectedId : undefined)] },
    { role: 'tool', tool_call_id: expectedId, content: 'done' },
  ];
  const before = JSON.stringify(source);
  const result = adapter.repairHistory(source, {});
  assert.equal(counts.sanitize, 1);
  assert.equal(counts.ids, explicit ? 0 : 1);
  assert.equal(result.repairedCount, 0);
  const message = result.messages[0];
  assert.equal(message.content[0].functionCall.id, expectedId);
  assert.equal(message.tool_calls[0].id, expectedId);
  assert.equal(result.messages[1].content[0].functionResponse.id, expectedId);
  assert.deepEqual(result.messages[1].tool_result_ids, [expectedId]);
  assert.equal(JSON.stringify(source), before);
}
{
  const { adapter, counts } = setup();
  const result = adapter.repairHistory(
    [
      { role: 'assistant', content: 'parallel', tool_calls: [call(), call()] },
      { role: 'tool', tool_call_id: 'generated_2', content: 'second' },
      { role: 'tool', tool_call_id: 'generated_1', content: 'first' },
    ],
    {}
  );
  assert.equal(counts.sanitize, 2);
  assert.equal(counts.ids, 2);
  assert.deepEqual(result.messages[0].tool_calls, [{ id: 'generated_1' }, { id: 'generated_2' }]);
  assert.equal(result.repairedCount, 0);
}
{
  const { adapter, counts } = setup();
  assert.deepEqual(adapter.repairHistory([], {}), { messages: [], repairedCount: 0 });
  assert.equal(adapter.repairHistory([{ role: 'user', content: 'hello' }], {}).messages.length, 1);
  assert.deepEqual(counts, { sanitize: 0, ids: 0, emitted: 0 });
}
for (const args of ['{', '[]', 'null']) {
  const { adapter, counts } = setup();
  assert.throws(
    () => adapter.repairHistory([{ role: 'assistant', tool_calls: [call('a', args)] }], {}),
    (error) => error.code === 'invalid_request_error'
  );
  assert.equal(counts.sanitize, 0);
  assert.equal(counts.emitted, 0);
}
{
  const argumentsCache = new WeakMap();
  const { adapter } = setup(argumentsCache);
  const argumentText = '{"q":"validation-reuse"}';
  const toolCall = call('reuse', argumentText);
  const source = [{ role: 'assistant', content: null, tool_calls: [toolCall] }];
  const originalParse = JSON.parse;
  let parses = 0;
  try {
    JSON.parse = function (text, ...args) {
      if (text === argumentText) parses++;
      return originalParse.call(JSON, text, ...args);
    };
    validateGeminiChatHistory(source, argumentsCache);
    assert.equal(
      adapter.repairHistory(source, {}).messages[0].content[0].functionCall.args.q,
      'validation-reuse'
    );
    assert.equal(parses, 1, 'Reuse the validated argument parse once within this request');
  } finally {
    JSON.parse = originalParse;
  }
}
for (const changed of ['{"q":"changed"}', '{', '[]', 'null']) {
  const argumentsCache = new WeakMap();
  const { adapter, counts } = setup(argumentsCache);
  const toolCall = call('changed', '{"q":"before"}');
  const source = [{ role: 'assistant', tool_calls: [toolCall] }];
  validateGeminiChatHistory(source, argumentsCache);
  toolCall.function.arguments = changed;
  if (changed === '{"q":"changed"}') {
    assert.equal(
      adapter.repairHistory(source, {}).messages[0].content[0].functionCall.args.q,
      'changed'
    );
  } else {
    assert.throws(
      () => adapter.repairHistory(source, {}),
      (error) => error.code === 'invalid_request_error'
    );
    assert.equal(counts.emitted, 0);
    toolCall.function.arguments = '{"q":"retry"}';
    assert.equal(
      adapter.repairHistory(source, {}).messages[0].content[0].functionCall.args.q,
      'retry'
    );
  }
}
{
  const argumentsCache = new WeakMap();
  const { adapter } = setup(argumentsCache, true);
  const toolCall = call('duplicate', '{"q":"unchanged"}');
  const source = [{ role: 'assistant', tool_calls: [toolCall, toolCall] }];
  validateGeminiChatHistory(source, argumentsCache);
  const converted = adapter.repairHistory(source, {}).messages[0];
  assert.deepEqual(
    converted.content.map((part) => part.functionCall.args.visits),
    [1, 1]
  );
  assert.equal(toolCall.function.arguments, '{"q":"unchanged"}');
  const next = adapter.repairHistory(source, {}).messages[0];
  assert.deepEqual(
    next.content.map((part) => part.functionCall.args.visits),
    [1, 1]
  );
}
for (const source of [
  [],
  [{ role: 'user', content: '' }],
  [{ role: 'assistant', tool_calls: [call('object', {})] }],
]) {
  const argumentsCache = new WeakMap();
  const { adapter } = setup(argumentsCache);
  validateGeminiChatHistory(source, argumentsCache);
  assert.ok(Array.isArray(adapter.repairHistory(source, {}).messages));
}
console.log('gemini-history-call-reuse.test.js passed');
