'use strict';

const assert = require('node:assert/strict');
const {
  MAX_GEMINI_MODEL_CHARS,
  createGeminiCountTokensRequest,
  isNativeGeminiDeveloperTarget,
  normalizeGeminiModel,
  parseGeminiCountTokensResponse,
} = require('../lib/proxy/gemini-context-management');

assert.equal(normalizeGeminiModel('gemini-3.1-pro'), 'models/gemini-3.1-pro');
assert.equal(normalizeGeminiModel('models/gemini-3.1-pro'), 'models/gemini-3.1-pro');
assert.equal(
  isNativeGeminiDeveloperTarget({ targetUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
  true
);
assert.equal(
  isNativeGeminiDeveloperTarget(
    { targetUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    null,
    { authMode: 'official-login', authProvider: 'google' }
  ),
  false
);
assert.equal(
  isNativeGeminiDeveloperTarget({ targetUrl: 'https://gemini-compatible.example/v1beta' }),
  false
);

assert.deepEqual(
  createGeminiCountTokensRequest({
    model: 'gemini-3.1-pro',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  }),
  {
    model: 'models/gemini-3.1-pro',
    path: '/v1beta/models/gemini-3.1-pro:countTokens',
    body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
  }
);
assert.deepEqual(
  createGeminiCountTokensRequest({
    model: 'models/gemini-3.1-pro',
    generateContentRequest: { contents: [], systemInstruction: { parts: [{ text: 'system' }] } },
  }).body,
  {
    generateContentRequest: {
      contents: [],
      systemInstruction: { parts: [{ text: 'system' }] },
    },
  }
);
assert.deepEqual(
  parseGeminiCountTokensResponse({ totalTokens: 123, cachedContentTokenCount: 45 }),
  { totalTokens: 123, cachedContentTokenCount: 45 }
);
assert.deepEqual(parseGeminiCountTokensResponse({ totalTokens: 0 }), {
  totalTokens: 0,
  cachedContentTokenCount: 0,
});

for (const invalid of [
  {},
  { model: 'gemini', contents: [], generateContentRequest: {} },
  { model: 'gemini', contents: {} },
  { model: 'gemini', generateContentRequest: [] },
  { model: 'bad/model', contents: [] },
  { model: 'x'.repeat(MAX_GEMINI_MODEL_CHARS + 1), contents: [] },
]) {
  assert.throws(
    () => createGeminiCountTokensRequest(invalid),
    (error) => error.code === 'invalid_request_error'
  );
}
const cycle = {};
cycle.self = cycle;
assert.throws(() =>
  createGeminiCountTokensRequest({ model: 'gemini', generateContentRequest: cycle })
);
let deep = {};
for (let index = 0; index < 66; index++) deep = { child: deep };
assert.throws(() =>
  createGeminiCountTokensRequest({ model: 'gemini', generateContentRequest: deep })
);
for (const invalid of [
  null,
  {},
  { totalTokens: -1 },
  { totalTokens: 1.5 },
  { totalTokens: 1, cachedContentTokenCount: -1 },
  { totalTokens: 1, secret: 'no' },
]) {
  assert.throws(
    () => parseGeminiCountTokensResponse(invalid),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('secret')
  );
}

console.log('[gemini-context-management.test] ok');
