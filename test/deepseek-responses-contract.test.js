'use strict';
const assert = require('node:assert/strict');
const { validateDeepSeekNativeResponses } = require('../lib/proxy/deepseek-responses-contract');
const {
  preflightDeepSeekRequest,
  preflightDeepSeekResponsesBody,
} = require('../lib/proxy/deepseek-request-contract');
const { shouldConvertResponsesToOpenAIChat } = require('../lib/proxy/responses-routing-policy');
function rejects(body, field) {
  assert.throws(
    () => validateDeepSeekNativeResponses(body),
    (error) =>
      error.code === 'invalid_request_error' &&
      error.provider === 'deepseek' &&
      (!field || error.param === field) &&
      !error.message.includes('SECRET')
  );
}
for (const body of [
  {},
  { input: 'hello', instructions: 'Be concise' },
  {
    input: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ],
  },
  {
    input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'rules' }] }],
  },
  { reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } },
  {
    store: false,
    background: false,
    parallel_tool_calls: true,
    truncation: 'disabled',
    metadata: {},
    include: [],
    context_management: [],
    stream_options: {},
  },
  {
    tools: [
      { type: 'function', name: 'probe', parameters: { type: 'object' } },
      { type: 'custom', name: 'apply_patch' },
    ],
    tool_choice: { type: 'function', name: 'probe' },
  },
  {
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  },
]) {
  const before = JSON.stringify(body);
  validateDeepSeekNativeResponses(body);
  assert.equal(JSON.stringify(body), before);
}
for (const field of [
  'previous_response_id',
  'conversation',
  'max_tool_calls',
  'prompt',
  'service_tier',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_retention',
]) {
  validateDeepSeekNativeResponses({ [field]: null });
  for (const value of ['SECRET', '', false, 0, 1e100, [], {}]) rejects({ [field]: value }, field);
}
for (const [field, values] of Object.entries({
  store: [true, 'false', 0, []],
  background: [true, 'false', {}],
  parallel_tool_calls: [false, 'true', 1],
  truncation: ['auto', 'SECRET', false],
  metadata: [{ content: 'SECRET' }, [], 'SECRET'],
  include: [['reasoning.encrypted_content'], {}, 'SECRET'],
  context_management: [[{ type: 'compaction' }], {}, 'SECRET'],
  stream_options: [{ include_obfuscation: false }, [], false],
})) {
  validateDeepSeekNativeResponses({ [field]: null });
  for (const value of values) rejects({ [field]: value }, field);
}
for (const value of [null, [], 'SECRET', 42]) rejects(value);
for (const reasoning of [[], 'SECRET', { summary: 'auto' }, { summary: 'detailed' }])
  rejects({ reasoning }, 'reasoning');
for (const effort of ['SECRET', 42, [], {}, false]) rejects({ reasoning: { effort } }, 'reasoning');
for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', null])
  validateDeepSeekNativeResponses({ reasoning: { effort } });
for (const input of [
  [{ type: 'function_call' }],
  [{ type: 'function_call', call_id: ' ', name: 'probe', arguments: '{}' }],
  [{ type: 'function_call', call_id: 'call_1', name: null, arguments: '{}' }],
  [{ type: 'function_call', call_id: 'call_1', name: 'probe', arguments: {} }],
  [{ type: 'function_call_output', call_id: 7, output: 'ok' }],
  [{ type: 'function_call_output', call_id: 'call_1', output: { content: 'SECRET' } }],
])
  rejects({ input });
validateDeepSeekNativeResponses({ input: [{ type: 'reasoning', summary: [] }] });
validateDeepSeekNativeResponses({
  input: [
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGk=' }] },
  ],
});
for (const image_url of [
  'javascript:void(0)',
  'file:///SECRET',
  'not-a-url',
  'https://user:SECRET@example.test/i.png',
  'https://example.test/\nSECRET',
  'data:text/html;base64,aGk=',
  'data:image/png;base64,???',
  'data:image/png;base64,' + Buffer.alloc(7 * 1024 * 1024 + 1).toString('base64'),
])
  rejects({ input: [{ role: 'user', content: [{ type: 'input_image', image_url }] }] });
validateDeepSeekNativeResponses({
  input: [
    { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/i.png' }] },
  ],
});
for (const input of [
  [{ role: 'user', content: [{ type: 'input_text', text: 42 }] }],
  [{ role: 'user', content: [{ type: 'output_text' }] }],
  [
    {
      role: 'assistant',
      content: [{ type: 'input_image', image_url: 'https://example.test/i.png' }],
    },
  ],
  [{ role: 'user', content: [{ type: 'input_image', image_url: ' ' }] }],
  [
    {
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'https://example.test/i.png', file_id: 'file_1' },
      ],
    },
  ],
])
  rejects({ input });
for (const text of [[], 'SECRET', { verbosity: 'high' }, { verbosity: 'low' }])
  rejects({ text }, 'text');
for (const tools of [[], [{ type: 'function', name: 'probe' }]])
  validateDeepSeekNativeResponses({ tools });
for (const tools of [
  'SECRET',
  {},
  [null],
  [{ type: 'web_search' }],
  [{ type: 'file_search' }],
  [{ type: 'custom', name: 'SECRET' }],
  [{ type: 'namespace', tools: [] }],
  [{ type: 'function', name: 'probe', parameters: [] }],
  [{ type: 'function', name: 'probe', strict: 'true' }],
])
  rejects({ tools }, 'tools');
for (const tool_choice of ['auto', 'none', 'required'])
  validateDeepSeekNativeResponses({ tool_choice });
for (const tool_choice of [
  'SECRET',
  [],
  0,
  { type: 'custom', name: 'apply_patch' },
  { type: 'function', name: '' },
])
  rejects({ tool_choice }, 'tool_choice');
for (const input of [
  42,
  {},
  [null],
  [{ type: 'additional_tools', tools: [] }],
  [{ type: 'reasoning', encrypted_content: 'SECRET' }],
  [{ type: 'reasoning', summary: [{ text: 'SECRET' }] }],
  [{ role: 'SECRET', content: 'fixture' }],
  [{ role: 'user', content: null }],
  [{ role: 'user', content: [{ type: 'input_file', file_id: 'SECRET' }] }],
])
  rejects({ input });
const prepared = {
  profile: { protocol: 'openai', targetUrl: 'https://api.deepseek.com/v1' },
  model: 'alias',
  rewriteTo: 'deepseek-v4-flash',
  buffer: Buffer.from('{"previous_response_id":"SECRET"}'),
};
assert.throws(
  () => preflightDeepSeekRequest(prepared, { requestPath: '/v1/responses' }),
  (error) => error.param === 'previous_response_id'
);
for (const option of [
  { forceChatCompletions: true },
  { supportsResponses: false },
  { responsesMode: 'chat' },
  { responsesEndpoint: 'chat' },
]) {
  const profile = { ...prepared.profile, ...option };
  assert.equal(shouldConvertResponsesToOpenAIChat(profile), true);
  preflightDeepSeekRequest({ ...prepared, profile }, { requestPath: '/v1/responses' });
}
assert.equal(shouldConvertResponsesToOpenAIChat(prepared.profile), false);
for (const other of [
  { ...prepared, rewriteTo: 'future-model' },
  { ...prepared, profile: { protocol: 'openai', targetUrl: 'https://api.deepseek.com.evil.test' } },
])
  preflightDeepSeekResponsesBody(other, { previous_response_id: 'SECRET' });
assert.throws(
  () => preflightDeepSeekResponsesBody(prepared, { previous_response_id: 'SECRET' }),
  (error) => error.code === 'invalid_request_error'
);
console.log('deepseek-responses-contract.test.js passed');
