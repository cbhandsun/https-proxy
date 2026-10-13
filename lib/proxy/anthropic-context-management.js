'use strict';

const ANTHROPIC_CONTEXT_MANAGEMENT_BETAS = Object.freeze({
  compaction: 'compact-2026-01-12',
  editing: 'context-management-2025-06-27',
});
const DEFAULT_ANTHROPIC_COMPACTION_TRIGGER = 150_000;
const MIN_ANTHROPIC_COMPACTION_TRIGGER = 50_000;
const MAX_ANTHROPIC_CONTEXT_TOKENS = 10_000_000;
const ANTHROPIC_CONTEXT_MANAGEMENT_POLICIES = new Set(['disabled', 'auto']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid() {
  const error = new TypeError('Invalid Anthropic context management options');
  error.code = 'invalid_request_error';
  error.param = 'context_management';
  return error;
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}

function tokenCondition(value, minimum = 1) {
  if (!record(value) || value.type !== 'input_tokens') throw invalid();
  if (Object.keys(value).some((key) => !['type', 'value'].includes(key))) throw invalid();
  return {
    type: 'input_tokens',
    value: integer(value.value, minimum, MAX_ANTHROPIC_CONTEXT_TOKENS),
  };
}

function toolUsesCondition(value) {
  if (!record(value) || value.type !== 'tool_uses') throw invalid();
  if (Object.keys(value).some((key) => !['type', 'value'].includes(key))) throw invalid();
  return { type: 'tool_uses', value: integer(value.value, 1, 100_000) };
}

function safeToolName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}

function normalizeCompaction(edit) {
  if (
    Object.keys(edit).some(
      (key) => !['type', 'trigger', 'pause_after_compaction', 'instructions'].includes(key)
    )
  )
    throw invalid();
  const result = { type: 'compact_20260112' };
  if (edit.trigger != null)
    result.trigger = tokenCondition(edit.trigger, MIN_ANTHROPIC_COMPACTION_TRIGGER);
  if (edit.pause_after_compaction != null) {
    if (typeof edit.pause_after_compaction !== 'boolean') throw invalid();
    result.pause_after_compaction = edit.pause_after_compaction;
  }
  if (edit.instructions != null) {
    if (typeof edit.instructions !== 'string' || edit.instructions.length > 32_000) throw invalid();
    result.instructions = edit.instructions;
  }
  return result;
}

function normalizeToolClearing(edit) {
  if (
    Object.keys(edit).some(
      (key) =>
        ![
          'type',
          'trigger',
          'keep',
          'clear_at_least',
          'exclude_tools',
          'clear_tool_inputs',
        ].includes(key)
    )
  )
    throw invalid();
  const result = { type: 'clear_tool_uses_20250919' };
  if (edit.trigger != null) {
    result.trigger =
      edit.trigger?.type === 'tool_uses'
        ? toolUsesCondition(edit.trigger)
        : tokenCondition(edit.trigger);
  }
  if (edit.keep != null) result.keep = toolUsesCondition(edit.keep);
  if (edit.clear_at_least != null) result.clear_at_least = tokenCondition(edit.clear_at_least);
  if (edit.exclude_tools != null) {
    if (
      !Array.isArray(edit.exclude_tools) ||
      edit.exclude_tools.length > 256 ||
      edit.exclude_tools.some((name) => !safeToolName(name))
    )
      throw invalid();
    result.exclude_tools = [...new Set(edit.exclude_tools)];
  }
  if (edit.clear_tool_inputs != null) {
    if (typeof edit.clear_tool_inputs !== 'boolean') throw invalid();
    result.clear_tool_inputs = edit.clear_tool_inputs;
  }
  return result;
}

function normalizeThinkingClearing(edit) {
  if (Object.keys(edit).some((key) => !['type', 'keep'].includes(key))) throw invalid();
  const result = { type: 'clear_thinking_20251015' };
  if (edit.keep === 'all') result.keep = 'all';
  else if (edit.keep != null) {
    if (!record(edit.keep) || edit.keep.type !== 'thinking_turns') throw invalid();
    if (Object.keys(edit.keep).some((key) => !['type', 'value'].includes(key))) throw invalid();
    result.keep = { type: 'thinking_turns', value: integer(edit.keep.value, 1, 100_000) };
  }
  return result;
}

function normalizeAnthropicContextManagement(value) {
  if (
    !record(value) ||
    !Array.isArray(value.edits) ||
    value.edits.length < 1 ||
    value.edits.length > 3
  )
    throw invalid();
  if (Object.keys(value).some((key) => key !== 'edits')) throw invalid();
  const seen = new Set();
  const edits = value.edits.map((edit) => {
    if (!record(edit) || typeof edit.type !== 'string' || seen.has(edit.type)) throw invalid();
    seen.add(edit.type);
    if (edit.type === 'compact_20260112') return normalizeCompaction(edit);
    if (edit.type === 'clear_tool_uses_20250919') return normalizeToolClearing(edit);
    if (edit.type === 'clear_thinking_20251015') return normalizeThinkingClearing(edit);
    throw invalid();
  });
  const thinkingIndex = edits.findIndex((edit) => edit.type === 'clear_thinking_20251015');
  if (thinkingIndex > 0) throw invalid();
  return { edits };
}

function contextManagementBetas(value) {
  const normalized = normalizeAnthropicContextManagement(value);
  const betas = new Set();
  for (const edit of normalized.edits) {
    if (edit.type === 'compact_20260112') betas.add(ANTHROPIC_CONTEXT_MANAGEMENT_BETAS.compaction);
    else betas.add(ANTHROPIC_CONTEXT_MANAGEMENT_BETAS.editing);
  }
  return { normalized, betas: [...betas] };
}

function defaultAnthropicContextManagement(options = {}) {
  const trigger =
    options.compactionTrigger == null
      ? DEFAULT_ANTHROPIC_COMPACTION_TRIGGER
      : integer(
          Number(options.compactionTrigger),
          MIN_ANTHROPIC_COMPACTION_TRIGGER,
          MAX_ANTHROPIC_CONTEXT_TOKENS
        );
  return {
    edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: trigger } }],
  };
}

function parseTarget(target, profile) {
  if (target && target.hostname) {
    return {
      hostname: String(target.hostname || '').toLowerCase(),
      path: String(target.path || target.pathname || '/'),
    };
  }
  try {
    const parsed = new URL(String(profile?.targetUrl || ''));
    return { hostname: parsed.hostname.toLowerCase(), path: parsed.pathname || '/' };
  } catch {
    return { hostname: '', path: '' };
  }
}

function isNativeAnthropicMessagesTarget(profile, target) {
  const resolved = parseTarget(target, profile);
  return resolved.hostname === 'api.anthropic.com' && !/\/openai(?:\/|$)/i.test(resolved.path);
}

function isAnthropicTokenCountPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return path === '/v1/messages/count_tokens' || path === '/messages/count_tokens';
}

function normalizeAnthropicContextManagementPolicy(value) {
  if (value == null || value === '') return 'auto';
  const policy = String(value).trim().toLowerCase();
  return ANTHROPIC_CONTEXT_MANAGEMENT_POLICIES.has(policy) ? policy : 'disabled';
}

function applyAnthropicContextManagement(request, options = {}) {
  if (!record(request)) throw invalid();
  const supported = isNativeAnthropicMessagesTarget(options.profile, options.target);
  const explicit = Object.prototype.hasOwnProperty.call(request, 'context_management');
  if (!supported) {
    return { applied: false, explicit, reason: 'unsupported-target', betas: [] };
  }
  if (explicit) {
    const result = contextManagementBetas(request.context_management);
    request.context_management = result.normalized;
    return { applied: false, explicit: true, reason: 'client-explicit', betas: result.betas };
  }
  const policy = normalizeAnthropicContextManagementPolicy(options.policy);
  if (policy === 'disabled') {
    return { applied: false, explicit: false, reason: 'disabled', betas: [] };
  }
  request.context_management = defaultAnthropicContextManagement(options);
  return {
    applied: true,
    explicit: false,
    reason: 'native-compaction',
    betas: [ANTHROPIC_CONTEXT_MANAGEMENT_BETAS.compaction],
  };
}

function mergeAnthropicBetaHeader(value, required = []) {
  const raw = Array.isArray(value) ? value.join(',') : value == null ? '' : String(value);
  const existing = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (existing.some((beta) => !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(beta))) throw invalid();
  return [...new Set([...existing, ...required])].join(',');
}

module.exports = {
  ANTHROPIC_CONTEXT_MANAGEMENT_POLICIES,
  ANTHROPIC_CONTEXT_MANAGEMENT_BETAS,
  DEFAULT_ANTHROPIC_COMPACTION_TRIGGER,
  MIN_ANTHROPIC_COMPACTION_TRIGGER,
  applyAnthropicContextManagement,
  contextManagementBetas,
  defaultAnthropicContextManagement,
  isAnthropicTokenCountPath,
  isNativeAnthropicMessagesTarget,
  mergeAnthropicBetaHeader,
  normalizeAnthropicContextManagement,
  normalizeAnthropicContextManagementPolicy,
};
