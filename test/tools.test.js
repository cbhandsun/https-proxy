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

// Test exec wrapping for Codex/OpenClaw nested tools
const codexTools = [
  {
    name: 'exec',
    input_schema: {
      type: 'object',
      properties: { input: { type: 'string' } },
    },
  },
  {
    name: 'request_user_input',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
    },
  },
];

assert.deepStrictEqual(
  sanitizeGeminiToolCall({ name: 'update_goal', args: { status: 'blocked' } }, codexTools),
  {
    name: 'exec',
    args: {
      input: 'await tools.update_goal({"status":"blocked"});',
      code: 'await tools.update_goal({"status":"blocked"});',
    },
    repairedFrom: 'update_goal',
  }
);

assert.deepStrictEqual(sanitizeGeminiToolCall({ name: 'clock__curr_time', args: {} }, codexTools), {
  name: 'exec',
  args: {
    input: 'await tools.clock__curr_time();',
    code: 'await tools.clock__curr_time();',
  },
  repairedFrom: 'clock__curr_time',
});

// Test anti-loop error message when exec is not available
const nonExecTools = [
  {
    name: 'read_file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
    },
  },
];

const unavailResult = sanitizeGeminiToolCall(
  { name: 'update_goal', args: { status: 'blocked' } },
  nonExecTools
);
assert.strictEqual(unavailResult.error, 'undeclared tool update_goal');
assert.match(unavailResult.text, /Do NOT call update_goal again/);
assert.match(unavailResult.text, /Available tools: read_file/);

console.log('[tools.test] ok');
