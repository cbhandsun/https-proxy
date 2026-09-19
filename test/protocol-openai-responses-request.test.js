'use strict';

/**
 * Unit tests for the extracted Chat -> Responses request converter.
 *
 * The converter is pure: no stream state, no I/O. It is exercised directly here so
 * the request-shaping contract is testable without constructing the full protocol
 * closure.
 */

const assert = require('node:assert/strict');
const {
  createResponsesRequestConverter,
  inferToolNameFromArguments,
  normalizeServiceTier,
} = require('../lib/proxy/protocol-openai-responses-request');

const { openAIChatToResponsesRequest } = createResponsesRequestConverter({
  fallbackId: (prefix) => prefix + '_test',
  chatToolContentToResponsesOutput: (content) =>
    typeof content === 'string' ? content : JSON.stringify(content),
});

// --- happy path ---
{
  const result = openAIChatToResponsesRequest({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ],
  });
  assert.strictEqual(result.model, 'gpt-5');
  assert.strictEqual(result.store, false);
  assert.strictEqual(result.stream, true);
  assert.strictEqual(result.instructions, 'be terse');
  assert.deepStrictEqual(result.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ]);
}

// --- default instructions when no system message ---
assert.strictEqual(
  openAIChatToResponsesRequest({ model: 'm', messages: [] }).instructions,
  'You are a helpful assistant.'
);

// --- multimodal parts ---
{
  const result = openAIChatToResponsesRequest({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          { type: 'image_url', image_url: 'https://x/z.png' },
        ],
      },
    ],
  });
  assert.deepStrictEqual(result.input[0].content, [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: 'https://x/y.png' },
    { type: 'input_image', image_url: 'https://x/z.png' },
  ]);
}

// --- tool calls and tool results ---
{
  const result = openAIChatToResponsesRequest({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'out' },
    ],
  });
  assert.strictEqual(result.input[0].type, 'function_call');
  assert.strictEqual(result.input[0].name, 'Bash');
  assert.strictEqual(result.input[0].call_id, 'call_1');
  assert.deepStrictEqual(result.input[1], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'out',
  });
}

// --- unstable tool call ids are made deterministic ---
{
  const body = {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        tool_calls: [{ function: { name: 'Bash', arguments: '{"command":"pwd"}' } }],
      },
    ],
  };
  assert.strictEqual(openAIChatToResponsesRequest(body).input[0].call_id, 'call_test');
}

// --- error tool results are marked ---
{
  const result = openAIChatToResponsesRequest({
    model: 'm',
    messages: [{ role: 'tool', tool_call_id: 'c', content: 'boom', is_error: true }],
  });
  assert.strictEqual(result.input[0].status, 'error');
}

// --- reasoning effort, tools, tool_choice ---
{
  const result = openAIChatToResponsesRequest({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    service_tier: 'priority',
    tools: [
      { type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } },
      { type: 'not_function' },
      { type: 'function' },
    ],
    tool_choice: { type: 'function', function: { name: 'Bash' } },
  });
  assert.deepStrictEqual(result.reasoning, { effort: 'high' });
  assert.strictEqual(result.service_tier, 'priority');
  assert.strictEqual(result.tools.length, 1, 'only well-formed function tools survive');
  assert.strictEqual(result.tools[0].description, '');
  assert.deepStrictEqual(result.tool_choice, { type: 'function', name: 'Bash' });
}

assert.strictEqual(
  openAIChatToResponsesRequest({ model: 'm', messages: [], service_tier: ' priority ' })
    .service_tier,
  'priority'
);
for (const badTier of ['', 'bad tier', '../priority', { id: 'priority' }, 'x'.repeat(65)]) {
  assert.strictEqual(
    openAIChatToResponsesRequest({ model: 'm', messages: [], service_tier: badTier }).service_tier,
    undefined
  );
}
assert.strictEqual(normalizeServiceTier('default'), 'default');
assert.strictEqual(normalizeServiceTier('priority'), 'priority');
assert.strictEqual(normalizeServiceTier('bad tier'), null);

assert.strictEqual(
  openAIChatToResponsesRequest({ model: 'm', messages: [], tool_choice: 'auto' }).tool_choice,
  'auto'
);

// --- hostile / empty inputs must not throw ---
for (const bad of [null, undefined, {}, { model: 'm' }, { model: 'm', messages: null }]) {
  const result = openAIChatToResponsesRequest(bad);
  assert.strictEqual(result.stream, true, 'every request is streamed');
  assert.ok(Array.isArray(result.input), 'input is always an array');
}

// --- tool-name inference ---
assert.strictEqual(inferToolNameFromArguments({ command: 'ls' }), 'Bash');
assert.strictEqual(inferToolNameFromArguments({ file_path: '/a' }), 'Read');
assert.strictEqual(inferToolNameFromArguments({ pattern: 'x', path: '/a' }), 'Glob');
assert.strictEqual(inferToolNameFromArguments({}), '');
assert.strictEqual(inferToolNameFromArguments(null), '');
assert.strictEqual(inferToolNameFromArguments('nope'), '');

console.log('[protocol-openai-responses-request.test] ok');
