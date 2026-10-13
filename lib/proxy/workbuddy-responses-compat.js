'use strict';

const ENCRYPTED_REASONING_INCLUDE = 'reasoning.encrypted_content';
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;
const WORKBUDDY_PROMPT_CACHE_RETENTIONS = new Set(['in-memory', '24h']);
const WORKBUDDY_REASONING_CONTEXTS = new Set(['auto', 'current_turn', 'all_turns']);
const WORKBUDDY_REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);
const DIAGNOSTIC_OPTION_KEYS = [
  'background',
  'conversation',
  'include',
  'max_tool_calls',
  'metadata',
  'parallel_tool_calls',
  'prompt_cache_key',
  'prompt_cache_retention',
  'reasoning',
  'reasoning_effort',
  'safety_identifier',
  'service_tier',
  'stream_options',
  'text',
  'top_logprobs',
  'user',
];
const DIAGNOSTIC_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const DIAGNOSTIC_VERBOSITIES = new Set(['none', 'low', 'medium', 'high']);
const WORKBUDDY_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validPromptCacheKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PROMPT_CACHE_KEY_LENGTH &&
    !hasControlCharacter(value)
  );
}

function hasCompatibleReasoningSummary(reasoning) {
  if (!record(reasoning) || reasoning.effort == null || reasoning.effort === 'none') return false;
  const summary = reasoning.summary;
  const generated = reasoning.generate_summary;
  if (summary != null && !WORKBUDDY_REASONING_SUMMARIES.has(summary)) return false;
  if (generated != null && !WORKBUDDY_REASONING_SUMMARIES.has(generated)) return false;
  if (summary != null && generated != null && summary !== generated) return false;
  return summary != null || generated != null;
}

function normalizeWorkBuddyResponsesRequest(source) {
  if (!record(source)) return source;
  let normalized = source;
  const writable = () => {
    if (normalized === source) normalized = { ...source };
    return normalized;
  };

  if (
    Array.isArray(source.include) &&
    source.include.length === 1 &&
    source.include[0] === ENCRYPTED_REASONING_INCLUDE
  ) {
    delete writable().include;
  }

  if (validPromptCacheKey(source.prompt_cache_key)) delete writable().prompt_cache_key;

  if (WORKBUDDY_PROMPT_CACHE_RETENTIONS.has(source.prompt_cache_retention)) {
    delete writable().prompt_cache_retention;
  }

  const removeReasoningSummary = hasCompatibleReasoningSummary(source.reasoning);
  const removeReasoningContext =
    record(source.reasoning) && WORKBUDDY_REASONING_CONTEXTS.has(source.reasoning.context);
  if (removeReasoningSummary || removeReasoningContext) {
    const reasoning = { ...source.reasoning };
    if (removeReasoningSummary) {
      delete reasoning.summary;
      delete reasoning.generate_summary;
    }
    if (removeReasoningContext) delete reasoning.context;
    writable().reasoning = reasoning;
  }

  return normalized;
}

function workBuddyResponsesOptionDiagnostics(source, normalized) {
  const sourceRecord = record(source) ? source : {};
  const normalizedRecord = record(normalized) ? normalized : {};
  const present = DIAGNOSTIC_OPTION_KEYS.filter((key) => Object.hasOwn(sourceRecord, key));
  const retained = present.filter((key) => Object.hasOwn(normalizedRecord, key));
  const removed = present.filter((key) => !Object.hasOwn(normalizedRecord, key));
  const reasoningKeys = record(sourceRecord.reasoning)
    ? ['effort', 'summary', 'generate_summary', 'context'].filter((key) =>
        Object.hasOwn(sourceRecord.reasoning, key)
      )
    : [];
  const safeObjectKeys = (value) =>
    record(value)
      ? Object.keys(value)
          .filter((key) => /^[a-z][a-z0-9_]{0,31}$/.test(key))
          .slice(0, 16)
      : [];
  const streamOptionKeys = record(sourceRecord.stream_options)
    ? ['include_obfuscation'].filter((key) => Object.hasOwn(sourceRecord.stream_options, key))
    : [];
  const textKeys = record(sourceRecord.text)
    ? ['format', 'verbosity'].filter((key) => Object.hasOwn(sourceRecord.text, key))
    : [];
  const reasoningEffort = DIAGNOSTIC_REASONING_EFFORTS.has(sourceRecord.reasoning?.effort)
    ? sourceRecord.reasoning.effort
    : typeof sourceRecord.reasoning?.effort;
  const reasoningSummary = WORKBUDDY_REASONING_SUMMARIES.has(sourceRecord.reasoning?.summary)
    ? sourceRecord.reasoning.summary
    : typeof sourceRecord.reasoning?.summary;
  const reasoningContext = WORKBUDDY_REASONING_CONTEXTS.has(sourceRecord.reasoning?.context)
    ? sourceRecord.reasoning.context
    : typeof sourceRecord.reasoning?.context;
  const textVerbosity = DIAGNOSTIC_VERBOSITIES.has(sourceRecord.text?.verbosity)
    ? sourceRecord.text.verbosity
    : typeof sourceRecord.text?.verbosity;
  const parallelToolCalls =
    typeof sourceRecord.parallel_tool_calls === 'boolean'
      ? sourceRecord.parallel_tool_calls
      : typeof sourceRecord.parallel_tool_calls;
  return {
    present,
    retained,
    removed,
    reasoningKeys,
    reasoningAllKeys: safeObjectKeys(sourceRecord.reasoning),
    normalizedReasoningKeys: safeObjectKeys(normalizedRecord.reasoning),
    reasoningEffort,
    reasoningSummary,
    reasoningContext,
    streamOptionKeys,
    textKeys,
    textAllKeys: safeObjectKeys(sourceRecord.text),
    textVerbosity,
    parallelToolCalls,
  };
}

module.exports = {
  ENCRYPTED_REASONING_INCLUDE,
  MAX_PROMPT_CACHE_KEY_LENGTH,
  WORKBUDDY_PROMPT_CACHE_RETENTIONS,
  WORKBUDDY_REASONING_CONTEXTS,
  WORKBUDDY_REASONING_EFFORTS,
  WORKBUDDY_REASONING_SUMMARIES,
  normalizeWorkBuddyResponsesRequest,
  workBuddyResponsesOptionDiagnostics,
};
