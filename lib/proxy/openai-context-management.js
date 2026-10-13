'use strict';

const DEFAULT_OPENAI_COMPACTION_THRESHOLD = 200_000;
const MIN_OPENAI_COMPACTION_THRESHOLD = 32_000;
const MAX_OPENAI_COMPACTION_THRESHOLD = 10_000_000;
const OPENAI_CONTEXT_MANAGEMENT_POLICIES = new Set(['disabled', 'auto']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidContextManagement() {
  const error = new TypeError('Invalid OpenAI context management options');
  error.code = 'invalid_request_error';
  error.param = 'context_management';
  return error;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw invalidContextManagement();
  }
  return numeric;
}

function normalizeOpenAIContextManagement(value) {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) {
    throw invalidContextManagement();
  }
  const entry = value[0];
  if (
    entry.type !== 'compaction' ||
    Object.keys(entry).some((key) => !['type', 'compact_threshold'].includes(key))
  ) {
    throw invalidContextManagement();
  }
  const normalized = { type: 'compaction' };
  if (entry.compact_threshold != null) {
    normalized.compact_threshold = boundedInteger(
      entry.compact_threshold,
      DEFAULT_OPENAI_COMPACTION_THRESHOLD,
      MIN_OPENAI_COMPACTION_THRESHOLD,
      MAX_OPENAI_COMPACTION_THRESHOLD
    );
  }
  return [normalized];
}

function normalizeOpenAIContextManagementPolicy(value) {
  if (value == null || value === '') return 'auto';
  const policy = String(value).trim().toLowerCase();
  return OPENAI_CONTEXT_MANAGEMENT_POLICIES.has(policy) ? policy : 'disabled';
}

function parseTarget(target, profile) {
  const source = target && target.hostname ? target : null;
  if (source) {
    return {
      hostname: String(source.hostname || '').toLowerCase(),
      path: String(source.path || source.pathname || '/'),
    };
  }
  try {
    const parsed = new URL(String(profile?.targetUrl || ''));
    return { hostname: parsed.hostname.toLowerCase(), path: parsed.pathname || '/' };
  } catch {
    return { hostname: '', path: '' };
  }
}

function isNativeOpenAIResponsesTarget(profile, target) {
  const resolved = parseTarget(target, profile);
  return (
    resolved.hostname === 'api.openai.com' &&
    !/\/backend-api(?:\/|$)/i.test(resolved.path) &&
    !/\/chat\/completions(?:\/|$)/i.test(resolved.path)
  );
}

function applyOpenAIContextManagement(request, options = {}) {
  if (!record(request)) throw invalidContextManagement();
  const supported = isNativeOpenAIResponsesTarget(options.profile, options.target);
  const explicit = Object.prototype.hasOwnProperty.call(request, 'context_management');
  if (explicit) {
    if (!supported && options.validateUnsupportedTarget !== true) {
      return { applied: false, explicit: true, reason: 'unsupported-target' };
    }
    request.context_management = normalizeOpenAIContextManagement(request.context_management);
    return { applied: false, explicit: true, reason: 'client-explicit' };
  }
  if (!supported) return { applied: false, explicit: false, reason: 'unsupported-target' };
  const policy = normalizeOpenAIContextManagementPolicy(options.policy);
  if (policy === 'disabled') return { applied: false, explicit: false, reason: 'disabled' };
  const compactThreshold = boundedInteger(
    options.compactThreshold,
    DEFAULT_OPENAI_COMPACTION_THRESHOLD,
    MIN_OPENAI_COMPACTION_THRESHOLD,
    MAX_OPENAI_COMPACTION_THRESHOLD
  );
  request.context_management = [{ type: 'compaction', compact_threshold: compactThreshold }];
  return { applied: true, explicit: false, reason: 'native-compaction' };
}

function isOpenAIInputTokensPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return path === '/v1/responses/input_tokens' || path === '/responses/input_tokens';
}

module.exports = {
  DEFAULT_OPENAI_COMPACTION_THRESHOLD,
  MIN_OPENAI_COMPACTION_THRESHOLD,
  MAX_OPENAI_COMPACTION_THRESHOLD,
  OPENAI_CONTEXT_MANAGEMENT_POLICIES,
  applyOpenAIContextManagement,
  isNativeOpenAIResponsesTarget,
  isOpenAIInputTokensPath,
  normalizeOpenAIContextManagement,
  normalizeOpenAIContextManagementPolicy,
};
