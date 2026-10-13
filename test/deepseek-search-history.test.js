'use strict';
const assert = require('node:assert/strict');
const { normalizeDeepSeekSearchHistory } = require('../lib/proxy/deepseek-search-history');
const {
  preflightDeepSeekRequest,
  preflightDeepSeekResponsesBody,
} = require('../lib/proxy/deepseek-request-contract');
const base = {
  profile: { protocol: 'openai-responses', targetUrl: 'https://api.deepseek.com' },
  model: 'deepseek-flash',
  rewriteTo: '-',
};
const history = (action) => ({
  input: [
    { role: 'user', content: 'start' },
    { type: 'web_search_call', id: 'fixture', status: 'completed', action },
    { role: 'user', content: 'continue' },
  ],
});
for (const action of [
  { type: 'search', query: '中文 😀' },
  { type: 'search', query: '中文 😀', sources: [{ type: 'url', url: 'https://example.com/' }] },
  { type: 'search', query: '中文 😀', queries: ['中文 😀', 'second'] },
]) {
  const body = history(action);
  const before = JSON.stringify(body);
  const normalized = preflightDeepSeekResponsesBody(base, body);
  assert.notEqual(normalized, body);
  assert.deepEqual(normalized.input[1].action.queries, action.queries ?? [action.query]);
  assert.equal(Object.hasOwn(normalized.input[1].action, 'query'), false);
  assert.equal(normalized.input[1].id, 'fixture');
  assert.equal(normalized.input[1].status, 'completed');
  assert.deepEqual(normalized.input[1].action.sources, action.sources);
  assert.equal(JSON.stringify(body), before);
  const prepared = { ...base, buffer: Buffer.from(before) };
  preflightDeepSeekRequest(prepared, { requestPath: '/v1/responses' });
  assert.deepEqual(JSON.parse(prepared.buffer), normalized);
  assert.equal(prepared.bodyChanged, true);
}
for (const action of [
  { type: 'search', queries: ['first'] },
  { type: 'open_page', url: 'https://example.com/' },
]) {
  const body = history(action);
  assert.equal(preflightDeepSeekResponsesBody(base, body), body);
}
for (const body of [{}, { input: '' }, { input: [] }])
  assert.equal(preflightDeepSeekResponsesBody(base, body), body);
for (const scoped of [
  { ...base, model: 'future-model' },
  { ...base, profile: { ...base.profile, targetUrl: 'https://example.com' } },
]) {
  const body = history({ type: 'search', query: 'legacy' });
  assert.equal(preflightDeepSeekResponsesBody(scoped, body), body);
  const prepared = { ...scoped, buffer: Buffer.from(JSON.stringify(body)) };
  const original = prepared.buffer;
  preflightDeepSeekRequest(prepared, { requestPath: '/v1/responses' });
  assert.equal(prepared.buffer, original);
}
const forcedChat = {
  ...base,
  profile: { ...base.profile, protocol: 'openai-chat' },
  buffer: Buffer.from(JSON.stringify(history({ type: 'search', query: 'legacy' }))),
};
const original = forcedChat.buffer;
preflightDeepSeekRequest(forcedChat, { requestPath: '/v1/responses' });
assert.equal(forcedChat.buffer, original);
for (const action of [
  { type: 'search', query: 'PRIVATE', queries: ['other'] },
  { type: 'search', query: 'PRIVATE', queries: [] },
  { type: 'search', query: 1 },
  { type: 'search', queries: [null] },
  { type: 'search', query: 'x'.repeat(65537) },
  { type: 'search', queries: Array(129).fill('x') },
  { type: 'search', sources: [{ type: 'url', url: 'data:text/plain,PRIVATE' }] },
  JSON.parse('{"type":"search","__proto__":{"PRIVATE":true}}'),
])
  assert.throws(
    () => preflightDeepSeekResponsesBody(base, history(action)),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('PRIVATE')
  );
console.log('deepseek-search-history.test.js passed');
let reads = 0;
for (const field of ['type', 'query']) {
  const action = { type: 'search', query: 'fixture' };
  Object.defineProperty(action, field, {
    get() {
      reads++;
      throw new Error('PRIVATE');
    },
  });
  assert.throws(
    () => normalizeDeepSeekSearchHistory(history(action)),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('PRIVATE')
  );
}
assert.equal(reads, 0);
const invalidPrepared = {
  ...base,
  buffer: Buffer.from(
    JSON.stringify(history({ type: 'search', query: 'x', queries: ['different'] }))
  ),
};
const invalidBuffer = invalidPrepared.buffer;
assert.throws(
  () => preflightDeepSeekRequest(invalidPrepared, { requestPath: '/v1/responses' }),
  (error) => error.code === 'invalid_request_error'
);
assert.equal(invalidPrepared.buffer, invalidBuffer);
assert.equal(invalidPrepared.bodyChanged, undefined);
