'use strict';

const assert = require('node:assert/strict');
const {
  createContextCachePlan,
  leadingStablePrefix,
  stableHash,
} = require('../lib/proxy/context-cache-planner');

const messages = [
  { role: 'system', content: 'stable system instructions ' + 'S'.repeat(2000) },
  { role: 'developer', content: 'stable developer instructions' },
  { role: 'user', content: 'private current request' },
  { role: 'assistant', content: 'dynamic answer' },
];

{
  assert.deepEqual(leadingStablePrefix(messages), messages.slice(0, 2));
  assert.deepEqual(leadingStablePrefix([{ role: 'user', content: 'hello' }]), []);
}

{
  const plan = createContextCachePlan(messages, {
    fixedPrefixTokens: 800,
    fixedPrefixValue: [{ type: 'function', function: { name: 'read_file' } }],
    cacheCandidateMinTokens: 1000,
  });
  assert.equal(plan.candidate, true);
  assert.equal(plan.stablePrefixMessageCount, 2);
  assert.ok(plan.stablePrefixTokens >= 1000);
  assert.ok(plan.dynamicTokens > 0);
  assert.match(plan.stablePrefixHash, /^[a-f0-9]{16}$/);
  assert.ok(!JSON.stringify(plan).includes('private current request'));
}

{
  const first = createContextCachePlan(messages, {
    fixedPrefixTokens: 800,
    fixedPrefixValue: [{ type: 'function', function: { name: 'read_file' } }],
    cacheCandidateMinTokens: 1000,
  });
  const dynamicChanged = createContextCachePlan(
    [
      messages[0],
      messages[1],
      { role: 'user', content: 'different private request' },
      { role: 'assistant', content: 'different dynamic answer' },
    ],
    {
      fixedPrefixTokens: 800,
      fixedPrefixValue: [{ type: 'function', function: { name: 'read_file' } }],
      cacheCandidateMinTokens: 1000,
    }
  );
  const fixedChanged = createContextCachePlan(messages, {
    fixedPrefixTokens: 800,
    fixedPrefixValue: [{ type: 'function', function: { name: 'write_file' } }],
    cacheCandidateMinTokens: 1000,
  });
  assert.equal(dynamicChanged.stablePrefixHash, first.stablePrefixHash);
  assert.notEqual(fixedChanged.stablePrefixHash, first.stablePrefixHash);
}

{
  assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }));
  assert.notEqual(stableHash({ a: 2 }), stableHash({ a: 3 }));
}

console.log('[context-cache-planner.test] ok');
