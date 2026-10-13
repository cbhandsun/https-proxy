'use strict';
const { parseOpenAIReasoningEffort, supportsGeminiThinkingLevel } = require('./reasoning-adapter');
const { validateConvertedRequestScalars } = require('./converted-request-scalars');
const { convertedServiceTier } = require('./converted-service-tier');
const { supportsGeminiThinkingBudget } = require('./gemini-thinking-contract');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const geminiReasoningSummary = Symbol('validatedGeminiReasoningSummary');
function invalidOptions(option = 'request') {
  const error = new TypeError(
    `Responses endpoint option "${option}" is invalid or unsupported by this conversion target`
  );
  error.code = 'invalid_request_error';
  error.option = option;
  throw error;
}
// Converted routes implement synchronous generation and local history. They do
// not implement OpenAI job retrieval, opaque reasoning encryption or token logprobs.
function validateResponsesEndpointOptions(source, target = 'Chat', model, options = {}) {
  if (!record(source) || !['Chat', 'Claude', 'Gemini'].includes(target)) invalidOptions('request');
  validateConvertedRequestScalars(source, target);
  convertedServiceTier(source.service_tier, 'openai', target);
  if (source.parallel_tool_calls != null && typeof source.parallel_tool_calls !== 'boolean')
    invalidOptions('parallel_tool_calls');
  if (!parseOpenAIReasoningEffort(source, options.reasoningEfforts).valid)
    invalidOptions('reasoning.effort');
  if (source.background != null && source.background !== false) invalidOptions('background');
  if (source.include != null && (!Array.isArray(source.include) || source.include.length !== 0))
    invalidOptions('include');
  if (source.stream_options != null) {
    const options = source.stream_options;
    if (
      !record(options) ||
      Object.keys(options).some((key) => key !== 'include_obfuscation') ||
      (Object.hasOwn(options, 'include_obfuscation') && options.include_obfuscation !== false)
    )
      invalidOptions('stream_options');
  }
  if (source.text != null) {
    if (
      !record(source.text) ||
      Object.keys(source.text).some((key) => !['format', 'verbosity'].includes(key))
    )
      invalidOptions('text');
    if (
      source.text.verbosity != null &&
      (target !== 'Chat' || !['low', 'medium', 'high'].includes(source.text.verbosity))
    )
      invalidOptions('text.verbosity');
  }
  if (source.reasoning != null) {
    const reasoning = source.reasoning;
    if (
      !record(reasoning) ||
      Object.keys(reasoning).some(
        (key) => !['effort', 'summary', 'generate_summary'].includes(key)
      ) ||
      (reasoning.summary != null &&
        reasoning.generate_summary != null &&
        reasoning.summary !== reasoning.generate_summary)
    )
      invalidOptions('reasoning');
    const summary = reasoning.summary ?? reasoning.generate_summary;
    if (summary != null) {
      const effort = parseOpenAIReasoningEffort(source, options.reasoningEfforts).effort;
      if (
        !['auto', 'concise', 'detailed'].includes(summary) ||
        target === 'Chat' ||
        (target === 'Claude' && !effort) ||
        effort === 'none' ||
        (target === 'Gemini' &&
          model != null &&
          !supportsGeminiThinkingLevel(model) &&
          !supportsGeminiThinkingBudget(model))
      )
        invalidOptions('reasoning.summary');
    }
  }
  if (
    source.metadata != null &&
    (!record(source.metadata) || Object.keys(source.metadata).length !== 0)
  )
    invalidOptions('metadata');
  for (const key of [
    'conversation',
    'max_tool_calls',
    'prompt_cache_key',
    'prompt_cache_retention',
    'safety_identifier',
  ])
    if (source[key] != null) invalidOptions(key);
  if (source.top_logprobs != null && source.top_logprobs !== 0) invalidOptions('top_logprobs');
  // The compatibility Chat compiler forwards the legacy user identifier. Native
  // Claude/Gemini have no equivalent identifier contract in this proxy.
  if (target !== 'Chat' && source.user != null) invalidOptions('user');
  if (source.user != null && typeof source.user !== 'string') invalidOptions('user');
  return source;
}

function applyResponsesEndpointOptions(config, source, target, model) {
  validateResponsesEndpointOptions(source, target, model);
  const summary = source.reasoning?.summary ?? source.reasoning?.generate_summary;
  if (summary != null) {
    if (target === 'Claude') config.thinking = { ...config.thinking, display: 'summarized' };
    else config[geminiReasoningSummary] = summary;
  }
  return config;
}
module.exports = {
  validateResponsesEndpointOptions,
  applyResponsesEndpointOptions,
  geminiReasoningSummary,
};
