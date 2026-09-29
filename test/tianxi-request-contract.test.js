'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { unsupportedTianxiResponsesFeature } = require('../lib/proxy/tianxi-request-contract');

test('Tianxi accepts text-only requests and empty optional tool settings', () => {
  for (const body of [
    { input: 'hello' },
    { input: [{ role: 'user', content: 'hello' }], tools: [], tool_choice: 'auto' },
    { input: '', tools: [], tool_choice: 'none' },
  ]) {
    assert.equal(unsupportedTianxiResponsesFeature(body), null);
  }
});

test('Tianxi rejects unsupported and malformed tool requests without inspecting content', () => {
  for (const [body, feature] of [
    [{ tools: [{ type: 'function', name: 'read_file' }] }, 'tools'],
    [{ tools: null }, 'tools'],
    [{ tools: 'SECRET' }, 'tools'],
    [{ tools: Array.from({ length: 1000 }, () => ({})) }, 'tools'],
    [{ tools: [], tool_choice: { type: 'function', name: 'read_file' } }, 'tool_choice'],
    [{ tool_choice: 'required' }, 'tool_choice'],
    [{ previous_response_id: 'resp_1' }, 'previous_response_id'],
    [{ input: [{ type: 'function_call_output', output: 'SECRET' }] }, 'function_call_output'],
    [
      { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'SECRET' }] }] },
      'input',
    ],
    [{ input: { role: 'user', content: [{ type: 'input_image', image_url: 'SECRET' }] } }, 'input'],
    [{ input: [{ role: 'user', content: [{ type: 'input_audio', data: 'SECRET' }] }] }, 'input'],
    [{ input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'SECRET' }] }] }, 'input'],
    [{ input: [{ role: 'user', content: { type: 'input_image', image_url: 'SECRET' } }] }, 'input'],
    [
      {
        input: {
          role: 'user',
          content: [{ type: 'function_call_output', call_id: 'call_1', output: 'SECRET' }],
        },
      },
      'function_call_output',
    ],
  ]) {
    assert.equal(unsupportedTianxiResponsesFeature(body), feature);
  }
  assert.equal(unsupportedTianxiResponsesFeature(null), null);
  assert.equal(unsupportedTianxiResponsesFeature([]), null);
});

test('Tianxi native read mode accepts auto tool declarations but not forced calls or continuations', () => {
  const mode = { nativeReadTools: true };
  assert.equal(
    unsupportedTianxiResponsesFeature(
      { tools: [{ type: 'function', name: 'read_file' }], tool_choice: 'auto' },
      mode
    ),
    null
  );
  assert.equal(unsupportedTianxiResponsesFeature({ tools: [null] }, mode), 'tools');
  assert.equal(unsupportedTianxiResponsesFeature({ tools: Array(129).fill({}) }, mode), 'tools');
  assert.equal(
    unsupportedTianxiResponsesFeature({ tools: [{}], tool_choice: 'required' }, mode),
    'tool_choice'
  );
  assert.equal(
    unsupportedTianxiResponsesFeature({ previous_response_id: 'resp_1' }, mode),
    'previous_response_id'
  );
  assert.equal(
    unsupportedTianxiResponsesFeature(
      { previous_response_id: 'resp_1' },
      { ...mode, responseHistory: true }
    ),
    null
  );
});
