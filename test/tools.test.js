'use strict';

const assert = require('assert');
const { declaredToolMatchForArgs, sanitizeGeminiToolCall } = require('../lib/proxy/tools');

const wrapperTools = [
  {
    name: 'tool_call',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, arguments: { type: 'object' } },
      required: ['id'],
    },
  },
  {
    name: 'tool_describe',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'tool_search',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

assert.deepStrictEqual(
  sanitizeGeminiToolCall({ name: 'tool_call', args: { query: 'stock price' } }, wrapperTools),
  {
    name: 'tool_search',
    args: { query: 'stock price' },
    repairedFrom: 'call',
  }
);

assert.deepStrictEqual(
  sanitizeGeminiToolCall({ name: 'tool_call', args: { id: 'finance.quote' } }, wrapperTools),
  { name: 'tool_call', args: { id: 'finance.quote' } }
);

assert.deepStrictEqual(
  sanitizeGeminiToolCall({ name: 'tool_search', args: { query: 'stock price' } }, wrapperTools),
  { name: 'tool_search', args: { query: 'stock price' } }
);

assert.strictEqual(
  declaredToolMatchForArgs('tool_call', { query: 'x', unexpected: true }, wrapperTools),
  null
);

const ambiguousTools = wrapperTools.concat({
  name: 'find_tool',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
});
assert.strictEqual(declaredToolMatchForArgs('tool_call', { query: 'x' }, ambiguousTools), null);
assert.match(
  sanitizeGeminiToolCall({ name: 'tool_call', args: { query: 'x' } }, ambiguousTools).error,
  /missing required tool args for call: id/
);

assert.strictEqual(declaredToolMatchForArgs('tool_call', null, wrapperTools), null);
assert.strictEqual(declaredToolMatchForArgs('tool_call', 'query=x', wrapperTools), null);
assert.strictEqual(declaredToolMatchForArgs('tool_call', {}, wrapperTools), null);

console.log('[tools.test] ok');
