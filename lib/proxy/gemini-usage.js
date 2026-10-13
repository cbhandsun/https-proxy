'use strict';

const MAX_TOKENS = 1000000000;

function tokenCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(MAX_TOKENS, Math.floor(number));
}

function geminiUsageToClaude(usage) {
  const value = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  const input = tokenCount(value.promptTokenCount) || 0;
  const visible = tokenCount(value.candidatesTokenCount) || 0;
  const reasoning = tokenCount(value.thoughtsTokenCount);
  const output = Math.min(MAX_TOKENS, visible + (reasoning || 0));
  const total = tokenCount(value.totalTokenCount);
  const cached = tokenCount(value.cachedContentTokenCount ?? value.cached_content_token_count) || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: Math.min(input, cached),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
    ...(total !== undefined
      ? { total_tokens: Math.max(total, Math.min(MAX_TOKENS, input + output)) }
      : {}),
  };
}

module.exports = { geminiUsageToClaude };
