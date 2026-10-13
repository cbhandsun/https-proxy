'use strict';

const assert = require('assert');
const {
  CONTEXT_CLASSES,
  classifyContextMessages,
  toolCallIds,
  toolResultIds,
} = require('../lib/proxy/context-classifier');

assert.deepStrictEqual(classifyContextMessages(null), {
  items: [],
  counts: {},
  recentCutoffIndex: 0,
});

const messages = [
  { role: 'system', content: 'immutable' },
  { role: 'user', content: 'old request' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'resolved', function: { name: 'read', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'resolved', content: 'old evidence' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'pending', name: 'write', input: {} }],
  },
  { role: 'user', content: 'middle request' },
  { role: 'assistant', content: 'middle response' },
  { role: 'user', content: 'latest request' },
];
const classified = classifyContextMessages(messages, { keepRecentUserTurns: 2 });
assert.equal(classified.items[0].contextClass, CONTEXT_CLASSES.IMMUTABLE_POLICY);
assert.equal(classified.items[1].contextClass, CONTEXT_CLASSES.DURABLE_STATE);
assert.equal(classified.items[3].contextClass, CONTEXT_CLASSES.EVICTABLE_EVIDENCE);
assert.equal(classified.items[4].contextClass, CONTEXT_CLASSES.RECENT_WORKING_SET);
assert.equal(classified.items[4].reason, 'unresolved_tool_call');
assert.equal(classified.items[5].contextClass, CONTEXT_CLASSES.RECENT_WORKING_SET);
assert.deepStrictEqual(classified.unresolvedCallIds, ['pending']);

const geminiCall = { role: 'assistant', content: [{ functionCall: { name: 'lookup' } }] };
const geminiResult = {
  role: 'user',
  content: [{ functionResponse: { name: 'lookup', response: { content: 'result' } } }],
};
assert.deepStrictEqual(toolCallIds(geminiCall), ['gemini-name:lookup']);
assert.deepStrictEqual(toolResultIds(geminiResult), ['gemini-name:lookup']);
assert.deepStrictEqual(
  classifyContextMessages(
    [geminiCall, geminiResult, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
    { keepRecentUserTurns: 1 }
  ).unresolvedCallIds,
  []
);

const checkpointClass = classifyContextMessages(
  [
    {
      role: 'user',
      content: '[HPM_CONTEXT_CHECKPOINT_V1]\n{"schema":"hpm.context.checkpoint","version":1}',
    },
    { role: 'user', content: 'middle' },
    { role: 'user', content: 'latest' },
  ],
  { keepRecentUserTurns: 1 }
);
assert.equal(checkpointClass.items[0].contextClass, CONTEXT_CLASSES.RECENT_WORKING_SET);
assert.equal(checkpointClass.items[0].reason, 'context_checkpoint');

assert.deepStrictEqual(toolCallIds({ content: [{ functionCall: { id: 'g1', name: 'lookup' } }] }), [
  'g1',
]);
assert.deepStrictEqual(toolResultIds({ content: [{ type: 'tool_result', tool_use_id: 'c1' }] }), [
  'c1',
]);

console.log('[context-classifier.test] ok');
