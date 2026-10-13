'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createChatCompletionCollector } = require('../lib/proxy/forced-stream-collector');

function collect(deltas, finishReason = 'stop') {
  const collector = createChatCompletionCollector(16384);
  for (const delta of deltas)
    collector.push(
      Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n')
    );
  collector.push(
    Buffer.from(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }) +
        '\n\ndata: [DONE]\n\n'
    )
  );
  return collector.finish();
}

test('empty/null legacy placeholders do not turn normal Unicode text into a tool call', () => {
  for (const placeholder of [
    null,
    {},
    { name: '', arguments: '' },
    { name: null, arguments: null },
    { name: '' },
    { arguments: '' },
  ]) {
    const result = collect([{ role: 'assistant', function_call: placeholder, content: '中文🙂' }]);
    assert.deepEqual(result.choices[0].message, { role: 'assistant', content: '中文🙂' });
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.deepEqual(result.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  }
});

test('real fragmented legacy calls survive empty deltas before and after without losing arguments', () => {
  const result = collect(
    [
      { function_call: { name: '', arguments: '' } },
      { function_call: { name: 're', arguments: '{"id":' } },
      { function_call: {} },
      { function_call: { name: 'ad', arguments: '42}' } },
      { function_call: { name: null, arguments: null } },
    ],
    'function_call'
  );
  assert.deepEqual(result.choices[0].message.function_call, {
    name: 'read',
    arguments: '{"id":42}',
  });
});

test('malformed, unknown-field and nonempty calls cannot disappear as placeholders', () => {
  for (const call of [
    'read',
    [],
    1,
    false,
    { name: 0 },
    { arguments: {} },
    { name: ' ' },
    { arguments: '{}' },
    { extra: true },
    JSON.parse('{"__proto__":{},"name":""}'),
  ]) {
    const result = collect([{ content: 'not a verified result', function_call: call }]);
    assert.ok(Object.hasOwn(result.choices[0].message, 'function_call'));
  }
  const terminal = collect([{ content: 'incomplete', function_call: {} }], 'function_call');
  assert.deepEqual(terminal.choices[0].message.function_call, { name: '', arguments: '' });
  assert.equal(terminal.choices[0].finish_reason, 'function_call');
});

test('modern tools, refusal and non-stop terminals keep their independent rejection signals', () => {
  const result = collect(
    [
      {
        function_call: {},
        refusal: 'refused',
        tool_calls: [
          { index: 0, id: 'call1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
    ],
    'tool_calls'
  );
  assert.equal(result.choices[0].message.refusal, 'refused');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'read');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(Object.hasOwn(result.choices[0].message, 'function_call'), false);
  assert.equal(
    collect([{ content: 'truncated', function_call: {} }], 'length').choices[0].finish_reason,
    'length'
  );
});

test('direct completion objects stay unchanged, including explicitly supplied calls', () => {
  const completion = {
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'answer', function_call: {} },
      },
    ],
  };
  const collector = createChatCompletionCollector(16384);
  collector.push(Buffer.from('data: ' + JSON.stringify(completion) + '\n\ndata: [DONE]\n\n'));
  assert.deepEqual(collector.finish(), completion);
});
