'use strict';
const assert = require('node:assert/strict');
const {
  convertUsageDetails,
  claudeUsageToOpenAIChatUsage,
} = require('../lib/proxy/protocol-usage-details');
const {
  createResponsesChatTerminalStateMachine,
} = require('../lib/proxy/protocol-openai-responses-stream');
const details = {
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 100 },
};
const response = convertUsageDetails(details, true);
assert.equal(claudeUsageToOpenAIChatUsage([]), undefined);
assert.deepEqual(claudeUsageToOpenAIChatUsage({ input_tokens: '10', output_tokens: '2' }), {
  prompt_tokens: 10,
  completion_tokens: 2,
  total_tokens: 12,
  cached_input_tokens: 0,
});
assert.equal(
  claudeUsageToOpenAIChatUsage({ input_tokens: Infinity, output_tokens: 'private-marker' })
    .total_tokens,
  0
);
assert.equal(
  claudeUsageToOpenAIChatUsage({ input_tokens: 10, cached_input_tokens: 100 }).cached_input_tokens,
  10
);
assert.equal(response.input_tokens_details.cached_tokens, 800);
assert.equal(response.output_tokens_details.reasoning_tokens, 100);
assert.deepEqual(convertUsageDetails(response, false), { ...details, cached_input_tokens: 800 });
for (const empty of [undefined, null, [], '', {}])
  assert.deepEqual(convertUsageDetails(empty, true), {});
for (const invalid of [-1, Infinity, NaN, true, {}, '12secret'])
  assert.deepEqual(convertUsageDetails({ reasoning_tokens: invalid }, true), {});
assert.equal(
  convertUsageDetails({ reasoning_tokens: '0' }, true).output_tokens_details.reasoning_tokens,
  0
);
assert.equal(convertUsageDetails({ cached_input_tokens: 1e20 }, false).cached_input_tokens, 1e9);
assert.equal(
  JSON.stringify(convertUsageDetails({ cookie: 'private-marker' }, true)).includes(
    'private-marker'
  ),
  false
);
const machine = createResponsesChatTerminalStateMachine({ writeChatChunk() {} });
const state = { toolCalls: [] };
machine.handleTerminalEvent({ write() {} }, state, {
  type: 'response.completed',
  response: { usage: { input_tokens: 1000, output_tokens: 120, total_tokens: 1120, ...response } },
});
assert.equal(state.usage.prompt_tokens_details.cached_tokens, 800);
assert.equal(state.usage.completion_tokens_details.reasoning_tokens, 100);
console.log('[protocol-usage-details.test] ok');
