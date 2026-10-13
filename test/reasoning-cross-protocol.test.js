'use strict';

const assert = require('node:assert/strict');
const {
  extractCanonicalReasoning,
  applyReasoningToClaude,
  applyReasoningToOpenAI,
  budgetToEffort,
  effortToBudget,
  geminiThinkingConfigFromOpenAI,
} = require('../lib/proxy/reasoning-adapter');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');

console.log('Running Cross-Protocol Thinking/Reasoning Tests...');

// 1. Test Canonical Adapter Conversions
{
  assert.strictEqual(budgetToEffort(0), 'none');
  assert.strictEqual(budgetToEffort(1024), 'minimal');
  assert.strictEqual(budgetToEffort(2048), 'low');
  assert.strictEqual(budgetToEffort(4096), 'medium');
  assert.strictEqual(budgetToEffort(16384), 'high');
  assert.strictEqual(budgetToEffort(32768), 'xhigh');

  assert.strictEqual(effortToBudget('minimal'), 1024);
  assert.strictEqual(effortToBudget('low'), 2048);
  assert.strictEqual(effortToBudget('medium'), 4096);
  assert.strictEqual(effortToBudget('high'), 16384);
  assert.strictEqual(effortToBudget('xhigh'), 32768);

  // OpenAI direct
  const fromOAI = extractCanonicalReasoning({ reasoning_effort: 'high' });
  assert.deepStrictEqual(fromOAI, {
    present: true,
    valid: true,
    enabled: true,
    effort: 'high',
    budgetTokens: 16384,
  });

  // OpenAI nested
  const fromOAINested = extractCanonicalReasoning({ reasoning: { effort: 'low' } });
  assert.deepStrictEqual(fromOAINested, {
    present: true,
    valid: true,
    enabled: true,
    effort: 'low',
    budgetTokens: 2048,
  });

  // Claude thinking enabled
  const fromClaude = extractCanonicalReasoning({
    thinking: { type: 'enabled', budget_tokens: 4000 },
  });
  assert.deepStrictEqual(fromClaude, {
    present: true,
    valid: true,
    enabled: true,
    effort: 'medium',
    budgetTokens: 4000,
  });

  // Claude thinking disabled
  const fromClaudeOff = extractCanonicalReasoning({
    thinking: { type: 'disabled' },
  });
  assert.deepStrictEqual(fromClaudeOff, {
    present: true,
    valid: true,
    enabled: false,
    effort: 'none',
    budgetTokens: 0,
  });

  // Gemini thinkingConfig
  const fromGemini = extractCanonicalReasoning({
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
  });
  assert.deepStrictEqual(fromGemini, {
    present: true,
    valid: true,
    enabled: true,
    effort: 'high',
    budgetTokens: 16384,
  });

  // Direct applyReasoning helpers
  const claudeTest = { max_tokens: 2000, temperature: 0.5, top_p: 0.8 };
  applyReasoningToClaude(claudeTest, fromOAI);
  assert.deepStrictEqual(claudeTest.thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.strictEqual(claudeTest.temperature, 1.0);
  assert.strictEqual(claudeTest.top_p, undefined);
  assert.strictEqual(claudeTest.max_tokens, 20480);

  const oaiTest = { temperature: 0.7 };
  applyReasoningToOpenAI(oaiTest, fromClaude);
  assert.strictEqual(oaiTest.reasoning_effort, 'medium');
  assert.strictEqual(oaiTest.temperature, undefined);

  assert.deepStrictEqual(
    geminiThinkingConfigFromOpenAI(
      { thinking: { type: 'enabled', budget_tokens: 16384 } },
      'gemini-3.6-flash'
    ),
    { thinkingLevel: 'high' }
  );
}

// 2. Test openAIChatToClaudeMessages (OpenAI Chat Port -> Claude Upstream)
{
  const openaiProtocol = createOpenAIProtocol({
    cleanToolArgs: (name, args) => args,
    fallbackId: () => 'fallback-id',
    stableCreated: () => 123456,
    isClaudeThinkingBlock: () => false,
    filterClaudeCompatibleBlocks: (blocks) => blocks,
    normalizeClaudeContent: (c) => c,
    normalizeClaudeSystem: (s) => (s ? { parts: [{ text: s }] } : null),
    geminiToolResponseText: (t) => t,
    parseClaudeSseEvent: () => ({}),
    deltaPartialJson: () => '',
    protocolOptions: {},
  });

  // Scenario A: reasoning_effort='high' converts to Claude thinking with headroom & temp=1.0
  const claudeReqA = openaiProtocol.openAIChatToClaudeMessages(
    {
      model: 'claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'high',
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 20480,
    },
    'claude-3-7-sonnet'
  );

  assert.deepStrictEqual(claudeReqA.thinking, {
    type: 'enabled',
    budget_tokens: 16384,
  });
  assert.strictEqual(claudeReqA.temperature, 1.0);
  assert.strictEqual(claudeReqA.top_p, undefined);
  assert(
    claudeReqA.max_tokens > claudeReqA.thinking.budget_tokens,
    'max_tokens must exceed budget_tokens'
  );

  // Scenario B: reasoning_effort='none' converts to disabled
  const claudeReqB = openaiProtocol.openAIChatToClaudeMessages(
    {
      model: 'claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'none',
    },
    'claude-3-7-sonnet'
  );
  assert.deepStrictEqual(claudeReqB.thinking, { type: 'disabled' });

  // Scenario C: nested reasoning.effort
  const claudeReqC = openaiProtocol.openAIChatToClaudeMessages(
    {
      model: 'claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning: { effort: 'low' },
    },
    'claude-3-7-sonnet'
  );
  assert.deepStrictEqual(claudeReqC.thinking, {
    type: 'enabled',
    budget_tokens: 2048,
  });
}

// 3. Test claudeMessagesToOpenAIChat (Claude Port -> OpenAI Upstream)
{
  const openaiProtocol = createOpenAIProtocol({
    cleanToolArgs: (name, args) => args,
    fallbackId: () => 'fallback-id',
    stableCreated: () => 123456,
    isClaudeThinkingBlock: () => false,
    filterClaudeCompatibleBlocks: (blocks) => blocks,
    normalizeClaudeContent: (c) => (Array.isArray(c) ? c : [{ type: 'text', text: c }]),
    normalizeClaudeSystem: (s) => (s ? { parts: [{ text: s }] } : null),
    geminiToolResponseText: (t) => t,
    parseClaudeSseEvent: () => ({}),
    deltaPartialJson: () => '',
    protocolOptions: {},
  });

  // Scenario A: Claude thinking enabled -> OpenAI reasoning_effort, strips temperature
  const openAIReqA = openaiProtocol.claudeMessagesToOpenAIChat(
    {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'enabled', budget_tokens: 16384 },
      temperature: 0.7,
    },
    'gpt-5.5'
  );

  assert.strictEqual(openAIReqA.reasoning_effort, 'high');
  assert.strictEqual(openAIReqA.temperature, undefined);

  // Scenario B: Claude thinking disabled -> OpenAI reasoning_effort='none'
  const openAIReqB = openaiProtocol.claudeMessagesToOpenAIChat(
    {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'disabled' },
    },
    'gpt-5.5'
  );
  assert.strictEqual(openAIReqB.reasoning_effort, 'none');

  // Scenario C: No thinking specified -> reasoning_effort untouched
  const openAIReqC = openaiProtocol.claudeMessagesToOpenAIChat(
    {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.5,
    },
    'gpt-5.5'
  );
  assert.strictEqual(openAIReqC.reasoning_effort, undefined);
  assert.strictEqual(openAIReqC.temperature, 0.5);
}

// 4. Test claudeMessagesToGemini (Claude Port -> Gemini Upstream)
{
  const geminiProtocol = createGeminiProtocol({
    stableHash: () => 'hash',
    fallbackId: () => 'id',
    cleanToolArgs: () => ({}),
    geminiFunctionCallArgs: () => ({}),
    sanitizeGeminiToolCall: () => ({}),
    filterClaudeCompatibleBlocks: (b) =>
      Array.isArray(b) ? b : [{ type: 'text', text: String(b) }],
    normalizeClaudeContent: (c) => (Array.isArray(c) ? c : [{ type: 'text', text: c }]),
    normalizeClaudeSystem: (s) => (s ? { parts: [{ text: s }] } : null),
    isClaudeThinkingBlock: () => false,
    sampleGeminiToolEvent: () => {},
    deps: {},
  });

  const geminiReq = geminiProtocol.claudeMessagesToGemini(
    {
      model: 'gemini-3.6-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'enabled', budget_tokens: 16384 },
    },
    'gemini-3.6-flash'
  );

  assert.deepStrictEqual(geminiReq.generationConfig.thinkingConfig, {
    thinkingLevel: 'high',
  });
}

// 5. Test Request Validators (No 400 on valid reasoning targeting Claude)
{
  let errorResponse = null;
  const validators = createRequestValidators({
    sendJsonError(_clientRes, statusCode, payload) {
      errorResponse = { statusCode, payload };
    },
  });

  // Valid reasoning_effort to Claude should NOT be rejected
  const rejectedClaudeValid = validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    { reasoning_effort: 'medium' },
    'Claude'
  );
  assert.strictEqual(rejectedClaudeValid, false);
  assert.strictEqual(errorResponse, null);

  // Valid reasoning_effort to Gemini should NOT be rejected
  errorResponse = null;
  const rejectedGeminiValid = validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    { reasoning_effort: 'low' },
    'Gemini'
  );
  assert.strictEqual(rejectedGeminiValid, false);
  assert.strictEqual(errorResponse, null);

  // Invalid reasoning_effort to Claude SHOULD be rejected with 400
  errorResponse = null;
  const rejectedClaudeInvalid = validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    { reasoning_effort: 'extreme-bad-value' },
    'Claude'
  );
  assert.strictEqual(rejectedClaudeInvalid, true);
  assert.strictEqual(errorResponse.statusCode, 400);

  // Valid reasoning to an unsupported protocol (e.g. some third party) should reject
  errorResponse = null;
  const rejectedUnknown = validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    { reasoning_effort: 'high' },
    'CustomLegacyProtocol'
  );
  assert.strictEqual(rejectedUnknown, true);
  assert.strictEqual(errorResponse.statusCode, 400);
}

console.log('[reasoning-cross-protocol.test] ok');
