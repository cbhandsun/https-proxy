'use strict';

const assert = require('node:assert/strict');
const {
  compactText,
  createConversationSummary,
  summaryToChatMessages,
} = require('../lib/proxy/context-summary');

{
  const compacted = compactText('a '.repeat(1000), 80);
  assert.ok(compacted.length <= 80);
  assert.ok(compacted.includes('[truncated]'));
}

{
  const summary = createConversationSummary([
    { role: 'user', content: 'Please inspect the current auth failure.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_log' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'Error: token expired' },
    { role: 'assistant', content: 'The token refresh failed.' },
  ]);
  assert.equal(summary.version, 1);
  assert.equal(summary.messageCount, 4);
  assert.match(summary.sourceHash, /^[a-f0-9]{16}$/);
  assert.ok(summary.facts.some((item) => item.includes('auth failure')));
  assert.ok(summary.toolArtifacts.includes('read_log'));
  assert.ok(summary.toolArtifacts.includes('result:call_1'));
  assert.ok(summary.text.length <= 1200);

  const messages = summaryToChatMessages(summary);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('Earlier conversation history was compacted'));
}

console.log('[context-summary.test] ok');
