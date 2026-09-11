'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  ImageJobExecutionError,
  createGeminiImageJobExecutor,
} = require('../lib/proxy/image-job-executor');

const AbortControllerImpl = globalThis.AbortController;

function createTransport(responseFactory, capture) {
  return {
    request(options, callback) {
      capture.options = options;
      const request = new EventEmitter();
      request.destroy = () => request.emit('error', new Error('destroyed'));
      request.end = (body) => {
        capture.body = JSON.parse(Buffer.from(body).toString('utf8'));
        const response = new EventEmitter();
        const value = responseFactory();
        response.statusCode = value.statusCode;
        response.headers = value.headers || {};
        callback(response);
        process.nextTick(() => {
          if (value.error) {
            response.emit('error', value.error);
            return;
          }
          if (value.body != null) response.emit('data', Buffer.from(value.body));
          response.emit('end');
        });
      };
      return request;
    },
  };
}

function createExecutor(transport, overrides = {}) {
  return createGeminiImageJobExecutor({
    codeAssistGenerateRequest: () => ({
      target: new URL('https://code-assist.test/v1internal:generateContent'),
      body: { model: 'gemini-3.1-flash-image', request: {} },
    }),
    codeAssistUserAgent: () => 'test-agent',
    geminiGeneratePath: () => '/v1beta/models/test:generateContent',
    geminiInlineImageToClaudeBlock(part) {
      if (!part.inlineData) return null;
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    },
    getGeminiCooldown: () => null,
    http: transport,
    https: transport,
    logProxyEvent() {},
    maxResponseBytes: 4096,
    parseGeminiError: () => ({ type: 'api_error', retryAfterSeconds: null }),
    parseJsonOrSseJson: JSON.parse,
    setGeminiCooldown() {},
    shouldUseCodeAssistUpstream: () => true,
    unwrapCodeAssistResponse: (payload) => payload.response,
    ...overrides,
  });
}

const request = {
  model: 'gemini-3.1-flash-image',
  prompt: 'safe test prompt',
  n: 1,
  size: 'auto',
  responseFormat: 'b64_json',
};
const prepared = {
  authMode: 'official-login',
  authProvider: 'google',
  model: 'gemini-3.1-flash-image',
  rewriteTo: 'gemini-3.1-flash-image',
  profile: { id: 'google-official', protocol: 'gemini' },
};
const target = { protocol: 'https:', hostname: 'unused.test', port: 443, path: '' };

(async () => {
  const capture = {};
  const successTransport = createTransport(
    () => ({
      statusCode: 200,
      body: JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
              },
            },
          ],
        },
      }),
    }),
    capture
  );
  const success = await createExecutor(successTransport)({
    apiKey: 'ya29.test-token',
    jobId: 'imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    prepared,
    request,
    signal: new AbortControllerImpl().signal,
    target,
  });
  assert.deepStrictEqual(success.data, [{ b64_json: 'aW1hZ2U=' }]);
  assert.strictEqual(capture.options.path, '/v1internal:generateContent');
  assert.strictEqual(capture.options.headers.authorization, 'Bearer ya29.test-token');
  assert.strictEqual(capture.body.model, 'gemini-3.1-flash-image');

  const streamBody = [
    'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"aW1hZ2U="}}]}}]}}',
    'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
    'data: [DONE]',
  ].join('\n\n');
  const streamTransport = createTransport(() => ({ statusCode: 200, body: streamBody }), {});
  const streamed = await createExecutor(streamTransport)({ prepared, request, target });
  assert.deepStrictEqual(streamed.data, [{ b64_json: 'aW1hZ2U=' }]);

  const malformedTransport = createTransport(
    () => ({ statusCode: 200, body: streamBody.replace('data: [DONE]', 'data: private-secret') }),
    {}
  );
  await assert.rejects(
    createExecutor(malformedTransport)({ prepared, request, target }),
    (error) => {
      assert.strictEqual(error.publicError.type, 'invalid_upstream_response');
      assert.ok(!JSON.stringify(error.publicError).includes('private-secret'));
      return true;
    }
  );

  let cooldownRecord = null;
  let loggedEvent = null;
  const rateLimitTransport = createTransport(
    () => ({ statusCode: 429, body: '{"error":{"message":"sensitive upstream detail"}}' }),
    {}
  );
  await assert.rejects(
    createExecutor(rateLimitTransport, {
      parseGeminiError: () => ({ type: 'rate_limit_error', retryAfterSeconds: 12 }),
      setGeminiCooldown: (...args) => {
        cooldownRecord = args;
      },
      logProxyEvent: (_kind, event) => {
        loggedEvent = event;
      },
    })({
      apiKey: 'ya29.token',
      jobId: 'imgjob_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      prepared,
      request,
      target,
    }),
    (error) => {
      assert.ok(error instanceof ImageJobExecutionError);
      assert.strictEqual(error.publicError.type, 'rate_limit_error');
      assert.ok(!JSON.stringify(error.publicError).includes('sensitive upstream detail'));
      return true;
    }
  );
  assert.deepStrictEqual(cooldownRecord, ['google-official', 'gemini-3.1-flash-image', 12]);
  assert.strictEqual(loggedEvent.statusCode, 429);

  const controller = new AbortControllerImpl();
  controller.abort();
  await assert.rejects(
    createExecutor(successTransport)({ prepared, request, target, signal: controller.signal }),
    (error) => error.publicError.type === 'cancelled'
  );

  const oversizedTransport = createTransport(
    () => ({ statusCode: 200, body: 'x'.repeat(100) }),
    {}
  );
  await assert.rejects(
    createExecutor(oversizedTransport, { maxResponseBytes: 10 })({ prepared, request, target }),
    (error) => error.publicError.type === 'upstream_response_too_large'
  );

  console.log('[image-job-executor.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
