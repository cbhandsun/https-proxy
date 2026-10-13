'use strict';
const assert = require('node:assert/strict');
const {
  isDeepSeekOfficialTarget,
  validateDeepSeekOutputFormat,
  preflightDeepSeekRequest,
} = require('../lib/proxy/deepseek-request-contract');
const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
const formats = {
  chat: { response_format: { type: 'json_schema', json_schema: { name: 'ok', schema } } },
  responses: { text: { format: { type: 'json_schema', name: 'ok', schema } } },
  claude: { output_config: { format: { type: 'json_schema', schema } } },
};
function rejects(fn) {
  assert.throws(
    fn,
    (error) =>
      error.code === 'invalid_request_error' &&
      error.provider === 'deepseek' &&
      !error.message.includes('SECRET')
  );
}
for (const model of [
  'deepseek-v4-flash',
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek/DEEPSEEK-V4-FLASH',
]) {
  for (const [shape, body] of Object.entries(formats)) {
    const before = JSON.stringify(body);
    for (const targetProtocol of ['openai', 'claude', 'openai-responses'])
      rejects(() => validateDeepSeekOutputFormat(body, shape, model, targetProtocol));
    assert.equal(JSON.stringify(body), before);
  }
  for (const shape of ['chat', 'responses', 'claude']) {
    validateDeepSeekOutputFormat({}, shape, model, 'openai');
    rejects(() => validateDeepSeekOutputFormat(null, shape, model, 'openai'));
  }
}
for (const targetProtocol of ['openai', 'openai-responses']) {
  validateDeepSeekOutputFormat(
    { response_format: { type: 'text' } },
    'chat',
    'deepseek-v4-flash',
    targetProtocol
  );
  validateDeepSeekOutputFormat(
    { response_format: { type: 'json_object' } },
    'chat',
    'deepseek-v4-flash',
    targetProtocol
  );
  validateDeepSeekOutputFormat(
    { text: { format: { type: 'json_object' } } },
    'responses',
    'deepseek-v4-flash',
    targetProtocol
  );
  validateDeepSeekOutputFormat(
    { tool_choice: 'required', reasoning_effort: 'high' },
    'chat',
    'deepseek-v4-flash',
    targetProtocol
  );
}
rejects(() =>
  validateDeepSeekOutputFormat(
    { response_format: { type: 'json_object' } },
    'chat',
    'deepseek-v4-flash',
    'claude'
  )
);
for (const body of [
  { response_format: 'SECRET' },
  { response_format: { type: 'SECRET' } },
  { text: [] },
]) {
  rejects(() => validateDeepSeekOutputFormat(body, 'responses', 'deepseek-v4-flash', 'openai'));
}
const prepared = {
  profile: { protocol: 'openai', targetUrl: 'https://api.deepseek.com/v1' },
  model: 'client-alias',
  rewriteTo: 'deepseek-v4-flash',
  buffer: Buffer.from(JSON.stringify(formats.responses)),
};
const textPrepared = { ...prepared, buffer: Buffer.from('{"messages":[]}') };
for (const requestPath of ['/v1/chat/completions', '/v1/responses/', '/v1/messages']) {
  const before = textPrepared.buffer.toString('utf8');
  preflightDeepSeekRequest(textPrepared, { requestPath, requestEncoding: 'identity' });
  assert.equal(textPrepared.buffer.toString('utf8'), before);
}
rejects(() =>
  validateDeepSeekOutputFormat(
    { response_format: { type: 'json_schema', json_schema: { name: 'x'.repeat(65), schema } } },
    'chat',
    'deepseek-v4-flash',
    'openai'
  )
);
let deepSchema = { type: 'object' };
for (let depth = 0; depth < 70; depth++)
  deepSchema = { type: 'object', properties: { child: deepSchema } };
rejects(() =>
  validateDeepSeekOutputFormat(
    { response_format: { type: 'json_schema', json_schema: { name: 'ok', schema: deepSchema } } },
    'chat',
    'deepseek-v4-flash',
    'openai'
  )
);
assert.equal(isDeepSeekOfficialTarget(prepared), true);
for (const protocol of ['openai', 'openai-chat', 'openai-responses', 'claude']) {
  const scoped = { ...prepared, profile: { ...prepared.profile, protocol } };
  assert.equal(isDeepSeekOfficialTarget(scoped), true);
  rejects(() => preflightDeepSeekRequest(scoped, { requestPath: '/v1/responses' }));
  const chat = { ...scoped, buffer: Buffer.from(JSON.stringify(formats.chat)) };
  rejects(() => preflightDeepSeekRequest(chat, { requestPath: '/v1/chat/completions' }));
}
const chatAlias = {
  ...prepared,
  profile: { ...prepared.profile, protocol: 'openai-chat' },
  buffer: Buffer.from('{"previous_response_id":"fixture"}'),
};
// Forced Chat owns continuation; native stateless rejection must not apply here.
preflightDeepSeekRequest(chatAlias, { requestPath: '/v1/responses' });
for (const targetUrl of [
  'https://api.deepseek.com.evil.test',
  'https://api.deepseek.com@evil.test',
  'http://api.deepseek.com',
  'https://api.deepseek.com:444',
  'SECRET',
  null,
]) {
  const other = { ...prepared, profile: { protocol: 'openai', targetUrl } };
  assert.equal(isDeepSeekOfficialTarget(other), false);
  preflightDeepSeekRequest(other, { requestPath: '/v1/responses' });
}
preflightDeepSeekRequest(
  { ...prepared, rewriteTo: 'future-model' },
  { requestPath: '/v1/responses' }
);
preflightDeepSeekRequest(prepared, { requestPath: '/v1/models' });
rejects(() => preflightDeepSeekRequest(prepared, { requestPath: '/v1/responses?query=SECRET' }));
rejects(() =>
  preflightDeepSeekRequest(prepared, { requestPath: '/v1/responses', requestEncoding: 'gzip' })
);
for (const buffer of [undefined, Buffer.from('SECRET'), Buffer.from('null'), Buffer.from('[]')])
  rejects(() =>
    preflightDeepSeekRequest({ ...prepared, buffer }, { requestPath: '/v1/responses' })
  );
validateDeepSeekOutputFormat(formats.chat, 'chat', 'future-model', 'openai');
console.log('deepseek-request-contract.test.js passed');
