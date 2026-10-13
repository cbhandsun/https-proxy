'use strict';
const assert = require('node:assert/strict');
const { applyContextBudgetToMessages } = require('../lib/proxy/context-budget-manager');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { fallbackId, stableHash, stableCreated } = require('../lib/proxy/ids');
const messages = [
  { role: 'user', content: 'old'.repeat(5000) },
  { role: 'assistant', content: 'old answer' },
  { role: 'user', content: 'current' },
];
for (const policy of ['disabled', 'overflow-drop-oldest']) {
  const protocolOptions = {
    contextWindowPolicy: policy,
    maxContextTokens: 3000,
    outputReserveTokens: 100,
    safetyMarginTokens: 100,
  };
  for (const preserved of [false, true]) {
    const body = preserved ? applyResponsesHistoryPolicy({}, { truncation: 'disabled' }) : {};
    const before = JSON.stringify(messages);
    const normal = applyContextBudgetToMessages(
      messages,
      body,
      'gemini-3.8-flash',
      protocolOptions
    );
    const reduced = applyContextBudgetToMessages(
      messages,
      body,
      'gemini-3.8-flash',
      protocolOptions,
      { includeCacheDiagnostics: false }
    );
    assert.deepEqual(reduced.messages, normal.messages);
    const left = { ...normal.diagnostics },
      right = { ...reduced.diagnostics };
    delete left.contextCache;
    delete right.contextCache;
    assert.deepEqual(right, left);
    assert.equal(reduced.diagnostics.contextCache, undefined);
    assert.ok(normal.diagnostics.contextCache);
    assert.equal(JSON.stringify(messages), before);
  }
  const external = applyContextBudgetToMessages(
    messages,
    { includeCacheDiagnostics: false },
    'gemini-3.8-flash',
    protocolOptions
  );
  assert.ok(
    external.diagnostics.contextCache,
    'A request JSON marker cannot disable final cache diagnostics'
  );
  const deps = {
    ...require('../lib/proxy/tools'),
    ...createClaudeFilters({ protocolOptions }),
    fallbackId,
    stableHash,
    stableCreated,
    protocolOptions,
  };
  const gemini = createGeminiProtocol(deps);
  const source = { messages: [{ role: 'user', content: 'question' }], max_tokens: 100 };
  const before = JSON.stringify(source);
  const result = gemini.tryOpenAIChatToGemini(source, 'gemini-3.8-flash');
  assert.equal(result.request.contents[0].parts[0].text, 'question');
  assert.equal(JSON.stringify(source), before);
  if (policy !== 'disabled') assert.ok(result.request.__hpmDiagnostics.contextBudget.contextCache);
  for (const invalid of [
    {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'call', function: { name: 'probe', arguments: 'SECRET malformed' } }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://not-inline.invalid/a' } }],
        },
      ],
    },
    {
      messages: [{ role: 'user', content: 'question' }],
      tools: [{ type: 'function', function: { name: 'probe', parameters: [] } }],
    },
    { messages: [{ role: 'user', content: 'question' }], max_tokens: 0 },
  ])
    assert.throws(
      () => gemini.tryOpenAIChatToGemini(invalid, 'gemini-3.8-flash'),
      (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
    );
}
const empty = applyContextBudgetToMessages(
  [],
  {},
  'gemini-3.8-flash',
  {},
  { includeCacheDiagnostics: false }
);
assert.deepEqual(empty.messages, []);
const failure = new Error('estimator failure');
assert.throws(
  () =>
    applyContextBudgetToMessages(
      [{ role: 'user', content: 'question' }],
      {},
      'gemini-3.8-flash',
      {},
      {
        includeCacheDiagnostics: false,
        estimateMessageTokens: () => {
          throw failure;
        },
      }
    ),
  (error) => error === failure
);
