'use strict';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function budgetFamily(model) {
  const name =
    typeof model === 'string'
      ? model
          .replace(/^models\//i, '')
          .trim()
          .toLowerCase()
      : '';
  return name.match(/^gemini-2\.5-(pro|flash-lite|flash)(?:-preview(?:-\d+(?:-\d+)*)?)?$/)?.[1];
}
function supportsGeminiThinkingBudget(model) {
  return Boolean(budgetFamily(model));
}
function invalidThinking() {
  const error = new TypeError(
    'Requested thinking configuration cannot be preserved by this Gemini model'
  );
  error.code = 'invalid_request_error';
  throw error;
}
function geminiThinkingContract(canonical, model, source, constrainLevel) {
  if (!canonical?.present) return null;
  if (!canonical.valid) invalidThinking();
  if (!canonical.effort) return null;
  const name =
    typeof model === 'string'
      ? model
          .replace(/^models\//i, '')
          .trim()
          .toLowerCase()
      : '';
  const hasBudget =
    record(source?.thinking) &&
    source.thinking.type === 'enabled' &&
    Object.hasOwn(source.thinking, 'budget_tokens');
  if (
    hasBudget &&
    (!Number.isSafeInteger(source.thinking.budget_tokens) || source.thinking.budget_tokens <= 0)
  )
    invalidThinking();
  // Chat/Responses preparation can derive Claude-shaped thinking from a
  // relative effort. That generated budget is not a user-specified token cap.
  const absoluteBudget =
    hasBudget && source.reasoning_effort == null && source.reasoning?.effort == null;
  const family = budgetFamily(model);
  if (family) {
    if (!canonical.enabled) {
      if (family === 'pro') invalidThinking();
      return { thinkingBudget: 0 };
    }
    const minimum = family === 'pro' ? 128 : family === 'flash-lite' ? 512 : 1;
    const maximum = family === 'pro' ? 32768 : 24576;
    const budget = absoluteBudget ? source.thinking.budget_tokens : canonical.budgetTokens;
    if (!Number.isSafeInteger(budget) || budget < minimum || (absoluteBudget && budget > maximum))
      invalidThinking();
    return { thinkingBudget: Math.min(budget, maximum) };
  }
  const version = name.match(/^gemini-(\d+)(?:\.|-|$)/);
  if (version && Number(version[1]) >= 3) {
    // A minimum thinking level still permits reasoning; it cannot express none.
    if (!canonical.enabled) invalidThinking();
    return { thinkingLevel: constrainLevel(model, canonical.effort) };
  }
  invalidThinking();
}
module.exports = { geminiThinkingContract, supportsGeminiThinkingBudget };
