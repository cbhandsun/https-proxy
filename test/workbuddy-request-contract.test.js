'use strict';

const assert = require('node:assert/strict');
const {
  isWorkBuddyTarget,
  validateWorkBuddyRequest,
  preflightWorkBuddyRequest,
} = require('../lib/proxy/workbuddy-request-contract');
const { prepareConvertedChatBody } = require('../lib/proxy/handlers/converted-chat-request');
const model = 'deepseek-v4-flash';
const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
const errorMessage =
  'Requested output format or tool choice cannot be preserved by this WorkBuddy model';
function rejected(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'invalid_request_error');
    assert.equal(error.message, errorMessage);
    return true;
  });
}

for (const shape of ['chat', 'responses', 'claude']) {
  for (const tool_choice of [
    undefined,
    null,
    ...(shape === 'claude'
      ? [{ type: 'auto' }, { type: 'none' }, { type: 'auto', disable_parallel_tool_use: true }]
      : ['auto', 'none']),
  ]) {
    const body = { tool_choice };
    const snapshot = JSON.stringify(body);
    validateWorkBuddyRequest(body, shape, model);
    assert.equal(JSON.stringify(body), snapshot);
  }
  for (const tool_choice of [
    'required',
    'SECRET',
    '',
    false,
    1,
    [],
    {},
    { type: 'any' },
    { type: 'tool', name: 'SECRET' },
    { type: 'function', name: 'SECRET' },
    { type: 'function', function: { name: 'SECRET' } },
    { type: 'auto', disable_parallel_tool_use: 'SECRET' },
    'SECRET'.repeat(10000),
  ])
    rejected(() => validateWorkBuddyRequest({ tool_choice }, shape, model));
  for (const body of [null, false, [], 'SECRET'])
    rejected(() => validateWorkBuddyRequest(body, shape, model));
}
for (const body of [
  { response_format: { type: 'json_object' } },
  { response_format: { type: 'json_schema', json_schema: { name: 'ok', schema } } },
  { response_format: { type: 'SECRET' } },
  { response_format: { type: 'json_schema', json_schema: { name: 'ok', schema: [] } } },
]) {
  for (const shape of ['chat', 'responses'])
    rejected(() => validateWorkBuddyRequest(body, shape, model));
}
rejected(() =>
  validateWorkBuddyRequest({ text: { format: { type: 'json_object' } } }, 'responses', model)
);
rejected(() => validateWorkBuddyRequest({ text: 'SECRET' }, 'responses', model));
rejected(() =>
  validateWorkBuddyRequest(
    { output_config: { format: { type: 'json_schema', schema } } },
    'claude',
    model
  )
);
for (const shape of ['chat', 'responses'])
  validateWorkBuddyRequest({ response_format: { type: 'text' } }, shape, model);

const prepared = { model, profile: { protocol: 'workbuddy' }, buffer: Buffer.from('{}') };
assert.equal(isWorkBuddyTarget(prepared), true);
assert.equal(isWorkBuddyTarget({ authProvider: 'workbuddy' }), true);
assert.equal(isWorkBuddyTarget({ profile: { id: 'not-workbuddy', protocol: 'openai' } }), false);
for (const requestPath of ['/v1/chat/completions', '/v1/responses?x=1', '/v1/messages/']) {
  preflightWorkBuddyRequest(prepared, { requestPath });
  preflightWorkBuddyRequest(prepared, { requestPath, requestEncoding: 'identity' });
  for (const buffer of [Buffer.from('SECRET'), Buffer.from('[]'), undefined])
    rejected(() => preflightWorkBuddyRequest({ ...prepared, buffer }, { requestPath }));
  rejected(() => preflightWorkBuddyRequest(prepared, { requestPath, requestEncoding: 'gzip' }));
  rejected(() =>
    preflightWorkBuddyRequest(
      { ...prepared, buffer: Buffer.from('{"tool_choice":"required"}') },
      { requestPath }
    )
  );
}
preflightWorkBuddyRequest({ ...prepared, buffer: undefined }, { requestPath: '/v1/models' });
for (const otherModel of ['other', 'deepseek-v4-pro', undefined, {}, 'deepseek-v4-flash-other']) {
  validateWorkBuddyRequest({ tool_choice: 'required' }, 'chat', otherModel);
  preflightWorkBuddyRequest(
    { ...prepared, rewriteTo: otherModel, model: 'other', buffer: undefined },
    { requestPath: '/v1/responses' }
  );
}
for (const routed of ['workbuddy/deepseek-v4-flash', 'CODEBUDDY/DEEPSEEK-V4-FLASH'])
  rejected(() => validateWorkBuddyRequest({ tool_choice: 'required' }, 'chat', routed));
const original = { messages: [], tool_choice: 'required' };
rejected(() => prepareConvertedChatBody(prepared, original, model));
assert.deepEqual(original, { messages: [], tool_choice: 'required' });
process.stdout.write('workbuddy-request-contract.test.js passed\n');
