'use strict';

const assert = require('assert');
const {
  collectReferencedToolNames,
  planWorkBuddyWbipcRequest,
  selectWorkBuddyTools,
} = require('../lib/proxy/workbuddy-context-planner');

function tool(name, description = '') {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description } },
        required: ['query'],
      },
    },
  };
}

const small = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [tool('read_file', 'Read a file')],
};
const untouched = planWorkBuddyWbipcRequest(small);
assert.equal(untouched.changed, false);
assert.equal(untouched.fits, true);
assert.strictEqual(untouched.body, small);
assert.equal(untouched.diagnostics.preflightApplied, false);

const tools = Array.from({ length: 40 }, (_value, index) =>
  tool(
    index === 31 ? 'viz_render_chart' : `service_action_${index}`,
    index === 31
      ? 'Render a visualization chart from tabular data. '.repeat(100)
      : `Perform unrelated service operation ${index}. `.repeat(100)
  )
);
const referencedCall = {
  role: 'assistant',
  tool_calls: [
    {
      id: 'call_keep',
      type: 'function',
      function: { name: 'service_action_39', arguments: '{}' },
    },
  ],
};
const selected = selectWorkBuddyTools(
  tools,
  [
    { role: 'user', content: 'older request' },
    referencedCall,
    { role: 'user', content: 'Create a visualization chart' },
  ],
  { maxSelectedTools: 8 }
);
assert.equal(selected.changed, true);
assert.equal(selected.originalCount, 40);
assert.equal(selected.selectedCount, 8);
assert.ok(selected.tools.some((item) => item.function.name === 'service_action_0'));
assert.ok(selected.tools.some((item) => item.function.name === 'viz_render_chart'));
assert.ok(selected.tools.some((item) => item.function.name === 'service_action_39'));
assert.equal(tools.length, 40, 'tool selection does not mutate the catalog');

const referenced = collectReferencedToolNames([referencedCall]);
assert.deepStrictEqual([...referenced], ['service_action_39']);

const staleReferencedCall = {
  role: 'assistant',
  tool_calls: [
    {
      id: 'call_stale',
      type: 'function',
      function: { name: 'service_action_38', arguments: '{}' },
    },
  ],
};
const recentOnly = collectReferencedToolNames([
  staleReferencedCall,
  ...Array.from({ length: 12 }, () => ({ role: 'user', content: 'recent' })),
]);
assert.equal(
  recentOnly.has('service_action_38'),
  false,
  'stale tool calls do not pin tools forever'
);

const large = {
  model: 'deepseek-v4.1-flash',
  messages: [
    {
      role: 'system',
      content: 'policy-head-' + 'p'.repeat(500000) + '-policy-tail',
    },
    referencedCall,
    { role: 'user', content: 'Create a visualization chart' },
  ],
  tools,
};
const originalLarge = JSON.stringify(large);
const planned = planWorkBuddyWbipcRequest(large, {
  operationalInputTokens: 96 * 1024,
  preflightBodyBytes: 680 * 1024,
  targetBodyBytes: 384 * 1024,
  maxSelectedTools: 8,
});
assert.equal(planned.changed, true);
assert.equal(planned.fits, true);
assert.equal(planned.diagnostics.preflightApplied, true);
assert.ok(planned.diagnostics.finalBodyBytes <= 384 * 1024);
assert.ok(planned.diagnostics.finalEstimatedTokens <= 96 * 1024);
assert.ok(planned.diagnostics.selectedToolCount < planned.diagnostics.originalToolCount);
assert.ok(planned.diagnostics.finalToolsBytes < planned.diagnostics.originalToolsBytes);
assert.equal(planned.diagnostics.foldedProtectedMessages, 1);
assert.ok(planned.body.messages[0].content.startsWith('policy-head-'));
assert.ok(planned.body.messages[0].content.endsWith('-policy-tail'));
assert.ok(planned.body.tools.some((item) => item.function.name === 'viz_render_chart'));
assert.ok(planned.body.tools.some((item) => item.function.name === 'service_action_39'));
assert.equal(JSON.stringify(large), originalLarge, 'planning does not mutate the request');
assert.ok(!JSON.stringify(planned.diagnostics).includes('policy-head'));
assert.ok(!JSON.stringify(planned.diagnostics).includes('Create a visualization'));

const latestOversized = planWorkBuddyWbipcRequest(
  {
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'latest-' + 'x'.repeat(500000) }],
  },
  { force: true, targetBodyBytes: 128 * 1024, operationalInputTokens: 64 * 1024 }
);
assert.equal(latestOversized.changed, true);
assert.equal(latestOversized.fits, true);
assert.equal(latestOversized.diagnostics.foldedMessages, 1);

const impossible = planWorkBuddyWbipcRequest(
  {
    messages: [
      { role: 'system', content: 'fixed-' + 'z'.repeat(8000) },
      { role: 'user', content: 'latest' },
    ],
  },
  { force: true, targetBodyBytes: 1024, operationalInputTokens: 256 }
);
assert.equal(impossible.fits, false);

const invalid = planWorkBuddyWbipcRequest(null);
assert.equal(invalid.changed, false);
assert.equal(invalid.fits, false);
assert.equal(invalid.diagnostics.reason, 'invalid_body');

console.log('[workbuddy-context-planner.test] ok');
