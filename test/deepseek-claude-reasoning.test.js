'use strict';
const assert = require('node:assert/strict');
const {
  parseDeepSeekClaudeReasoning,
  applyDeepSeekClaudeReasoning,
} = require('../lib/proxy/deepseek-claude-reasoning');
const {
  prepareDeepSeekClaudeReasoning,
  preflightDeepSeekRequest,
} = require('../lib/proxy/deepseek-request-contract');
for (const [effort, expected] of Object.entries({
  none: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
})) {
  for (const controls of [
    { reasoning_effort: effort },
    { reasoning: { effort } },
    { output_config: { effort } },
  ]) {
    const body = { ...controls, max_output_tokens: 1024, input: 'fixture' };
    const before = JSON.stringify(body);
    const plan = parseDeepSeekClaudeReasoning(body);
    const result = { max_tokens: 1024 };
    applyDeepSeekClaudeReasoning(result, plan);
    assert.equal(result.max_tokens, 1024);
    assert.deepEqual(result.thinking, { type: expected === 'none' ? 'disabled' : 'enabled' });
    assert.equal(result.output_config?.effort, expected === 'none' ? undefined : expected);
    assert.equal(plan.source.reasoning, undefined);
    assert.equal(plan.source.reasoning_effort, undefined);
    assert.equal(JSON.stringify(body), before);
  }
}
for (const body of [
  null,
  [],
  { reasoning: [] },
  { reasoning: { summary: 'auto' } },
  { reasoning_effort: 'SECRET' },
  { reasoning_effort: '__proto__' },
  { output_config: { effort: 42 } },
  { thinking: { type: 'enabled', budget_tokens: 2048 } },
  { thinking: { type: 'enabled', budget_tokens: 1e100 } },
  { thinking: { type: 'enabled', display: 'summarized' } },
  { thinking: { type: 'disabled' }, reasoning_effort: 'high' },
  { reasoning_effort: 'low', reasoning: { effort: 'high' } },
]) {
  assert.throws(
    () => parseDeepSeekClaudeReasoning(body),
    (error) =>
      error.code === 'invalid_request_error' &&
      error.provider === 'deepseek' &&
      !error.message.includes('SECRET')
  );
}
assert.equal(parseDeepSeekClaudeReasoning({}).effort, undefined);
assert.equal(parseDeepSeekClaudeReasoning({ thinking: { type: 'adaptive' } }).effort, 'high');
assert.equal(
  parseDeepSeekClaudeReasoning({ reasoning_effort: 'minimal', reasoning: { effort: 'low' } })
    .effort,
  'low'
);
const prepared = {
  profile: { protocol: 'claude', targetUrl: 'https://api.deepseek.com/anthropic' },
  model: 'deepseek-v4-flash',
};
assert.equal(prepareDeepSeekClaudeReasoning(prepared, { reasoning_effort: 'max' }).effort, 'max');
for (const other of [
  { ...prepared, model: 'future-model' },
  {
    ...prepared,
    profile: { ...prepared.profile, targetUrl: 'https://api.deepseek.com.evil.test' },
  },
  { ...prepared, profile: { ...prepared.profile, protocol: 'openai' } },
])
  assert.equal(
    prepareDeepSeekClaudeReasoning(other, { thinking: { type: 'enabled', budget_tokens: 2048 } }),
    null
  );
preflightDeepSeekRequest(
  { ...prepared, buffer: Buffer.from(JSON.stringify({ output_config: { effort: 'max' } })) },
  { requestPath: '/v1/messages' }
);
assert.throws(
  () =>
    preflightDeepSeekRequest(
      {
        ...prepared,
        buffer: Buffer.from(JSON.stringify({ thinking: { type: 'enabled', budget_tokens: 2048 } })),
      },
      { requestPath: '/v1/messages' }
    ),
  (error) => error.code === 'invalid_request_error'
);
const nativeInput = Buffer.from(
  JSON.stringify({ output_config: { effort: 'minimal' }, messages: [] })
);
const native = { ...prepared, buffer: nativeInput };
preflightDeepSeekRequest(native, { requestPath: '/v1/messages' });
assert.equal(native.bodyChanged, true);
assert.deepEqual(JSON.parse(native.buffer), {
  messages: [],
  thinking: { type: 'enabled' },
  output_config: { effort: 'low' },
});
assert.equal(JSON.parse(nativeInput).output_config.effort, 'minimal');
console.log('deepseek-claude-reasoning.test.js passed');
