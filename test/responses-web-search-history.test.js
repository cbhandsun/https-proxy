'use strict';

const assert = require('node:assert/strict');
const { parseResponsesHistory } = require('../lib/proxy/responses-semantic-history');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const deps = { ...require('../lib/proxy/tools'), fallbackId: () => 'fixture' };
const ai = createOpenAIProtocol(deps);
const gemini = createGeminiProtocol(deps);
const actions = [
  { type: 'search', query: '中文 😀' },
  {
    type: 'search',
    queries: ['first', 'second'],
    sources: [{ type: 'url', url: 'https://example.com/' }],
  },
  { type: 'open_page', url: 'https://example.com/' },
  { type: 'open_page', url: null },
  { type: 'find_in_page', url: 'https://example.com/', pattern: 'needle' },
];
for (const action of actions) {
  const input = [
    { role: 'user', content: 'start' },
    { type: 'web_search_call', action },
    { role: 'user', content: 'continue' },
  ];
  const snapshot = JSON.stringify(input);
  const history = parseResponsesHistory(input, deps);
  const text = history[1].parts[0].text;
  assert.equal(text, '[Web Search: ' + JSON.stringify(action) + ']');
  const chat = ai.openAIResponsesToChat({ input }, 'target');
  assert.equal(chat.messages[1].content, text);
  assert.ok(
    JSON.stringify(ai.responsesHistoryToClaude({}, { history }, 'target')).includes(
      JSON.stringify(text).slice(1, -1)
    )
  );
  assert.ok(
    JSON.stringify(
      gemini.responsesHistoryToGemini({}, { history }, 'gemini-2.5-pro').request
    ).includes(JSON.stringify(text).slice(1, -1))
  );
  assert.equal(JSON.stringify(input), snapshot);
}
for (const [fields, expected] of [
  [{}, 'search'],
  [{ query: 'legacy' }, 'legacy'],
  [{ arguments: '{"q":"old"}' }, 'old'],
  [{ arguments: { query: 'old' } }, 'old'],
]) {
  const input = [{ type: 'web_search_call', ...fields }];
  assert.equal(
    parseResponsesHistory(input, deps)[0].parts[0].text,
    '[Web Search: ' + expected + ']'
  );
  assert.equal(
    ai.openAIResponsesToChat({ input }, 'target').messages[0].content,
    '[Web Search: ' + expected + ']'
  );
}
for (const fields of [
  { action: [] },
  { action: {} },
  { action: { type: 'unknown', query: 'PRIVATE' } },
  { action: { type: 'search', unknown: 'PRIVATE' } },
  { action: { type: 'search', queries: 'wrong' } },
  { action: { type: 'search', queries: [1] } },
  { action: { type: 'search', query: 'x'.repeat(65537) } },
  { action: { type: 'search', queries: Array(129).fill('q') } },
  { action: { type: 'search', queries: Array(128).fill('x'.repeat(3000)) } },
  { action: { type: 'search', sources: [{ type: 'url', url: 'data:text/plain;base64,PRIVATE' }] } },
  { action: { type: 'open_page', url: 1 } },
  { action: { type: 'find_in_page', url: 'https://example.com/' } },
  { arguments: '{PRIVATE' },
  { query: {} },
  { arguments: JSON.parse('{"__proto__":{"PRIVATE":true}}') },
]) {
  for (const convert of [
    () => parseResponsesHistory([{ type: 'web_search_call', ...fields }], deps),
    () => ai.openAIResponsesToChat({ input: [{ type: 'web_search_call', ...fields }] }, 'target'),
  ])
    assert.throws(
      convert,
      (error) => error.code === 'invalid_request_error' && !error.message.includes('PRIVATE')
    );
}
assert.equal({}.PRIVATE, undefined);
let getterCalls = 0;
const hostile = Object.defineProperty({}, 'query', {
  enumerable: true,
  get() {
    getterCalls++;
    throw new Error('PRIVATE');
  },
});
for (const fields of [{ action: hostile }, { arguments: hostile }])
  assert.throws(
    () => parseResponsesHistory([{ type: 'web_search_call', ...fields }], deps),
    (error) => error.code === 'invalid_request_error'
  );
assert.equal(getterCalls, 0);
assert.equal(
  parseResponsesHistory(
    [{ type: 'web_search_call', action: { type: 'search', queries: [] } }],
    deps
  )[0].parts[0].text,
  '[Web Search: {"type":"search","queries":[]}]'
);
