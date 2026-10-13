'use strict';

const assert = require('node:assert/strict');
const {
  parseResponsesHistory,
  chatHistoryToSemantic,
  semanticHistoryToChat,
  validateSemanticHistory,
} = require('../lib/proxy/responses-semantic-history');
const { responsesTargetOptions } = require('../lib/proxy/responses-target-options');
const deps = { fallbackId: () => 'generated' };
const rejects = (operation) =>
  assert.throws(operation, (error) => error.code === 'invalid_request_error');

const history = parseResponsesHistory(
  [
    { role: 'user', content: 'hello' },
    { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'result' },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'reason' }],
      encrypted_content: 'opaque',
    },
  ],
  deps,
  'instruction'
);
assert.equal(history[0].role, 'system');
assert.deepEqual(history[2].parts[0], {
  kind: 'call',
  id: 'call-1',
  name: 'lookup',
  args: { q: 'x' },
});
assert.equal(history[3].parts[0].id, 'call-1');
assert.equal(history[4].parts[0].encryptedContent, 'opaque');
const providerContext = parseResponsesHistory(
  [
    {
      type: 'provider_context',
      provider: 'anthropic',
      visible_output_index: 0,
      data: { type: 'compaction', content: 'summary', encrypted_content: 'opaque-context' },
    },
  ],
  deps
);
assert.deepEqual(providerContext[0].parts[0], {
  kind: 'provider_context',
  provider: 'anthropic',
  data: { type: 'compaction', content: 'summary', encrypted_content: 'opaque-context' },
});
assert.equal(validateSemanticHistory(providerContext), providerContext);
rejects(() => semanticHistoryToChat(providerContext));
assert.equal(validateSemanticHistory(history), history);
assert.deepEqual(parseResponsesHistory(null, deps), []);
assert.deepEqual(parseResponsesHistory('', deps), [
  { role: 'user', parts: [{ kind: 'text', text: '' }] },
]);
const compatible = history.slice(0, 4);
assert.deepEqual(chatHistoryToSemantic(semanticHistoryToChat(compatible), deps), compatible);

for (const args of [
  '{',
  '[]',
  'null',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{}}',
  { x: NaN },
  { x: Infinity },
  { x: () => {} },
  { x: new Date() },
]) {
  rejects(() =>
    parseResponsesHistory([{ type: 'function_call', name: 'lookup', arguments: args }], deps)
  );
}
const cycle = {};
cycle.self = cycle;
rejects(() =>
  parseResponsesHistory([{ type: 'function_call', name: 'lookup', arguments: cycle }], deps)
);
let deep = {};
for (let i = 0; i < 66; i++) deep = { child: deep };
rejects(() =>
  parseResponsesHistory([{ type: 'function_call', name: 'lookup', arguments: deep }], deps)
);
for (const tool_calls of [{}, 'invalid', 1])
  rejects(() => chatHistoryToSemantic([{ role: 'assistant', tool_calls }], deps));
rejects(() =>
  validateSemanticHistory([
    {
      role: 'user',
      parts: [
        {
          kind: 'result',
          id: 'id',
          error: false,
          parts: [{ kind: 'call', id: 'nested', name: 'lookup', args: {} }],
        },
      ],
    },
  ])
);
for (const input of [42, {}, [null], [{ role: 'unknown', content: '' }], [{ type: 'unknown' }]])
  rejects(() => parseResponsesHistory(input, deps));
rejects(() => parseResponsesHistory([], deps, {}));
assert.equal({}.polluted, undefined);

const tool = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } };
const options = responsesTargetOptions(
  { tools: [tool], tool_choice: { type: 'function', name: 'lookup' }, max_output_tokens: 123 },
  'model',
  'Claude'
);
assert.equal(options.max_tokens, 123);
assert.deepEqual(options.tool_choice, { type: 'tool', name: 'lookup' });
assert.deepEqual(options.tools[0].input_schema, tool.parameters);
assert.equal(responsesTargetOptions({}, 'model', 'Claude').max_tokens, 4096);
for (const tools of [{}, '', 1, [null], [[]], [{ type: 'namespace', tools: {} }]])
  rejects(() => responsesTargetOptions({ tools }, 'model', 'Claude'));
for (const source of [null, [], 1])
  rejects(() => responsesTargetOptions(source, 'model', 'Claude'));
const namespace = { type: 'namespace', tools: [] };
namespace.tools.push(namespace);
rejects(() => responsesTargetOptions({ tools: [namespace] }, 'model', 'Claude'));
rejects(() => responsesTargetOptions({ tools: Array(4097).fill(tool) }, 'model', 'Claude'));
rejects(() =>
  responsesTargetOptions(
    { tools: [tool], tool_choice: { type: 'function', name: 'missing' } },
    'model',
    'Claude'
  )
);
rejects(() => responsesTargetOptions({ tools: [{ ...tool, strict: true }] }, 'model', 'Gemini'));
rejects(() => responsesTargetOptions({ tools: [{ ...tool, parameters: [] }] }, 'model', 'Claude'));
rejects(() =>
  responsesTargetOptions({ input: [{ type: 'additional_tools', tools: {} }] }, 'model', 'Claude')
);
