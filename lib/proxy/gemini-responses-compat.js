'use strict';

const ENCRYPTED_REASONING_INCLUDE = 'reasoning.encrypted_content';
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;
const GEMINI_PROMPT_CACHE_RETENTIONS = new Set(['in-memory', 'in_memory', '24h']);
const GEMINI_REASONING_CONTEXTS = new Set(['auto', 'current_turn', 'all_turns']);
const GEMINI_TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const GEMINI_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
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

function normalizeGeminiResponsesRequest(source) {
  if (!record(source)) return source;
  let normalized = source;
  const writable = () => {
    if (normalized === source) normalized = { ...source };
    return normalized;
  };

  const codexCompatibilityEnvelope =
    Array.isArray(source.include) &&
    source.include.length === 1 &&
    source.include[0] === ENCRYPTED_REASONING_INCLUDE &&
    validPromptCacheKey(source.prompt_cache_key) &&
    record(source.reasoning) &&
    GEMINI_REASONING_CONTEXTS.has(source.reasoning.context) &&
    record(source.text) &&
    GEMINI_TEXT_VERBOSITIES.has(source.text.verbosity);

  if (
    Array.isArray(source.include) &&
    source.include.length === 1 &&
    source.include[0] === ENCRYPTED_REASONING_INCLUDE
  ) {
    delete writable().include;
  }
  if (validPromptCacheKey(source.prompt_cache_key)) delete writable().prompt_cache_key;
  if (GEMINI_PROMPT_CACHE_RETENTIONS.has(source.prompt_cache_retention)) {
    delete writable().prompt_cache_retention;
  }
  if (record(source.reasoning) && GEMINI_REASONING_CONTEXTS.has(source.reasoning.context)) {
    const reasoning = { ...source.reasoning };
    delete reasoning.context;
    if (Object.keys(reasoning).length === 0) delete writable().reasoning;
    else writable().reasoning = reasoning;
  }
  if (record(source.text) && GEMINI_TEXT_VERBOSITIES.has(source.text.verbosity)) {
    const text = { ...source.text };
    delete text.verbosity;
    if (Object.keys(text).length === 0) delete writable().text;
    else writable().text = text;
  }
  if (codexCompatibilityEnvelope && source.parallel_tool_calls === false) {
    delete writable().parallel_tool_calls;
  }
  return normalized;
}

function geminiResponsesOptionDiagnostics(source, normalized) {
  const sourceRecord = record(source) ? source : {};
  const normalizedRecord = record(normalized) ? normalized : {};
  const optionKeys = [
    'include',
    'parallel_tool_calls',
    'prompt_cache_key',
    'prompt_cache_retention',
    'reasoning',
    'text',
  ];
  const present = optionKeys.filter((key) => Object.hasOwn(sourceRecord, key));
  return {
    present,
    removed: present.filter((key) => !Object.hasOwn(normalizedRecord, key)),
    reasoningKeys: record(sourceRecord.reasoning)
      ? ['effort', 'summary', 'generate_summary', 'context'].filter((key) =>
          Object.hasOwn(sourceRecord.reasoning, key)
        )
      : [],
    reasoningEffort: GEMINI_REASONING_EFFORTS.has(sourceRecord.reasoning?.effort)
      ? sourceRecord.reasoning.effort
      : typeof sourceRecord.reasoning?.effort,
    reasoningContext: GEMINI_REASONING_CONTEXTS.has(sourceRecord.reasoning?.context)
      ? sourceRecord.reasoning.context
      : typeof sourceRecord.reasoning?.context,
    textKeys: record(sourceRecord.text)
      ? ['format', 'verbosity'].filter((key) => Object.hasOwn(sourceRecord.text, key))
      : [],
    textVerbosity: GEMINI_TEXT_VERBOSITIES.has(sourceRecord.text?.verbosity)
      ? sourceRecord.text.verbosity
      : typeof sourceRecord.text?.verbosity,
    parallelToolCalls:
      typeof sourceRecord.parallel_tool_calls === 'boolean'
        ? sourceRecord.parallel_tool_calls
        : typeof sourceRecord.parallel_tool_calls,
  };
}

function geminiResponsesConversionErrorDiagnostics(error, stage) {
  const frames = typeof error?.stack === 'string' ? error.stack.split(/\r?\n/).slice(1) : [];
  return {
    stage,
    errorCode:
      typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : typeof error?.code,
    errorName: ['Error', 'TypeError', 'RangeError'].includes(error?.name)
      ? error.name
      : typeof error?.name,
    frames: frames
      .map((frame) => frame.match(/[\\/]([^\\/:]+\.js):(\d+):(\d+)\)?$/))
      .filter(Boolean)
      .slice(0, 6)
      .map((match) => `${match[1]}:${match[2]}:${match[3]}`),
  };
}

module.exports = {
  ENCRYPTED_REASONING_INCLUDE,
  GEMINI_PROMPT_CACHE_RETENTIONS,
  GEMINI_REASONING_CONTEXTS,
  GEMINI_TEXT_VERBOSITIES,
  MAX_PROMPT_CACHE_KEY_LENGTH,
  geminiResponsesConversionErrorDiagnostics,
  geminiResponsesOptionDiagnostics,
  normalizeGeminiResponsesRequest,
};
