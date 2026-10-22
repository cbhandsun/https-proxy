'use strict';

const { createOpenAIProtocol } = require('../../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../../lib/proxy/protocol-gemini');
const { createHash } = require('node:crypto');

// Real production conversion functions, with deterministic IDs and text-only
// normalization dependencies. Opaque and multimodal admission is tested rejected.
function recoveryConverters(protocolOptions = {}) {
  let id = 0;
  const deps = {
    cleanToolArgs: (_name, args) => args,
    fallbackId: (prefix) => prefix + '_' + ++id,
    stableCreated: () => 1700000000,
    isClaudeThinkingBlock: (block) => block?.type === 'thinking',
    filterClaudeCompatibleBlocks: (blocks) => blocks,
    normalizeClaudeContent: (content) =>
      typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    normalizeClaudeSystem: (system) => (system ? { parts: [{ text: system }] } : null),
    geminiToolResponseText: (content) => content,
    parseClaudeSseEvent: () => {
      throw new Error('Unexpected Claude SSE');
    },
    deltaPartialJson: (delta) => delta.partial_json || '',
    protocolOptions: { thinkingPolicy: 'passthrough', ...protocolOptions },
  };
  return {
    stableCreated: deps.stableCreated,
    ...createOpenAIProtocol(deps),
    createGeminiProtocol: () =>
      createGeminiProtocol({
        ...require('../../lib/proxy/tools'),
        ...deps,
        stableHash: (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        sampleGeminiToolEvent: () => {},
      }),
  };
}

module.exports = { recoveryConverters };
