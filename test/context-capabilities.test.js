'use strict';

const assert = require('assert');
const {
  CAPABILITY_PROFILES,
  normalizedProvider,
  resolveContextCapabilities,
  selectContextStrategy,
} = require('../lib/proxy/context-capabilities');

assert.equal(normalizedProvider('OpenAI Responses'), 'openai');
assert.equal(normalizedProvider('openai-codex'), 'openai-codex');
assert.equal(normalizedProvider('Codex'), 'openai-codex');
assert.equal(normalizedProvider('OpenAI-Compatible'), 'openai-compatible');
assert.equal(normalizedProvider('Anthropic Claude'), 'claude');
assert.equal(normalizedProvider('Google Gemini'), 'gemini');
assert.equal(normalizedProvider('Google Code Assist'), 'gemini-code-assist');
assert.equal(normalizedProvider('WorkBuddy Local'), 'workbuddy');
assert.equal(normalizedProvider(null), 'unknown');

assert.strictEqual(resolveContextCapabilities('openai'), CAPABILITY_PROFILES.openai);
assert.strictEqual(resolveContextCapabilities('openai-codex'), CAPABILITY_PROFILES['openai-codex']);
assert.strictEqual(
  resolveContextCapabilities('openai-compatible'),
  CAPABILITY_PROFILES['openai-compatible']
);
assert.strictEqual(
  resolveContextCapabilities('openai', {
    targetUrl: 'https://chatgpt.com/backend-api/codex',
  }),
  CAPABILITY_PROFILES['openai-codex']
);
assert.strictEqual(
  resolveContextCapabilities('openai', { targetUrl: 'https://compatible.example/v1' }),
  CAPABILITY_PROFILES['openai-compatible']
);
assert.equal(CAPABILITY_PROFILES.claude.nativeCompaction, true);
assert.equal(CAPABILITY_PROFILES.claude.exactTokenCount, true);
assert.strictEqual(
  resolveContextCapabilities('gemini', {
    targetUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
  }),
  CAPABILITY_PROFILES['gemini-code-assist']
);
assert.strictEqual(
  resolveContextCapabilities('gemini', {
    targetUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authMode: 'official-login',
    authProvider: 'google',
  }),
  CAPABILITY_PROFILES['gemini-code-assist']
);
assert.equal(selectContextStrategy(CAPABILITY_PROFILES.openai), 'local_semantic');
assert.equal(
  selectContextStrategy(CAPABILITY_PROFILES.openai, { nativeCompactionRequested: true }),
  'native_compaction'
);
assert.equal(
  selectContextStrategy(CAPABILITY_PROFILES.claude, { contextEditingRequested: true }),
  'context_editing'
);
assert.equal(
  selectContextStrategy(
    { nativeCompaction: false, contextEditing: false, localSemanticFallback: false },
    { nativeCompactionRequested: true }
  ),
  'reject'
);

assert.ok(Object.isFrozen(CAPABILITY_PROFILES));
assert.ok(Object.isFrozen(CAPABILITY_PROFILES.openai));

console.log('[context-capabilities.test] ok');
