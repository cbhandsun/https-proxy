'use strict';

const GEMINI_DEVELOPER_HOST = 'generativelanguage.googleapis.com';
const MAX_GEMINI_TOKEN_COUNT_DEPTH = 64;
const MAX_GEMINI_MODEL_CHARS = 256;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidGeminiTokenCount() {
  const error = new TypeError('Invalid Gemini token count request');
  error.code = 'invalid_request_error';
  return error;
}

function safeJsonValue(value, depth = 0, seen = new Set()) {
  if (depth > MAX_GEMINI_TOKEN_COUNT_DEPTH) throw invalidGeminiTokenCount();
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidGeminiTokenCount();
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw invalidGeminiTokenCount();
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw invalidGeminiTokenCount();
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalidGeminiTokenCount();
    safeJsonValue(child, depth + 1, seen);
  }
  seen.delete(value);
}

function normalizeGeminiModel(value) {
  const model = String(value || '').trim();
  const bare = model.replace(/^models\//, '');
  if (!bare || bare.length > MAX_GEMINI_MODEL_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bare))
    throw invalidGeminiTokenCount();
  return 'models/' + bare;
}

function parseTarget(target, profile) {
  if (target?.hostname) return String(target.hostname).toLowerCase();
  try {
    return new URL(String(profile?.targetUrl || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isNativeGeminiDeveloperTarget(profile, target, prepared = {}) {
  if (
    prepared?.authMode === 'official-login' ||
    prepared?.authProvider === 'google' ||
    profile?.authMode === 'official-login'
  )
    return false;
  return parseTarget(target, profile) === GEMINI_DEVELOPER_HOST;
}

function createGeminiCountTokensRequest(value = {}) {
  if (!record(value)) throw invalidGeminiTokenCount();
  const hasContents = Object.prototype.hasOwnProperty.call(value, 'contents');
  const hasRequest = Object.prototype.hasOwnProperty.call(value, 'generateContentRequest');
  if (hasContents === hasRequest) throw invalidGeminiTokenCount();
  const model = normalizeGeminiModel(value.model);
  let body;
  if (hasContents) {
    if (!Array.isArray(value.contents)) throw invalidGeminiTokenCount();
    safeJsonValue(value.contents);
    body = { contents: value.contents };
  } else {
    if (!record(value.generateContentRequest)) throw invalidGeminiTokenCount();
    safeJsonValue(value.generateContentRequest);
    body = { generateContentRequest: value.generateContentRequest };
  }
  return {
    model,
    path: '/v1beta/' + model + ':countTokens',
    body,
  };
}

function parseGeminiCountTokensResponse(value) {
  if (!record(value)) throw invalidGeminiTokenCount();
  const allowed = new Set([
    'totalTokens',
    'cachedContentTokenCount',
    'promptTokensDetails',
    'cacheTokensDetails',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidGeminiTokenCount();
  if (!Number.isSafeInteger(value.totalTokens) || value.totalTokens < 0)
    throw invalidGeminiTokenCount();
  if (
    value.cachedContentTokenCount != null &&
    (!Number.isSafeInteger(value.cachedContentTokenCount) || value.cachedContentTokenCount < 0)
  )
    throw invalidGeminiTokenCount();
  if (value.promptTokensDetails != null) safeJsonValue(value.promptTokensDetails);
  if (value.cacheTokensDetails != null) safeJsonValue(value.cacheTokensDetails);
  return {
    totalTokens: value.totalTokens,
    cachedContentTokenCount: value.cachedContentTokenCount || 0,
  };
}

module.exports = {
  GEMINI_DEVELOPER_HOST,
  MAX_GEMINI_MODEL_CHARS,
  createGeminiCountTokensRequest,
  invalidGeminiTokenCount,
  isNativeGeminiDeveloperTarget,
  normalizeGeminiModel,
  parseGeminiCountTokensResponse,
};
