'use strict';

// Only parsed requests create this capability. JSON marker keys cannot control
// persistence or bypass configured resource limits.
const responsesHistoryPolicy = Symbol('validatedResponsesHistoryPolicy');
function parseResponsesHistoryPolicy(source) {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    (source.store != null && typeof source.store !== 'boolean') ||
    (source.truncation != null && !['auto', 'disabled'].includes(source.truncation))
  ) {
    const error = new TypeError('Responses storage or truncation option is invalid');
    error.code = 'invalid_request_error';
    throw error;
  }
  return Object.freeze({ store: source.store !== false, truncation: source.truncation ?? null });
}
function applyResponsesHistoryPolicy(target, source) {
  target[responsesHistoryPolicy] = parseResponsesHistoryPolicy(source);
  return target;
}
function carryResponsesHistoryPolicy(target, source) {
  if (source?.[responsesHistoryPolicy])
    target[responsesHistoryPolicy] = source[responsesHistoryPolicy];
  return target;
}
function shouldStoreResponsesHistory(context) {
  return context?.[responsesHistoryPolicy]?.store !== false;
}
function preservesResponsesHistory(context) {
  return context?.[responsesHistoryPolicy]?.truncation === 'disabled';
}
function responsesTruncation(context) {
  return context?.[responsesHistoryPolicy]?.truncation ?? null;
}
module.exports = {
  applyResponsesHistoryPolicy,
  parseResponsesHistoryPolicy,
  shouldStoreResponsesHistory,
  preservesResponsesHistory,
  responsesTruncation,
  carryResponsesHistoryPolicy,
};
