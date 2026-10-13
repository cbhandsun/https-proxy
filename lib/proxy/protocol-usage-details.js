'use strict';

function detailToken(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.min(1000000000, Math.floor(number))
    : undefined;
}

function convertUsageDetails(usage, toResponses) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {};
  const inputDetails = toResponses ? usage.prompt_tokens_details : usage.input_tokens_details;
  const outputDetails = toResponses ? usage.completion_tokens_details : usage.output_tokens_details;
  const cached = detailToken(usage.cached_input_tokens ?? inputDetails?.cached_tokens) || 0;
  const reasoning = detailToken(outputDetails?.reasoning_tokens ?? usage.reasoning_tokens);
  return {
    ...(cached > 0
      ? {
          cached_input_tokens: cached,
          [toResponses ? 'input_tokens_details' : 'prompt_tokens_details']: {
            cached_tokens: cached,
          },
        }
      : {}),
    ...(reasoning !== undefined
      ? {
          [toResponses ? 'output_tokens_details' : 'completion_tokens_details']: {
            reasoning_tokens: reasoning,
          },
        }
      : {}),
  };
}

function claudeUsageToOpenAIChatUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  // Native Claude input_tokens excludes both cached reads and cache creation.
  // Gemini's normalized Claude-shaped usage already includes cached input.
  const read = detailToken(usage.cache_read_input_tokens) || 0;
  const creation = detailToken(usage.cache_creation_input_tokens) || 0;
  const promptTokens = Math.min(
    1000000000,
    (detailToken(usage.input_tokens) || 0) + read + creation
  );
  const completionTokens = detailToken(usage.output_tokens) || 0;
  const cached = Math.min(
    promptTokens,
    detailToken(
      usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens
    ) || 0
  );
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      detailToken(usage.total_tokens) ?? Math.min(1000000000, promptTokens + completionTokens),
    cached_input_tokens: cached,
    ...convertUsageDetails({ ...usage, cached_input_tokens: cached }, false),
  };
}

function mergeClaudeStreamUsage(previous, incoming) {
  const result = {};
  for (const source of [previous, incoming]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of [
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'cached_input_tokens',
      'cachedInputTokens',
      'reasoning_tokens',
    ]) {
      const value = detailToken(source[key]);
      if (value !== undefined) result[key] = value;
    }
  }
  return result;
}

function claudeUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const input = Math.min(
    1000000000,
    (detailToken(usage.input_tokens) || 0) +
      (detailToken(usage.cache_read_input_tokens) || 0) +
      (detailToken(usage.cache_creation_input_tokens) || 0)
  );
  const output = detailToken(usage.output_tokens) || 0;
  const cached = Math.min(
    input,
    detailToken(
      usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens
    ) || 0
  );
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: detailToken(usage.total_tokens) ?? Math.min(1000000000, input + output),
    cached_input_tokens: cached,
    ...convertUsageDetails({ ...usage, cached_input_tokens: cached }, true),
  };
}

function openAIChatUsageToClaudeUsage(usage) {
  const prompt = detailToken(usage?.prompt_tokens) || 0;
  const output = detailToken(usage?.completion_tokens) || 0;
  const cached = Math.min(
    prompt,
    detailToken(usage?.cached_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens) || 0
  );
  return {
    input_tokens: prompt - cached,
    output_tokens: output,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

module.exports = {
  openAIChatUsageToClaudeUsage,
  convertUsageDetails,
  claudeUsageToOpenAIChatUsage,
  claudeUsageToResponsesUsage,
  mergeClaudeStreamUsage,
};
