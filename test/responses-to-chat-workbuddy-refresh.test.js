'use strict';

const assert = require('assert');

const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');

async function main() {
  const calls = [];
  const events = [];
  let converted = null;

  const fakeTransport = {
    request(options, callback) {
      calls.push(options);
      const first = calls.length === 1;
      const proxyRes = {
        statusCode: first ? 401 : 200,
        headers: first ? { 'x-request-id': 'first-401' } : {},
        body: first
          ? '<html><head><title>401 Authorization Required</title></head></html>'
          : JSON.stringify({ id: 'chatcmpl-ok', choices: [{ message: { content: 'ok' } }] }),
      };
      process.nextTick(() => callback(proxyRes));
      return {
        on() {
          return this;
        },
        end() {},
      };
    },
  };

  const handler = createOpenAIResponsesToChatHandler(
    {
      http: fakeTransport,
      https: fakeTransport,
      CORS_HEADERS: {},
      collectBoundedResponse(proxyRes, _clientRes, _upstreamPath, _type, onComplete) {
        onComplete(proxyRes.body);
      },
      createChatToResponsesBridge() {
        throw new Error('stream path should not be used');
      },
      logProxyEvent(type, payload) {
        events.push({ type, payload });
      },
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses(chatPayload) {
        return { id: 'resp-ok', output_text: chatPayload.choices[0].message.content };
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      protocolOptions: { workbuddyAuthRefreshTimeoutMs: 5, workbuddyAuthRefreshIntervalMs: 1 },
      readWorkBuddyAuthInfo() {
        return {
          accessToken: 'eyJ.fresh',
          refreshToken: 'refresh-secret',
          uid: 'uid-fresh',
          uin: 'uin-fresh',
        };
      },
      refreshWorkBuddyOfficialAuth() {
        return Promise.resolve({
          status: 'refreshed',
          triggerStatus: 'started',
          before: { found: true, hasAccessToken: true, tokenShapeOk: false },
          after: { found: true, hasAccessToken: true, tokenShapeOk: true },
        });
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] };
      },
      sendJsonError() {
        throw new Error('sendJsonError should not be used');
      },
      upstreamRequestOptions(_target, path, headers) {
        return { path, headers };
      },
      writeJsonResponse(_clientRes, status, body) {
        converted = { status, body };
      },
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse(options) {
        if (options.proxyRes.statusCode < 200 || options.proxyRes.statusCode >= 300) {
          throw new Error('first 401 should be retried before conversion handling');
        }
        converted = { status: 200, body: options.convert(options.responseBody) };
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  handler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'openai' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: 'opaque-old', uid: 'uid-old' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'copilot.tencent.com' },
    'opaque-old',
    '/v1/responses',
    Date.now()
  );

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].headers.authorization, 'Bearer opaque-old');
  assert.strictEqual(calls[1].headers.authorization, 'Bearer eyJ.fresh');
  assert.strictEqual(converted.status, 200);
  assert.deepStrictEqual(converted.body, { id: 'resp-ok', output_text: 'ok' });
  assert.ok(events.some((event) => event.type === 'workbuddy_auth_refresh'));
  assert.ok(!JSON.stringify(events).includes('eyJ.fresh'));
  assert.ok(!JSON.stringify(events).includes('opaque-old'));

  const timeoutCalls = [];
  let localError = null;
  const timeoutTransport = {
    request(options, callback) {
      timeoutCalls.push(options);
      process.nextTick(() =>
        callback({
          statusCode: 401,
          headers: {},
          body: '<html><head><title>401 Authorization Required</title></head></html>',
        })
      );
      return {
        on() {
          return this;
        },
        end() {},
      };
    },
  };
  const timeoutHandler = createOpenAIResponsesToChatHandler(
    {
      http: timeoutTransport,
      https: timeoutTransport,
      CORS_HEADERS: {},
      collectBoundedResponse(proxyRes, _clientRes, _upstreamPath, _type, onComplete) {
        onComplete(proxyRes.body);
      },
      createChatToResponsesBridge() {},
      logProxyEvent() {},
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses() {
        throw new Error('conversion should not run after refresh timeout');
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      readWorkBuddyAuthInfo() {
        return null;
      },
      refreshWorkBuddyOfficialAuth() {
        return Promise.resolve({
          status: 'refresh_timeout',
          triggerStatus: 'started',
          before: { found: true, hasAccessToken: true, tokenShapeOk: false },
          after: { found: true, hasAccessToken: true, tokenShapeOk: false },
        });
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] };
      },
      sendJsonError(_clientRes, status, payload) {
        localError = { status, payload };
      },
      upstreamRequestOptions(_target, path, headers) {
        return { path, headers };
      },
      writeJsonResponse() {},
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse() {
        throw new Error('upstream HTML should not be forwarded after refresh timeout');
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  timeoutHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'openai' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: 'opaque-old', uid: 'uid-old' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'copilot.tencent.com' },
    'opaque-old',
    '/v1/responses',
    Date.now()
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(timeoutCalls.length, 1);
  assert.strictEqual(localError.status, 401);
  assert.strictEqual(localError.payload.error.code, 'workbuddy_auth_refresh_failed');
  assert.ok(!JSON.stringify(localError).includes('<html>'));

  let wbipcConverted = null;
  let encryptedTransportCalled = false;
  const wbipcBodies = [];
  const wbipcEvents = [];
  const encryptedWbipcHandler = createOpenAIResponsesToChatHandler(
    {
      http: {
        request() {
          encryptedTransportCalled = true;
          throw new Error('encrypted credentials must use wbipc before upstream request');
        },
      },
      https: {
        request() {
          encryptedTransportCalled = true;
          throw new Error('encrypted credentials must use wbipc before upstream request');
        },
      },
      CORS_HEADERS: {},
      collectBoundedResponse() {},
      createChatToResponsesBridge() {},
      logProxyEvent(type, payload) {
        wbipcEvents.push({ type, payload });
      },
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      workbuddyOperationalInputTokens: 2048,
      workbuddyPreflightBodyBytes: 8192,
      workbuddyTargetBodyBytes: 8192,
      workbuddyWbipcRetryBodyBytes: 4096,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses(chatPayload) {
        return { id: 'resp-ok', output_text: chatPayload.choices[0].message.content };
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      workBuddyWbipcClient: {
        request(params) {
          assert.strictEqual(params.method, 'POST');
          assert.strictEqual(params.path, '/v2/chat/completions');
          assert.strictEqual(params.headers.authorization, undefined);
          assert.strictEqual(params.headers['content-type'], 'application/json');
          assert.ok(Buffer.isBuffer(params.body));
          wbipcBodies.push(JSON.parse(params.body.toString('utf8')));
          if (wbipcBodies.length === 1) {
            return Promise.resolve({ ok: false, status: 'E_PAYLOAD_TOO_LARGE' });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'chatcmpl-wbipc',
              choices: [{ message: { content: 'wbipc-ok' } }],
            }),
          });
        },
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return {
          model: 'deepseek-v4.1-flash',
          messages: [
            { role: 'system', content: 'keep-system' },
            { role: 'user', content: 'old-' + 'x'.repeat(2500) },
            { role: 'assistant', content: 'old-answer-' + 'y'.repeat(2500) },
            { role: 'user', content: 'keep-latest' },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_workspace_file',
                description: 'tool-doc-'.repeat(1000),
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'parameter-doc-'.repeat(1000) },
                  },
                  required: ['path'],
                  examples: [{ path: 'example.txt' }],
                },
              },
            },
          ],
        };
      },
      sendJsonError(_clientRes, status, payload) {
        throw new Error(`sendJsonError should not be used: ${status} ${JSON.stringify(payload)}`);
      },
      upstreamRequestOptions() {
        throw new Error('upstream options should not be built');
      },
      writeJsonResponse(_clientRes, status, body) {
        wbipcConverted = { status, body };
      },
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse(options) {
        wbipcConverted = {
          status: options.proxyRes.statusCode,
          body: options.convert(options.responseBody),
        };
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  encryptedWbipcHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'workbuddy' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
    '',
    '/v1/responses',
    Date.now()
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(encryptedTransportCalled, false);
  assert.strictEqual(wbipcBodies.length, 2);
  assert.ok(JSON.stringify(wbipcBodies[1]).length < JSON.stringify(wbipcBodies[0]).length);
  assert.ok(
    JSON.stringify(wbipcBodies[1].tools).length <= JSON.stringify(wbipcBodies[0].tools).length
  );
  assert.strictEqual(wbipcBodies[1].tools[0].function.name, 'read_workspace_file');
  assert.deepStrictEqual(wbipcBodies[1].tools[0].function.parameters.required, ['path']);
  assert.strictEqual(wbipcBodies[1].messages[0].content, 'keep-system');
  assert.strictEqual(wbipcBodies[1].messages.at(-1).content, 'keep-latest');
  const fallbackEvent = wbipcEvents.find(
    (event) => event.type === 'workbuddy_wbipc_payload_fallback'
  );
  const contextPlanEvent = wbipcEvents.find((event) => event.type === 'workbuddy_context_plan');
  assert.strictEqual(contextPlanEvent.payload.preflightApplied, true);
  assert.ok(contextPlanEvent.payload.originalEstimatedTokens > 2048);
  assert.ok(contextPlanEvent.payload.finalEstimatedTokens <= 2048);
  assert.strictEqual(fallbackEvent.payload.retrying, true);
  assert.ok(fallbackEvent.payload.retryBodyBytes < fallbackEvent.payload.originalBodyBytes);
  assert.deepStrictEqual(wbipcConverted, {
    status: 200,
    body: { id: 'resp-ok', output_text: 'wbipc-ok' },
  });

  let encryptedLocalError = null;
  let encryptedFailureStatus = 'not_available';
  const encryptedUnavailableHandler = createOpenAIResponsesToChatHandler(
    {
      http: {
        request() {
          throw new Error('encrypted credentials must fail locally when wbipc is unavailable');
        },
      },
      https: {
        request() {
          throw new Error('encrypted credentials must fail locally when wbipc is unavailable');
        },
      },
      CORS_HEADERS: {},
      collectBoundedResponse() {},
      createChatToResponsesBridge() {},
      logProxyEvent() {},
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses() {},
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      workBuddyWbipcClient: {
        request() {
          return Promise.resolve({ ok: false, status: encryptedFailureStatus });
        },
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] };
      },
      sendJsonError(_clientRes, status, payload) {
        encryptedLocalError = { status, payload };
      },
      upstreamRequestOptions() {
        throw new Error('upstream options should not be built');
      },
      writeJsonResponse() {},
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse() {
        throw new Error('conversion should not run');
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  encryptedUnavailableHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'workbuddy' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
    '',
    '/v1/responses',
    Date.now()
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(encryptedLocalError.status, 401);
  assert.strictEqual(
    encryptedLocalError.payload.error.code,
    'workbuddy_encrypted_credentials_unsupported'
  );
  assert.strictEqual(encryptedLocalError.payload.error.wbipc_status, 'not_available');
  assert.ok(!JSON.stringify(encryptedLocalError).includes('uid-encrypted'));

  encryptedFailureStatus = 'E_PAYLOAD_TOO_LARGE';
  encryptedLocalError = null;
  encryptedUnavailableHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'workbuddy' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
    '',
    '/v1/responses',
    Date.now()
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(encryptedLocalError.status, 413);
  assert.strictEqual(encryptedLocalError.payload.error.code, 'workbuddy_request_too_large');
  assert.strictEqual(encryptedLocalError.payload.error.wbipc_status, 'E_PAYLOAD_TOO_LARGE');
  assert.ok(!JSON.stringify(encryptedLocalError).includes('uid-encrypted'));

  console.log('[responses-to-chat-workbuddy-refresh.test] ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
