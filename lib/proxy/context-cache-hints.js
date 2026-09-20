'use strict';

const DEFAULT_PROVIDER_CACHE_HINTS_POLICY = 'diagnostics-only';
const PROVIDER_CACHE_HINTS_POLICIES = new Set([
  'disabled',
  DEFAULT_PROVIDER_CACHE_HINTS_POLICY,
  'experimental-openai-prompt-cache-key',
]);

function normalizeProviderCacheHintsPolicy(value) {
  if (value == null || value === '') return DEFAULT_PROVIDER_CACHE_HINTS_POLICY;
  const policy = String(value);
  return PROVIDER_CACHE_HINTS_POLICIES.has(policy) ? policy : DEFAULT_PROVIDER_CACHE_HINTS_POLICY;
}

function providerStrategy(provider) {
  switch (provider) {
    case 'openai':
      return 'automatic-stable-prefix';
    case 'anthropic':
      return 'cache-control-breakpoint';
    case 'gemini':
      return 'cached-content-resource';
    case 'workbuddy':
      return 'upstream-opaque';
    default:
      return 'unknown';
  }
}

function createProviderCacheHint(provider, contextCache, protocolOptions = {}) {
  const policy = normalizeProviderCacheHintsPolicy(protocolOptions.providerCacheHintsPolicy);
  const normalizedProvider = provider ? String(provider) : 'unknown';
  const cache = contextCache && typeof contextCache === 'object' ? contextCache : null;
  const candidate = !!(cache && cache.candidate === true);
  const stablePrefixHash = cache && cache.stablePrefixHash ? String(cache.stablePrefixHash) : '';
  const stablePrefixTokens = cache ? Number(cache.stablePrefixTokens || 0) : 0;
  const hint = {
    enabled: policy !== 'disabled',
    policy,
    provider: normalizedProvider,
    strategy: providerStrategy(normalizedProvider),
    candidate,
    applied: false,
    reason: '',
    stablePrefixHash,
    stablePrefixTokens,
  };
  if (policy === 'disabled') {
    hint.reason = 'disabled';
  } else if (!candidate) {
    hint.reason = 'below-threshold';
  } else if (!stablePrefixHash) {
    hint.reason = 'missing-stable-prefix-hash';
  } else {
    hint.reason = 'diagnostics-only';
  }
  return hint;
}

function applyProviderCacheHintsToRequest(request, provider, diagnostics, protocolOptions = {}) {
  const contextBudget =
    diagnostics && diagnostics.contextBudget && typeof diagnostics.contextBudget === 'object'
      ? diagnostics.contextBudget
      : null;
  const hint = createProviderCacheHint(
    provider,
    contextBudget ? contextBudget.contextCache : null,
    protocolOptions
  );
  if (diagnostics && typeof diagnostics === 'object') {
    diagnostics.providerCache = hint;
  }
  if (
    request &&
    typeof request === 'object' &&
    hint.policy === 'experimental-openai-prompt-cache-key' &&
    hint.provider === 'openai' &&
    hint.candidate &&
    hint.stablePrefixHash
  ) {
    request.prompt_cache_key = hint.stablePrefixHash;
    hint.applied = true;
    hint.reason = 'openai-prompt-cache-key';
  }
  return hint;
}

module.exports = {
  DEFAULT_PROVIDER_CACHE_HINTS_POLICY,
  PROVIDER_CACHE_HINTS_POLICIES,
  applyProviderCacheHintsToRequest,
  createProviderCacheHint,
  normalizeProviderCacheHintsPolicy,
};
