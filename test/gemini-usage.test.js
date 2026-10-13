'use strict';
const assert = require('node:assert/strict');
const { geminiUsageToClaude } = require('../lib/proxy/gemini-usage');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { normalizeUsage, estimateCost, usageFromSsePayload } = require('../lib/proxy/usage-report');

const metadata = {
  promptTokenCount: 1000,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 100,
  totalTokenCount: 1120,
  cachedContentTokenCount: 800,
};
const converted = geminiUsageToClaude(metadata);
assert.deepEqual(converted, {
  input_tokens: 1000,
  output_tokens: 120,
  cached_input_tokens: 800,
  reasoning_tokens: 100,
  total_tokens: 1120,
});
assert.deepEqual(createGeminiProtocol({}).geminiUsageToClaude(metadata), converted);
assert.deepEqual(normalizeUsage(metadata), normalizeUsage(converted));
assert.deepEqual(
  normalizeUsage(normalizeUsage(metadata)),
  normalizeUsage(metadata),
  'normalized cache and total must survive report/cost normalization'
);
assert.equal(normalizeUsage(converted).totalTokens, 1120);
assert.ok(
  Math.abs(
    estimateCost(normalizeUsage(converted), 'custom', {
      modelPricing: [
        { match: 'custom', inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 2 },
      ],
    }).amount - 0.00052
  ) < 1e-12
);
for (const input of [null, undefined, [], '', false])
  assert.deepEqual(geminiUsageToClaude(input), {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
  });
assert.deepEqual(
  geminiUsageToClaude({
    promptTokenCount: '10',
    candidatesTokenCount: '2',
    thoughtsTokenCount: '3',
    cached_content_token_count: '9',
  }),
  { input_tokens: 10, output_tokens: 5, cached_input_tokens: 9, reasoning_tokens: 3 }
);
for (const invalid of [-1, Infinity, NaN, {}, true, 'secret', '12secret'])
  assert.equal(geminiUsageToClaude({ thoughtsTokenCount: invalid }).reasoning_tokens, undefined);
assert.equal(
  geminiUsageToClaude({ promptTokenCount: 10, cachedContentTokenCount: 100 }).cached_input_tokens,
  10
);
assert.equal(
  geminiUsageToClaude({ candidatesTokenCount: 1e20, thoughtsTokenCount: 1e20 }).output_tokens,
  1e9
);
assert.equal(geminiUsageToClaude({ ...metadata, totalTokenCount: 1 }).total_tokens, 1120);
assert.equal(geminiUsageToClaude({ thoughtsTokenCount: 0 }).reasoning_tokens, 0);
assert.equal(
  JSON.stringify(geminiUsageToClaude({ token: 'private-marker' })).includes('private-marker'),
  false
);

const events = [];
const protocol = createOpenAIProtocol({
  isClaudeThinkingBlock: () => false,
  stableCreated: () => 1,
  fallbackId: () => 'response_test',
  writeResponsesSseEvent: (_res, _event, payload) => events.push(payload),
});
const chat = protocol.claudeResponseToOpenAIChat(
  { id: 'msg_test', content: [], usage: converted },
  'gemini'
);
assert.equal(chat.usage.completion_tokens, 120);
assert.equal(chat.usage.completion_tokens_details.reasoning_tokens, 100);
const responses = protocol.openAIChatToResponses(chat, 'gemini');
assert.equal(responses.usage.output_tokens_details.reasoning_tokens, 100);
assert.equal(normalizeUsage(responses.usage).cachedInputTokens, 800);
assert.equal(
  protocol.openAIResponsesToChatResponse(responses, 'gemini').usage.completion_tokens_details
    .reasoning_tokens,
  100
);
const state = { buffer: '', model: 'gemini', id: 'resp_test', created: 1 };
protocol.processOpenAIChatSseChunkToResponses(
  { write() {} },
  'data: ' + JSON.stringify({ choices: [], usage: chat.usage }) + '\n\n',
  state
);
assert.deepEqual(normalizeUsage(state.usage), normalizeUsage(converted));
assert.equal(state.usage.output_tokens_details.reasoning_tokens, 100);
assert.equal(
  usageFromSsePayload({ type: 'response.completed', response: { usage: state.usage } }).totalTokens,
  1120
);
console.log('[gemini-usage.test] ok');
