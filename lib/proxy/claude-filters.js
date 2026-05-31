function createClaudeFilters(deps) {
  const { protocolOptions, makeSafeClaudeToolUseContentBlock } = deps;

  function shouldDropClaudeThinking() {
    return protocolOptions.thinkingPolicy !== 'placeholder';
  }

  function claudeThinkingPlaceholder(block) {
    return block && block.type === 'redacted_thinking' ? '[Claude redacted thinking omitted]' : '[Claude thinking omitted]';
  }

  function normalizeClaudeContent(content) {
    if (content == null) return [];
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (Array.isArray(content)) return content;
    return [content];
  }

  function isClaudeThinkingBlock(block) {
    return block && typeof block === 'object' && (block.type === 'thinking' || block.type === 'redacted_thinking');
  }

  function claudeThinkingToCompatibleText(block) {
    if (!isClaudeThinkingBlock(block)) return null;
    if (shouldDropClaudeThinking()) return null;
    return { type: 'text', text: claudeThinkingPlaceholder(block) };
  }

  function filterClaudeCompatibleBlocks(blocks) {
    return normalizeClaudeContent(blocks).map((block) => isClaudeThinkingBlock(block) ? claudeThinkingToCompatibleText(block) : block).filter(Boolean);
  }

  function filterClaudeToolUseBlock(block) {
    if (!block || block.type !== 'tool_use') return block;
    const safe = makeSafeClaudeToolUseContentBlock(block.id, block.name, block.input || {});
    if (safe.type === 'tool_use') return safe;
    return { type: 'text', text: safe.text };
  }

  function filterClaudeToolUseBlocks(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (Array.isArray(payload)) return payload.map(filterClaudeToolUseBlocks);
    if (payload.type === 'tool_use') return filterClaudeToolUseBlock(payload);

    const filtered = { ...payload };
    for (const key of Object.keys(filtered)) {
      if (key === 'content' && Array.isArray(filtered[key])) {
        filtered[key] = filtered[key].map(filterClaudeToolUseBlocks);
      } else if (filtered[key] && typeof filtered[key] === 'object') {
        filtered[key] = filterClaudeToolUseBlocks(filtered[key]);
      }
    }
    return filtered;
  }

  function filterClaudeJsonBody(body) {
    const parsed = JSON.parse(body);
    return JSON.stringify(filterClaudeToolUseBlocks(parsed));
  }

  return {
    shouldDropClaudeThinking,
    claudeThinkingPlaceholder,
    normalizeClaudeContent,
    isClaudeThinkingBlock,
    claudeThinkingToCompatibleText,
    filterClaudeCompatibleBlocks,
    filterClaudeToolUseBlock,
    filterClaudeToolUseBlocks,
    filterClaudeJsonBody,
  };
}

module.exports = { createClaudeFilters };
