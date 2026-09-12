'use strict';

const assert = require('node:assert/strict');
const { createConvertedChatRequest } = require('../lib/proxy/handlers/converted-chat-request');

const requestBody = Buffer.from('{"messages":[{"role":"user","content":"private prompt"}]}');
const target = { path: '/v2', hostname: 'upstream.test', protocol: 'https:' };

const openai = createConvertedChatRequest(
  { profile: { protocol: 'openai' } },
  target,
  'secret-key',
  requestBody
);
assert.equal(openai.headers.authorization, 'Bearer secret-key');
assert.equal(openai.audit.headers.authorization, '[redacted]');
assert.equal(openai.audit.body, '');
assert.equal(openai.audit.bodyBytes, requestBody.length);
assert.equal(openai.audit.path, '/v2/chat/completions');
assert.ok(!JSON.stringify(openai.audit).includes('secret-key'));
assert.ok(!JSON.stringify(openai.audit).includes('private prompt'));

const workbuddy = createConvertedChatRequest(
  {
    authProvider: 'workbuddy',
    workbuddyAuth: { uid: 'private-user@example.test' },
    profile: { protocol: 'openai' },
  },
  target,
  '',
  Buffer.alloc(0)
);
assert.equal(workbuddy.headers['x-user-id'], 'private-user%40example.test');
assert.equal(workbuddy.audit.headers['x-user-id'], '[redacted]');
assert.ok(!JSON.stringify(workbuddy.audit).includes('private-user'));
assert.equal(workbuddy.audit.bodyBytes, 0);

const plain = createConvertedChatRequest(null, target, null, Buffer.from('{}'));
assert.equal(plain.headers.authorization, undefined);
assert.equal(plain.headers['x-user-id'], undefined);
assert.throws(
  () => createConvertedChatRequest({}, target, null, 'not-a-buffer'),
  /requestBody must be a Buffer/
);

console.log('[converted-chat-request.test] ok');
