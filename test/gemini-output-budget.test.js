'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  resolveGeminiOutputBudget,
  outputTokenInteger,
} = require('../lib/proxy/gemini-output-budget');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { claudeMessagesToGemini } = createGeminiProtocol({
  filterClaudeCompatibleBlocks: (content) =>
    Array.isArray(content) ? content : [{ type: 'text', text: content }],
  isClaudeThinkingBlock: () => false,
});
const model = 'gemini-3.8-flash-tiered';

test('verified Code Assist preserves small requests and supports larger thinking budgets', () => {
  for (const [requestedTokens, expected] of [
    [256, 256],
    [16384, 16384],
    [65536, 32768],
    [200000, 32768],
    [undefined, 32768],
  ]) {
    const options = { codeAssist: true, requestedTokens };
    assert.equal(resolveGeminiOutputBudget({}, model, options).effectiveTokens, expected);
    assert.equal(
      resolveGeminiOutputBudget({}, model, { ...options, recovery: true }).effectiveTokens,
      requestedTokens === undefined ? 65536 : Math.min(requestedTokens, 65536)
    );
  }
});

test('unknown models and direct Gemini routes retain the conservative bound', () => {
  for (const [target, codeAssist] of [
    [model, false],
    ['gemini-4-flash', true],
    ['gemini-3.1-flash-image', true],
    ['gemini-3.6-flash', true],
  ]) {
    assert.equal(
      resolveGeminiOutputBudget({ max_tokens: 200000 }, target, { codeAssist }).effectiveTokens,
      8192
    );
    assert.equal(resolveGeminiOutputBudget({}, target, { codeAssist }).effectiveTokens, undefined);
  }
});

test('unknown input is coerced only from finite positive numbers and numeric strings', () => {
  for (const value of [
    null,
    undefined,
    true,
    false,
    [],
    {},
    [8192],
    Infinity,
    NaN,
    -1,
    0,
    0.9,
    'Infinity',
    '1e6',
    '1;secret',
    '',
  ]) {
    assert.equal(outputTokenInteger(value), undefined);
  }
  assert.equal(outputTokenInteger(' 16384 '), 16384);
  assert.equal(outputTokenInteger('2.9'), 2);
  assert.equal(outputTokenInteger(Number.MAX_VALUE), Number.MAX_SAFE_INTEGER);
});

test('wire budget and context reserve agree and client data cannot select verified capabilities', () => {
  const body = {
    max_tokens: 200000,
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'private prompt' }],
  };
  const snapshot = JSON.stringify(body);
  const request = claudeMessagesToGemini(body, model, { codeAssist: true });
  assert.equal(request.generationConfig.maxOutputTokens, 32768);
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.ok(request.__hpmDiagnostics.contextBudget.reservedTokens < 200000);
  assert.equal(request.__hpmDiagnostics.outputBudget.thinkingLevel, 'high');
  assert.equal(JSON.stringify(request).includes('outputBudget'), false);
  assert.equal(JSON.stringify(request.__hpmDiagnostics).includes('private prompt'), false);
  assert.equal(JSON.stringify(body), snapshot);
  assert.equal(
    claudeMessagesToGemini({ ...body, codeAssist: true }, model).generationConfig.maxOutputTokens,
    8192
  );
});
