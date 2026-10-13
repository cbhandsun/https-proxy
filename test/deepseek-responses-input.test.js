'use strict';
const assert = require('node:assert/strict');
const {
  validateDeepSeekNativeResponses: validate,
} = require('../lib/proxy/deepseek-responses-contract');
const fn = { type: 'function_call', call_id: 'f1', name: 'probe', arguments: '{}' };
const patch = {
  type: 'custom_tool_call',
  call_id: 'p1',
  name: 'apply_patch',
  input: '*** Begin Patch\n*** End Patch',
};
const image = { type: 'input_image', image_url: 'data:image/png;base64,aGk=', detail: 'original' };
for (const input of [
  [],
  '',
  null,
  [
    fn,
    patch,
    {
      type: 'function_call_output',
      call_id: 'f1',
      output: [{ type: 'input_text', text: 'ok' }, image],
    },
    { type: 'custom_tool_call_output', call_id: 'p1', output: [image] },
  ],
  [patch, { type: 'custom_tool_call_output', call_id: 'p1', output: '' }],
  [{ type: 'reasoning', content: 'plain', summary: [] }],
  [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plain' }] }],
  [{ role: 'user', content: [{ type: 'input_image', file_id: 'file-api-fixture' }] }],
  [{ role: 'developer', content: 'fixture' }],
  [{ role: 'developer', content: [{ type: 'input_text', text: 'fixture' }, image] }],
  [
    {
      role: 'developer',
      content: [
        { type: 'input_image', image_url: 'https://example.test/' + 'x'.repeat(8192 - 21) },
      ],
    },
  ],
  [{ type: 'web_search_call', action: { type: 'search', query: 'fixture' } }],
]) {
  const body = { input },
    before = JSON.stringify(body);
  validate(body);
  assert.equal(JSON.stringify(body), before);
}
for (const input of [
  [fn, { type: 'function_call_output', call_id: 'f1', output: [null] }],
  [
    fn,
    {
      type: 'function_call_output',
      call_id: 'f1',
      output: [{ type: 'input_file', file_id: 'SECRET' }],
    },
  ],
  [fn, { type: 'function_call_output', call_id: 'f1', output: [{ type: 'input_text', text: 42 }] }],
  [
    patch,
    {
      type: 'custom_tool_call_output',
      call_id: 'p1',
      output: [{ type: 'input_image', image_url: 'javascript:SECRET' }],
    },
  ],
  [{ ...patch, name: 'SECRET' }],
  [{ ...patch, input: {} }],
  [{ ...patch, call_id: ' ' }],
  [patch, patch],
  [patch, { type: 'function_call_output', call_id: 'p1', output: 'ok' }],
  [{ type: 'custom_tool_call_output', call_id: 'missing', output: 'ok' }],
  [
    patch,
    { type: 'custom_tool_call_output', call_id: 'p1', output: 'ok' },
    { type: 'custom_tool_call_output', call_id: 'p1', output: 'ok' },
  ],
  [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 42 }] }],
  [{ type: 'reasoning', content: [image] }],
  [{ type: 'web_search_call', action: [] }],
  Array.from({ length: 4097 }, () => ({ role: 'user', content: '' })),
  [
    {
      role: 'user',
      content: Array.from({ length: 4097 }, () => ({ type: 'input_text', text: '' })),
    },
  ],
  [{ role: 'user', content: [{ ...image, detail: 'SECRET' }] }],
  [
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.test/' + 'x'.repeat(8193) }],
    },
  ],
  [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
  [{ role: 'user', content: [{ type: 'input_image', file_id: 'file-api-' }] }],
  [{ role: 'user', content: [{ type: 'input_image', file_id: 'file-api-SECRET\n' }] }],
  [{ role: 'assistant', content: [image] }],
  [{ role: 'system', content: [image] }],
])
  assert.throws(
    () => validate({ input }),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
  );
let deep = { ok: true };
for (let index = 0; index < 66; index++) deep = { child: deep };
for (const args of [
  '',
  'SECRET',
  'null',
  '[]',
  '42',
  '{"__proto__":{"SECRET":true}}',
  '{"value":1e400}',
  JSON.stringify(deep),
  JSON.stringify({ values: Array.from({ length: 10001 }, () => 1) }),
])
  assert.throws(
    () => validate({ input: [{ ...fn, arguments: args }] }),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
  );
validate({ input: [{ ...fn, arguments: '{"values":[true,null,1],"text":"中文"}' }] });
validate({
  input: [
    {
      role: 'user',
      content: Array.from({ length: 4096 }, () => ({ type: 'input_text', text: '' })),
    },
  ],
});
assert.throws(
  () =>
    validate({
      input: [
        {
          role: 'user',
          content: Array.from({ length: 3000 }, () => ({ type: 'input_text', text: '' })),
        },
        {
          role: 'user',
          content: Array.from({ length: 1097 }, () => ({ type: 'input_text', text: '' })),
        },
      ],
    }),
  (error) => error.code === 'invalid_request_error'
);
console.log('deepseek-responses-input.test.js passed');
