'use strict';

const crypto = require('crypto');
const { estimateTokensForValue } = require('./inline-media');

const DEFAULT_CACHE_CANDIDATE_MIN_TOKENS = 1024;

function positiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function canonicalize(value, depth = 0) {
  if (depth > 32) return '[max-depth]';
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (typeof value !== 'object') return String(value);

  // Schema/property names such as __proto__ are JSON data, not prototype setters.
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (key.startsWith('__hpm')) continue;
    result[key] = canonicalize(value[key], depth + 1);
  }
  return result;
}

function stableHash(value) {
  const serialized = JSON.stringify(canonicalize(value));
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

function isStablePrefixMessage(message) {
  return message && (message.role === 'system' || message.role === 'developer');
}

function leadingStablePrefix(messages) {
  const prefix = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isStablePrefixMessage(message)) break;
    prefix.push(message);
  }
  return prefix;
}

function createContextCachePlan(messages, options = {}) {
  const estimate =
    typeof options.estimateMessageTokens === 'function'
      ? options.estimateMessageTokens
      : estimateTokensForValue;
  const fixedPrefixTokens = positiveInteger(options.fixedPrefixTokens);
  const fixedPrefixValue = options.fixedPrefixValue;
  const stablePrefixMessages = leadingStablePrefix(messages);
  const stablePrefixMessageTokens = stablePrefixMessages.reduce(
    (sum, message) => sum + estimate(message),
    0
  );
  const totalMessageTokens = Array.isArray(messages)
    ? messages.reduce((sum, message) => sum + estimate(message), 0)
    : 0;
  const stablePrefixTokens = fixedPrefixTokens + stablePrefixMessageTokens;
  const candidateMinTokens =
    positiveInteger(options.cacheCandidateMinTokens) || DEFAULT_CACHE_CANDIDATE_MIN_TOKENS;

  return {
    candidate: stablePrefixTokens >= candidateMinTokens,
    candidateMinTokens,
    stablePrefixHash:
      stablePrefixTokens > 0
        ? stableHash({
            fixedPrefixValue: fixedPrefixValue === undefined ? null : fixedPrefixValue,
            stablePrefixMessages,
          })
        : '',
    stablePrefixMessageCount: stablePrefixMessages.length,
    stablePrefixTokens,
    fixedPrefixTokens,
    dynamicTokens: Math.max(0, totalMessageTokens - stablePrefixMessageTokens),
  };
}

module.exports = {
  DEFAULT_CACHE_CANDIDATE_MIN_TOKENS,
  createContextCachePlan,
  leadingStablePrefix,
  stableHash,
};
