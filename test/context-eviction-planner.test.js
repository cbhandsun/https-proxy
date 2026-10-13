'use strict';

const assert = require('assert');
const { CHECKPOINT_MARKER } = require('../lib/proxy/context-checkpoint');
const { planContextEviction } = require('../lib/proxy/context-eviction-planner');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');

const small = [{ role: 'user', content: 'hello' }];
const unchanged = planContextEviction(small, 1024);
assert.strictEqual(unchanged.messages, small);
assert.equal(unchanged.changed, false);
assert.equal(unchanged.fits, true);

const invalid = planContextEviction(null, -1);
assert.equal(invalid.fits, false);
assert.equal(invalid.diagnostics.reason, 'invalid_input');

const oldToolOutput = 'RAW-PRIVATE-TOOL-OUTPUT-' + 'x'.repeat(8000);
const messages = [
  { role: 'system', content: 'immutable-policy' },
  { role: 'user', content: 'old request ' + 'u'.repeat(3000) },
  {
    role: 'assistant',
    tool_calls: [{ id: 'resolved', function: { name: 'read', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'resolved', content: oldToolOutput },
  { role: 'user', content: 'middle request' },
  { role: 'assistant', content: 'middle progress' },
  { role: 'user', content: 'latest request' },
];
const planned = planContextEviction(messages, 2500, {
  keepRecentUserTurns: 1,
  maxCheckpointChars: 1000,
});
assert.equal(planned.changed, true);
assert.equal(planned.fits, true);
assert.equal(planned.messages[0].content, 'immutable-policy');
assert.equal(JSON.stringify(planned.messages).includes(oldToolOutput), false);
assert.ok(planned.diagnostics.foldedEvidence > 0);
assert.equal(planned.diagnostics.checkpointStatus, 'validated');
assert.equal(planned.diagnostics.checkpointValid, true);
assert.equal(planned.diagnostics.stablePrefixPreserved, true);
assert.ok(planned.diagnostics.savedBytes > 0);
assert.ok(
  planned.messages.some((message) => String(message.content).startsWith(CHECKPOINT_MARKER))
);
assert.ok(planned.messages.some((message) => message.content === 'latest request'));

const artifactStore = createContextArtifactStore();
const withArtifacts = planContextEviction(messages, 2500, {
  keepRecentUserTurns: 1,
  maxCheckpointChars: 1400,
  artifactStore,
  artifactOwner: 'owner',
  artifactScope: 'hcs_' + '3'.repeat(32),
});
assert.ok(withArtifacts.diagnostics.artifactsStored > 0);
assert.ok(JSON.stringify(withArtifacts.messages).includes('read_context_artifact'));
assert.equal(JSON.stringify(withArtifacts.messages).includes(oldToolOutput), false);

const unresolvedCall = {
  role: 'assistant',
  tool_calls: [{ id: 'pending', function: { name: 'write', arguments: '{}' } }],
};
const unresolved = planContextEviction(
  [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'old' },
    unresolvedCall,
    { role: 'assistant', content: 'filler-' + 'f'.repeat(4000) },
    { role: 'user', content: 'current' },
  ],
  100
);
assert.equal(unresolved.fits, false, 'protected working set may correctly exceed the budget');
assert.ok(unresolved.messages.includes(unresolvedCall), 'an unresolved tool call is never evicted');
assert.ok(unresolved.messages.some((message) => message.content === 'policy'));
assert.equal(unresolved.diagnostics.stablePrefixPreserved, true);

const cyclic = { role: 'tool', tool_call_id: 'cycle', content: [] };
cyclic.content.push(cyclic.content);
assert.doesNotThrow(() => planContextEviction([cyclic], 10));

const unavailable = planContextEviction(messages, 2500, {
  keepRecentUserTurns: 1,
  maxCheckpointChars: 32,
});
assert.equal(unavailable.fits, false);
assert.strictEqual(unavailable.messages, messages, 'failed checkpoint creation cannot erase state');
assert.equal(unavailable.diagnostics.reason, 'checkpoint_unavailable');

console.log('[context-eviction-planner.test] ok');
