'use strict';

const PROVIDER_CONTEXT_ITEM_TYPE = 'provider_context';
const PROVIDER_CONTEXT_PROVIDERS = new Set(['anthropic']);
const MAX_COMPACTION_FIELD_CHARS = 4 * 1024 * 1024;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidProviderContext() {
  const error = new TypeError('Invalid provider context history item');
  error.code = 'invalid_request_error';
  return error;
}

function nullableBoundedString(value, { empty = true } = {}) {
  if (value == null) return null;
  if (
    typeof value !== 'string' ||
    (!empty && value.length === 0) ||
    value.length > MAX_COMPACTION_FIELD_CHARS
  )
    throw invalidProviderContext();
  return value;
}

function normalizeAnthropicCompactionBlock(value) {
  if (
    !record(value) ||
    value.type !== 'compaction' ||
    Object.keys(value).some((key) => !['type', 'content', 'encrypted_content'].includes(key))
  )
    throw invalidProviderContext();
  const content = nullableBoundedString(value.content, { empty: false });
  const encryptedContent = nullableBoundedString(value.encrypted_content);
  return {
    type: 'compaction',
    content,
    encrypted_content: encryptedContent,
  };
}

function createAnthropicProviderContextItem(block, visibleOutputIndex = 0) {
  if (!Number.isSafeInteger(visibleOutputIndex) || visibleOutputIndex < 0)
    throw invalidProviderContext();
  return {
    type: PROVIDER_CONTEXT_ITEM_TYPE,
    provider: 'anthropic',
    visible_output_index: visibleOutputIndex,
    data: normalizeAnthropicCompactionBlock(block),
  };
}

function normalizeProviderContextItem(value) {
  if (
    !record(value) ||
    value.type !== PROVIDER_CONTEXT_ITEM_TYPE ||
    !PROVIDER_CONTEXT_PROVIDERS.has(value.provider) ||
    Object.keys(value).some(
      (key) => !['type', 'provider', 'visible_output_index', 'data'].includes(key)
    )
  )
    throw invalidProviderContext();
  if (!Number.isSafeInteger(value.visible_output_index) || value.visible_output_index < 0)
    throw invalidProviderContext();
  return createAnthropicProviderContextItem(value.data, value.visible_output_index);
}

function mergeProviderContextOutputItems(outputItems, providerContextItems) {
  const visible = Array.isArray(outputItems) ? outputItems : [];
  const hidden = (Array.isArray(providerContextItems) ? providerContextItems : []).map(
    normalizeProviderContextItem
  );
  if (hidden.some((item) => item.visible_output_index > visible.length))
    throw invalidProviderContext();
  const merged = [];
  for (let index = 0; index <= visible.length; index++) {
    merged.push(...hidden.filter((item) => item.visible_output_index === index));
    if (index < visible.length) merged.push(visible[index]);
  }
  return merged;
}

module.exports = {
  MAX_COMPACTION_FIELD_CHARS,
  PROVIDER_CONTEXT_ITEM_TYPE,
  createAnthropicProviderContextItem,
  invalidProviderContext,
  mergeProviderContextOutputItems,
  normalizeAnthropicCompactionBlock,
  normalizeProviderContextItem,
};
