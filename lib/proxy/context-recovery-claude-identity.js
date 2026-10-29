'use strict';

// Inputs have already passed the bounded JSON normalizer at the binding/map
// boundary. This projection is for equality only; never send it upstream.
// Claude Code moves cache breakpoints between user text/tool-result blocks and
// assistant tool-use blocks, including when preparing native compaction. It
// serializes a single user text block as a string. Other metadata is significant.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function validCache(cache) {
  return (
    record(cache) &&
    cache.type === 'ephemeral' &&
    Object.keys(cache).every((key) => ['type', 'ttl'].includes(key)) &&
    (!Object.hasOwn(cache, 'ttl') || ['5m', '1h'].includes(cache.ttl))
  );
}
function recoveryHistoryIdentity(protocol, item) {
  if (
    protocol !== 'claude' ||
    !['user', 'assistant'].includes(item.role) ||
    !Array.isArray(item.content)
  )
    return item;
  const content = item.content.map((block) => {
    if (
      !record(block) ||
      !(item.role === 'user'
        ? ['text', 'tool_result'].includes(block.type)
        : block.type === 'tool_use') ||
      !Object.hasOwn(block, 'cache_control') ||
      !validCache(block.cache_control)
    )
      return block;
    const result = { ...block };
    delete result.cache_control;
    return result;
  });
  const block = content[0];
  if (
    item.role === 'user' &&
    content.length === 1 &&
    record(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    Object.keys(block).every((key) => ['type', 'text'].includes(key))
  )
    return { ...item, content: block.text };
  return { ...item, content };
}

module.exports = { recoveryHistoryIdentity };
