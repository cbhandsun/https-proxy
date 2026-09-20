'use strict';

const assert = require('node:assert/strict');
const {
  applyProviderCacheHintsToRequest,
  createProviderCacheHint,
  normalizeProviderCacheHintsPolicy,
} = require('../lib/proxy/context-cache-hints');

const contextCache = {
  candidate: true,
  stablePrefixHash: 'abc123',
  stablePrefixTokens: 2048,
};

{
  const hint = createProviderCacheHint('openai', contextCache, {});
  assert.equal(hint.policy, 'diagnostics-only');
  assert.equal(hint.strategy, 'automatic-stable-prefix');
  assert.equal(hint.applied, false);
  assert.equal(hint.reason, 'diagnostics-only');
}

{
  const request = {};
  const diagnostics = { contextBudget: { contextCache } };
  const hint = applyProviderCacheHintsToRequest(request, 'openai', diagnostics, {});
  assert.equal(hint.applied, false);
  assert.equal(request.prompt_cache_key, undefined);
  assert.equal(diagnostics.providerCache.stablePrefixHash, 'abc123');
}

{
  const request = {};
  const diagnostics = { contextBudget: { contextCache } };
  const hint = applyProviderCacheHintsToRequest(request, 'openai', diagnostics, {
    providerCacheHintsPolicy: 'experimental-openai-prompt-cache-key',
  });
  assert.equal(hint.applied, true);
  assert.equal(request.prompt_cache_key, 'abc123');
}

{
  const hint = createProviderCacheHint('gemini', { candidate: false }, {});
  assert.equal(hint.strategy, 'cached-content-resource');
  assert.equal(hint.reason, 'below-threshold');
}

assert.equal(normalizeProviderCacheHintsPolicy('unknown'), 'diagnostics-only');
assert.equal(normalizeProviderCacheHintsPolicy('disabled'), 'disabled');

console.log('[context-cache-hints.test] ok');
