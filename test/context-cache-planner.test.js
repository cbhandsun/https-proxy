'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { applyProviderCacheHintsToRequest } = require('../lib/proxy/context-cache-hints');
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

// JSON-owned schema/property names must survive canonicalization as data.
{
  const source = JSON.parse('{"__proto__":{"type":"string"},"text":"value"}');
  const before = JSON.stringify(source);
  assert.notEqual(stableHash(source), stableHash({ text: 'value' }));
  assert.notEqual(
    stableHash(JSON.parse('{"properties":{"__proto__":{"type":"string"}}}')),
    stableHash({ properties: {} })
  );
  assert.notEqual(
    stableHash(JSON.parse('{"__proto__":"first"}')),
    stableHash(JSON.parse('{"__proto__":"second"}'))
  );
  assert.equal(JSON.stringify(source), before);
  assert.equal(Object.getPrototypeOf(source), Object.prototype);
  assert.equal(Object.prototype.type, undefined);
  const expected = createHash('sha256').update(before).digest('hex').slice(0, 16);
  assert.equal(stableHash(source), expected);
  const reordered = JSON.parse('{"text":"value","__proto__":{"type":"string"}}');
  assert.equal(stableHash(source), stableHash(reordered));
  const nullPrototype = Object.assign(Object.create(null), source);
  assert.equal(stableHash(source), stableHash(nullPrototype));
  assert.notEqual(stableHash([source]), stableHash([{ text: 'value' }]));
  assert.notEqual(
    stableHash(JSON.parse('{"constructor":{"prototype":{"text":"first"}}}')),
    stableHash(JSON.parse('{"constructor":{"prototype":{"text":"second"}}}'))
  );
  const firstPlan = createContextCachePlan([], {
    fixedPrefixTokens: 2048,
    fixedPrefixValue: source,
  });
  const secondPlan = createContextCachePlan([], {
    fixedPrefixTokens: 2048,
    fixedPrefixValue: { text: 'value' },
  });
  const requests = [firstPlan, secondPlan].map((contextCache) => {
    const request = {};
    applyProviderCacheHintsToRequest(
      request,
      'openai',
      { contextBudget: { contextCache } },
      {
        providerCacheHintsPolicy: 'experimental-openai-prompt-cache-key',
      }
    );
    return request;
  });
  assert.notEqual(requests[0].prompt_cache_key, requests[1].prompt_cache_key);
  assert.match(requests[0].prompt_cache_key, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(requests).includes('value'), false);
}

{
  assert.equal(
    stableHash({ b: 1, a: 2 }),
    createHash('sha256').update('{"a":2,"b":1}').digest('hex').slice(0, 16)
  );
  assert.equal(
    stableHash({ __hpmDiagnostics: { content: 'ignored' }, a: 2 }),
    stableHash({ a: 2 })
  );
  for (const value of [null, '', 0, false, [], {}, { array: new Array(4) }, 9n])
    assert.match(stableHash(value), /^[a-f0-9]{16}$/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.match(stableHash(cyclic), /^[a-f0-9]{16}$/);
  let deep = 'text';
  for (let index = 0; index < 64; index++) deep = { child: deep };
  assert.match(stableHash(deep), /^[a-f0-9]{16}$/);
  const failure = new Error('synthetic failure');
  assert.throws(
    () =>
      stableHash({
        get value() {
          throw failure;
        },
      }),
    (error) => error === failure
  );
}
console.log('[context-cache-planner.test] ok');
