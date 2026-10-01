'use strict';

const assert = require('assert');
const {
  buildHistoricalContinuation,
  compactProtectedMessages,
  compactText,
} = require('../lib/proxy/workbuddy-context-summary');

assert.equal(compactText('short', 100, ''), 'short');

const protectedText = [
  'HEAD-POLICY',
  'irrelevant filler '.repeat(1000),
  '## Security constraints\nNever expose credentials. 必须保留安全规则。',
  'visualization chart rendering requirements',
  'more filler '.repeat(1000),
  'TAIL-CONTEXT',
].join('\n\n');
const compacted = compactText(protectedText, 1600, 'create a visualization chart');
assert.ok(compacted.length <= 1600);
assert.ok(compacted.startsWith('HEAD-POLICY'));
assert.ok(compacted.endsWith('TAIL-CONTEXT'));
assert.ok(compacted.includes('Never expose credentials'));
assert.ok(compacted.includes('visualization chart'));
assert.ok(compacted.includes('extractively compacted'));

const protectedMessages = [
  { role: 'system', content: 'system-head-' + 's'.repeat(5000) + '-system-tail' },
  { role: 'developer', content: 'developer-head-' + 'd'.repeat(5000) + '-developer-tail' },
  { role: 'user', content: 'unchanged-user' },
];
const protectedOriginal = JSON.stringify(protectedMessages);
const folded = compactProtectedMessages(protectedMessages, {
  maxTotalChars: 3000,
  query: 'developer task',
});
assert.equal(folded.changed, true);
assert.equal(folded.foldedCount, 2);
assert.ok(folded.finalBytes < folded.originalBytes);
assert.equal(folded.messages[2].content, 'unchanged-user');
assert.equal(
  JSON.stringify(protectedMessages),
  protectedOriginal,
  'protected input is not mutated'
);

const continuation = buildHistoricalContinuation([
  { role: 'system', content: 'policy is not copied into the history summary' },
  { role: 'user', content: 'Analyze the repository' },
  { role: 'assistant', content: 'I inspected the architecture.' },
  {
    role: 'assistant',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'private tool output is not copied' },
  { role: 'user', content: 'Implement the fix' },
  { role: 'assistant', content: 'Implementation started.' },
  { role: 'user', content: 'Continue' },
]);
assert.equal(continuation.role, 'system');
assert.ok(continuation.content.includes('Analyze the repository'));
assert.ok(continuation.content.includes('read_file'));
assert.ok(continuation.content.includes('Tool result'));
assert.ok(!continuation.content.includes('private tool output'));
assert.ok(!continuation.content.includes('policy is not copied'));

assert.equal(buildHistoricalContinuation(null), null);

console.log('[workbuddy-context-summary.test] ok');
