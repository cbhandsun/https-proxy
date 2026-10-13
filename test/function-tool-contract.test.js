'use strict';

const assert = require('node:assert/strict');
const {
  functionToolContract,
  validateConvertedFunctionTools,
} = require('../lib/proxy/function-tool-contract');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');

const p = createOpenAIProtocol({
  fallbackId: () => 'id',
  stableCreated: () => 1,
  normalizeClaudeContent: (content) => content || [],
  normalizeClaudeSystem: () => null,
  filterClaudeCompatibleBlocks: (blocks) => blocks || [],
  isClaudeThinkingBlock: () => false,
  cleanToolArgs: (_name, args) => args,
});
const schema = {
  type: 'object',
  $defs: { location: { type: 'string' } },
  properties: { path: { $ref: '#/$defs/location' }, optional: { type: ['string', 'null'] } },
  required: ['path', 'optional'],
  additionalProperties: false,
};

for (const strict of [true, false, undefined]) {
  const tool = {
    type: 'function',
    function: { name: 'lookup', parameters: schema, ...(strict !== undefined ? { strict } : {}) },
  };
  const claude = p.openAIChatToClaudeMessages({ messages: [], tools: [tool] }, 'synthetic');
  assert.deepEqual(claude.tools[0].input_schema, schema);
  assert.equal(claude.tools[0].strict, strict);
  const chat = p.claudeMessagesToOpenAIChat({ messages: [], tools: claude.tools }, 'synthetic');
  assert.deepEqual(chat.tools[0].function.parameters, schema);
  assert.equal(chat.tools[0].function.strict, strict);
  const response = p.openAIChatToResponsesRequest(
    { messages: [], tools: chat.tools },
    { codex: false }
  );
  assert.deepEqual(response.tools[0].parameters, schema);
  assert.equal(response.tools[0].strict, strict ?? false);
  const roundTrip = p.openAIResponsesToChat({ input: [], tools: response.tools }, 'synthetic');
  assert.deepEqual(roundTrip.tools[0].function.parameters, schema);
  assert.equal(roundTrip.tools[0].function.strict, strict ?? false);
  assert.deepEqual(schema.required, ['path', 'optional'], 'conversion does not rewrite schemas');
}
for (const source of [
  null,
  [],
  { name: '' },
  { name: 1 },
  { name: 'lookup', strict: 'true' },
  { name: 'lookup', strict: 0 },
  { name: 'lookup', parameters: [] },
  { name: 'lookup', parameters: false },
]) {
  assert.throws(
    () => functionToolContract(source),
    (error) => error.code === 'invalid_request_error'
  );
}
assert.deepEqual(functionToolContract({ name: 'lookup' }), {
  parameters: { type: 'object', properties: {} },
});
assert.doesNotThrow(() => validateConvertedFunctionTools([], 'chat', 'Gemini'));
for (const shape of ['chat', 'responses', 'claude']) {
  const source = {
    name: 'lookup',
    strict: true,
    [shape === 'claude' ? 'input_schema' : 'parameters']: schema,
  };
  const tools = [
    shape === 'chat' ? { type: 'function', function: source } : { type: 'function', ...source },
  ];
  assert.throws(() => validateConvertedFunctionTools(tools, shape, 'Gemini'), /cannot be enforced/);
  source.strict = false;
  if (shape !== 'chat') tools[0].strict = false;
  assert.doesNotThrow(() => validateConvertedFunctionTools(tools, shape, 'Gemini'));
}
const errors = [];
const validators = createRequestValidators({
  sendJsonError: (_sink, status, body) => errors.push({ status, body }),
});
for (const strict of [true, 'secret-value']) {
  assert.equal(
    validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
      {},
      {
        tools: [{ type: 'function', function: { name: 'lookup', parameters: schema, strict } }],
        messages: [],
      },
      'Gemini'
    ),
    true
  );
  assert.equal(errors.at(-1).status, 400);
  assert.equal(JSON.stringify(errors.at(-1)).includes('secret-value'), false);
}
assert.equal(
  validators.rejectUnsupportedResponsesNonOpenAIConversion(
    {},
    {
      tools: [{ type: 'function', name: 'lookup', parameters: schema, strict: true }],
      input: [],
    },
    'Gemini'
  ),
  true
);
assert.equal(
  validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    {
      tools: [{ type: 'function', function: { name: 'lookup', parameters: schema, strict: true } }],
      messages: [],
    },
    'Claude'
  ),
  false
);
console.log('function-tool-contract.test.js passed');
