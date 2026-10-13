'use strict';

const CAPABILITY_PROFILES = Object.freeze({
  openai: Object.freeze({
    provider: 'openai',
    nativeCompaction: true,
    exactTokenCount: true,
    contextEditing: false,
    promptCaching: true,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
  claude: Object.freeze({
    provider: 'claude',
    nativeCompaction: true,
    exactTokenCount: true,
    contextEditing: true,
    promptCaching: true,
    toolDiscovery: true,
    localSemanticFallback: true,
  }),
  'openai-codex': Object.freeze({
    provider: 'openai-codex',
    nativeCompaction: false,
    exactTokenCount: false,
    contextEditing: false,
    promptCaching: true,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
  'openai-compatible': Object.freeze({
    provider: 'openai-compatible',
    nativeCompaction: false,
    exactTokenCount: false,
    contextEditing: false,
    promptCaching: false,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
  gemini: Object.freeze({
    provider: 'gemini',
    nativeCompaction: false,
    exactTokenCount: true,
    contextEditing: false,
    promptCaching: true,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
  'gemini-code-assist': Object.freeze({
    provider: 'gemini-code-assist',
    nativeCompaction: false,
    exactTokenCount: false,
    contextEditing: false,
    promptCaching: true,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
  workbuddy: Object.freeze({
    provider: 'workbuddy',
    nativeCompaction: false,
    exactTokenCount: false,
    contextEditing: false,
    promptCaching: false,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
  unknown: Object.freeze({
    provider: 'unknown',
    nativeCompaction: false,
    exactTokenCount: false,
    contextEditing: false,
    promptCaching: false,
    toolDiscovery: false,
    localSemanticFallback: true,
  }),
});

function normalizedProvider(value) {
  const provider = String(value || '')
    .trim()
    .toLowerCase();
  if (provider.includes('workbuddy')) return 'workbuddy';
  if (provider.includes('anthropic') || provider.includes('claude')) return 'claude';
  if (provider.includes('code assist') || provider.includes('code-assist'))
    return 'gemini-code-assist';
  if (provider.includes('google') || provider.includes('gemini')) return 'gemini';
  if (
    provider === 'codex' ||
    provider.includes('openai-codex') ||
    provider.includes('official codex') ||
    provider.includes('chatgpt codex')
  )
    return 'openai-codex';
  if (provider.includes('openai-compatible')) return 'openai-compatible';
  if (provider.includes('openai') || provider.includes('responses')) return 'openai';
  return 'unknown';
}

function resolveContextCapabilities(provider, options = {}) {
  const normalized = normalizedProvider(provider);
  if (normalized === 'gemini') {
    let parsed;
    try {
      parsed = new URL(String(options.targetUrl || ''));
    } catch {
      parsed = null;
    }
    if (
      options.authMode === 'official-login' ||
      options.authProvider === 'google' ||
      parsed?.hostname === 'daily-cloudcode-pa.googleapis.com'
    )
      return CAPABILITY_PROFILES['gemini-code-assist'];
  }
  if (normalized !== 'openai')
    return CAPABILITY_PROFILES[normalized] || CAPABILITY_PROFILES.unknown;
  let parsed;
  try {
    parsed = new URL(String(options.targetUrl || ''));
  } catch {
    parsed = null;
  }
  if (parsed?.hostname === 'chatgpt.com' && /\/backend-api(?:\/|$)/i.test(parsed.pathname)) {
    return CAPABILITY_PROFILES['openai-codex'];
  }
  if (parsed && parsed.hostname !== 'api.openai.com') {
    return CAPABILITY_PROFILES['openai-compatible'];
  }
  return CAPABILITY_PROFILES.openai;
}

function selectContextStrategy(capabilities, options = {}) {
  const resolved = capabilities || CAPABILITY_PROFILES.unknown;
  if (options.nativeCompactionRequested && resolved.nativeCompaction) return 'native_compaction';
  if (options.contextEditingRequested && resolved.contextEditing) return 'context_editing';
  return resolved.localSemanticFallback ? 'local_semantic' : 'reject';
}

module.exports = {
  CAPABILITY_PROFILES,
  normalizedProvider,
  resolveContextCapabilities,
  selectContextStrategy,
};
