'use strict';

const assert = require('node:assert/strict');
const {
  MAX_COMPACTION_FIELD_CHARS,
  createAnthropicProviderContextItem,
  mergeProviderContextOutputItems,
  normalizeAnthropicCompactionBlock,
  normalizeProviderContextItem,
} = require('../lib/proxy/provider-context-history');

const block = { type: 'compaction', content: 'summary', encrypted_content: 'opaque' };
assert.deepEqual(normalizeAnthropicCompactionBlock(block), block);
assert.deepEqual(
  normalizeAnthropicCompactionBlock({
    type: 'compaction',
    content: null,
    encrypted_content: null,
  }),
  { type: 'compaction', content: null, encrypted_content: null }
);

const first = createAnthropicProviderContextItem(block, 0);
const last = createAnthropicProviderContextItem(
  { type: 'compaction', content: 'later', encrypted_content: null },
  2
);
assert.deepEqual(normalizeProviderContextItem(first), first);
assert.deepEqual(
  mergeProviderContextOutputItems([{ type: 'message' }, { type: 'function_call' }], [last, first]),
  [first, { type: 'message' }, { type: 'function_call' }, last]
);

for (const invalid of [
  null,
  {},
  { type: 'text', content: 'summary' },
  { type: 'compaction', content: '' },
  { type: 'compaction', content: 1 },
  { type: 'compaction', content: 'ok', encrypted_content: {} },
  { type: 'compaction', content: 'ok', secret: 'no' },
  { type: 'compaction', content: 'x'.repeat(MAX_COMPACTION_FIELD_CHARS + 1) },
]) {
  assert.throws(
    () => normalizeAnthropicCompactionBlock(invalid),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('secret')
  );
}
for (const invalid of [
  { ...first, provider: 'openai' },
  { ...first, visible_output_index: -1 },
  { ...first, visible_output_index: 1.5 },
  { ...first, secret: 'no' },
]) {
  assert.throws(() => normalizeProviderContextItem(invalid), /Invalid provider context/);
}
assert.throws(
  () => mergeProviderContextOutputItems([], [createAnthropicProviderContextItem(block, 1)]),
  /Invalid provider context/
);

console.log('[provider-context-history.test] ok');
