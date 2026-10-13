'use strict';

const LEGACY_OUTPUT_LIMIT = 8192;
// Verified against Google Code Assist generateContent and streamGenerateContent.
const CODE_ASSIST_OUTPUT_LIMIT = 65536;
const INITIAL_OUTPUT_LIMIT = 32768;

function outputTokenInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return undefined;
  return Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER);
}

function supportsCodeAssistOutputBudget(model, codeAssist) {
  return codeAssist === true && /^gemini-3\.[78]-flash(?:-tiered)?$/.test(String(model));
}

function resolveGeminiOutputBudget(body, model, options = {}) {
  const requested = outputTokenInteger(
    Object.hasOwn(options, 'requestedTokens') ? options.requestedTokens : body?.max_tokens
  );
  const supported = supportsCodeAssistOutputBudget(model, options.codeAssist);
  const limit = supported ? CODE_ASSIST_OUTPUT_LIMIT : LEGACY_OUTPUT_LIMIT;
  const attemptLimit = supported && options.recovery !== true ? INITIAL_OUTPUT_LIMIT : limit;
  const effective =
    requested === undefined
      ? supported
        ? attemptLimit
        : undefined
      : Math.min(requested, attemptLimit);
  return {
    requestedTokens: requested,
    effectiveTokens: effective,
    limitTokens: limit,
    source: supported ? 'code-assist-verified' : 'legacy-safe',
  };
}

module.exports = { outputTokenInteger, resolveGeminiOutputBudget, supportsCodeAssistOutputBudget };
