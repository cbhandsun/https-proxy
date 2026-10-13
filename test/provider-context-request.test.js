'use strict';
const assert = require('node:assert/strict');
const {
  applyProviderContextHeaders,
  normalizeProviderContextRequest,
} = require('../lib/proxy/provider-context-request');

function prepared(body, profile = {}) {
  return { profile, buffer: Buffer.from(JSON.stringify(body)) };
}

const openai = normalizeProviderContextRequest(prepared({ model: 'gpt-test', input: [] }), {
  isResponsesRequest: true,
  target: { hostname: 'api.openai.com', path: '/v1' },
  protocolOptions: { openAICompactionThreshold: 250_000 },
});
assert.equal(JSON.parse(openai.buffer).context_management[0].compact_threshold, 250_000);
assert.equal(openai.contextManagement.provider, 'openai');
assert.equal(openai.bodyChanged, true);

const codexSource = prepared({ model: 'gpt-test', input: [] });
assert.equal(
  normalizeProviderContextRequest(codexSource, {
    isResponsesRequest: true,
    target: { hostname: 'chatgpt.com', path: '/backend-api/codex' },
  }),
  codexSource
);
const codexExplicit = prepared({
  model: 'gpt-test',
  input: [],
  context_management: [{ type: 'compaction' }],
});
assert.equal(
  normalizeProviderContextRequest(codexExplicit, {
    isResponsesRequest: true,
    target: { hostname: 'chatgpt.com', path: '/backend-api/codex' },
  }),
  codexExplicit,
  'the generic provider layer must not interpret OpenAI API options for Codex'
);

const claude = normalizeProviderContextRequest(prepared({ model: 'claude-test', messages: [] }), {
  isClaudeMessagesRequest: true,
  target: { hostname: 'api.anthropic.com', path: '/v1' },
});
assert.equal(JSON.parse(claude.buffer).context_management.edits[0].type, 'compact_20260112');
assert.equal(claude.contextManagement.provider, 'anthropic');
const headers = applyProviderContextHeaders(
  { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  claude
);
assert.equal(headers['anthropic-beta'], 'prompt-caching-2024-07-31,compact-2026-01-12');

const disabled = normalizeProviderContextRequest(prepared({ model: 'claude-test', messages: [] }), {
  isClaudeMessagesRequest: true,
  target: { hostname: 'api.anthropic.com', path: '/v1' },
  protocolOptions: { anthropicContextManagementPolicy: 'disabled' },
});
assert.equal(Object.hasOwn(JSON.parse(disabled.buffer), 'context_management'), false);
assert.equal(disabled.contextManagement.reason, 'disabled');

const compressed = prepared({ model: 'gpt-test', input: [] });
assert.equal(
  normalizeProviderContextRequest(compressed, {
    isResponsesRequest: true,
    requestEncoding: 'gzip',
  }),
  compressed
);
assert.throws(
  () =>
    normalizeProviderContextRequest(
      { profile: {}, buffer: Buffer.from('sensitive invalid json') },
      {
        isResponsesRequest: true,
        target: { hostname: 'api.openai.com', path: '/v1' },
      }
    ),
  (error) => error.code === 'invalid_request_error' && !error.message.includes('sensitive')
);
console.log('[provider-context-request.test] ok');
