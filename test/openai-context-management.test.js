'use strict';
const assert = require('node:assert/strict');
const {
  applyOpenAIContextManagement,
  isNativeOpenAIResponsesTarget,
  isOpenAIInputTokensPath,
  normalizeOpenAIContextManagement,
} = require('../lib/proxy/openai-context-management');

const native = { target: { hostname: 'api.openai.com', path: '/v1' } };
assert.equal(isNativeOpenAIResponsesTarget({}, native.target), true);
assert.equal(
  isNativeOpenAIResponsesTarget({}, { hostname: 'chatgpt.com', path: '/backend-api/codex' }),
  false
);
assert.equal(isNativeOpenAIResponsesTarget({ targetUrl: 'https://third.example/v1' }), false);

const injected = { model: 'gpt-test', input: [], store: false };
assert.deepEqual(applyOpenAIContextManagement(injected, native), {
  applied: true,
  explicit: false,
  reason: 'native-compaction',
});
assert.deepEqual(injected.context_management, [{ type: 'compaction', compact_threshold: 200_000 }]);
assert.equal(injected.store, false);

const explicit = { context_management: [{ type: 'compaction', compact_threshold: 250_000 }] };
assert.equal(applyOpenAIContextManagement(explicit, native).reason, 'client-explicit');
assert.equal(explicit.context_management[0].compact_threshold, 250_000);

const disabled = {};
assert.equal(
  applyOpenAIContextManagement(disabled, { ...native, policy: 'disabled' }).reason,
  'disabled'
);
assert.equal(Object.hasOwn(disabled, 'context_management'), false);

const codex = {};
assert.equal(
  applyOpenAIContextManagement(codex, {
    target: { hostname: 'chatgpt.com', path: '/backend-api/codex' },
  }).reason,
  'unsupported-target'
);
assert.equal(Object.hasOwn(codex, 'context_management'), false);

for (const value of [
  null,
  {},
  [],
  [{ type: 'compaction' }, { type: 'compaction' }],
  [{ type: 'other' }],
  [{ type: 'compaction', compact_threshold: 31_999 }],
  [{ type: 'compaction', compact_threshold: 1.5 }],
  [{ type: 'compaction', compact_threshold: 200_000, secret: 'no' }],
]) {
  assert.throws(
    () => normalizeOpenAIContextManagement(value),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('secret')
  );
}

assert.equal(isOpenAIInputTokensPath('/v1/responses/input_tokens'), true);
assert.equal(isOpenAIInputTokensPath('/responses/input_tokens?x=1'), true);
assert.equal(isOpenAIInputTokensPath('/v1/responses'), false);
assert.equal(isOpenAIInputTokensPath('/v1/responses/input_tokens_extra'), false);
console.log('[openai-context-management.test] ok');
