'use strict';
const assert = require('node:assert/strict');
const {
  applyAnthropicContextManagement,
  contextManagementBetas,
  defaultAnthropicContextManagement,
  isNativeAnthropicMessagesTarget,
  mergeAnthropicBetaHeader,
  isAnthropicTokenCountPath,
  normalizeAnthropicContextManagement,
} = require('../lib/proxy/anthropic-context-management');

assert.deepEqual(defaultAnthropicContextManagement(), {
  edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 } }],
});
const managed = normalizeAnthropicContextManagement({
  edits: [
    { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } },
    {
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: 30_000 },
      keep: { type: 'tool_uses', value: 3 },
      clear_at_least: { type: 'input_tokens', value: 5_000 },
      exclude_tools: ['web_search', 'web_search'],
      clear_tool_inputs: false,
    },
  ],
});
assert.deepEqual(managed.edits[1].exclude_tools, ['web_search']);
assert.deepEqual(contextManagementBetas(managed).betas, ['context-management-2025-06-27']);
assert.deepEqual(contextManagementBetas({ edits: [{ type: 'compact_20260112' }] }).betas, [
  'compact-2026-01-12',
]);
const native = { target: { hostname: 'api.anthropic.com', path: '/v1' } };
assert.equal(isNativeAnthropicMessagesTarget({}, native.target), true);
assert.equal(
  isNativeAnthropicMessagesTarget({ targetUrl: 'https://api.anthropic.com:443/v1' }),
  true
);
assert.equal(isAnthropicTokenCountPath('/v1/messages/count_tokens'), true);
assert.equal(isAnthropicTokenCountPath('/messages/count_tokens?beta=true'), true);
assert.equal(isAnthropicTokenCountPath('/v1/messages/count_tokens_extra'), false);
assert.equal(isNativeAnthropicMessagesTarget({ targetUrl: 'https://third.example/v1' }), false);
const injected = { model: 'claude-test', messages: [] };
assert.deepEqual(applyAnthropicContextManagement(injected, native), {
  applied: true,
  explicit: false,
  reason: 'native-compaction',
  betas: ['compact-2026-01-12'],
});
assert.equal(injected.context_management.edits[0].type, 'compact_20260112');
const unsupported = {};
assert.equal(
  applyAnthropicContextManagement(unsupported, {
    target: { hostname: 'example.test', path: '/v1' },
  }).reason,
  'unsupported-target'
);
assert.equal(Object.hasOwn(unsupported, 'context_management'), false);
assert.equal(
  mergeAnthropicBetaHeader('prompt-caching-2024-07-31', ['compact-2026-01-12']),
  'prompt-caching-2024-07-31,compact-2026-01-12'
);
assert.throws(() => mergeAnthropicBetaHeader('bad beta', []), /Invalid Anthropic/);

for (const value of [
  null,
  {},
  { edits: [] },
  { edits: [{ type: 'unknown' }] },
  { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 49_999 } }] },
  { edits: [{ type: 'clear_tool_uses_20250919', exclude_tools: ['bad\nname'] }] },
  {
    edits: [{ type: 'clear_tool_uses_20250919' }, { type: 'clear_thinking_20251015' }],
  },
  { edits: [{ type: 'compact_20260112', secret: 'no' }] },
]) {
  assert.throws(
    () => normalizeAnthropicContextManagement(value),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('secret')
  );
}
console.log('[anthropic-context-management.test] ok');
