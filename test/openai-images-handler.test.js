'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');
const { createOpenAIImagesHandler } = require('../lib/proxy/handlers/openai-images');

let upstreamOptions;
let upstreamBody;
let responseBodyOverride;
const transport = {
  request(options, callback) {
    upstreamOptions = options;
    const request = new EventEmitter();
    request.end = (body) => {
      upstreamBody = JSON.parse(Buffer.from(body).toString('utf8'));
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      response.testBody = JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
              },
            },
          ],
        },
      });
      if (responseBodyOverride !== undefined) response.testBody = responseBodyOverride;
      callback(response);
    };
    return request;
  },
};
const codeAssist = createCodeAssist({ fallbackId: () => 'prompt-id' });
const requestEnds = [];
const handler = createOpenAIImagesHandler({
  boundedResponseContext: () => ({}),
  ...codeAssist,
  collectBoundedResponse(proxyRes, _clientRes, _path, _type, callback) {
    callback(proxyRes.testBody);
  },
  geminiGeneratePath: () => {
    throw new Error('Code Assist path expected');
  },
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
  handleGeminiUpstreamError: () => {
    throw new Error('unexpected upstream error');
  },
  http: transport,
  https: transport,
  log: { warn() {} },
  logRequestEnd(...args) {
    requestEnds.push(args);
  },
  onProxyError: () => () => {},
  onProxyTimeout: () => () => {},
  parseJsonOrSseJson: JSON.parse,
  parseProxyBody(_response, buffer) {
    return JSON.parse(buffer.toString('utf8'));
  },
  proxyErrorContext: () => ({}),
  sendGeminiRateLimit() {},
  sendJsonError(response, status, body) {
    response.status = status;
    response.body = body;
  },
  unwrapCodeAssistResponse: codeAssist.unwrapCodeAssistResponse,
  writeJsonResponse(response, status, body) {
    response.status = status;
    response.body = body;
  },
});

const clientResponse = {};
const invokeHandler = (clientResponse) =>
  handler(
    { method: 'POST', url: '/v1/images/generations' },
    clientResponse,
    {
      buffer: Buffer.from(
        JSON.stringify({
          model: 'gemini-3.1-flash-image',
          prompt: 'Draw a red circle.',
          response_format: 'b64_json',
        })
      ),
      rewriteTo: 'gemini-3.1-flash-image',
      model: 'gemini-3.1-flash-image',
      profile: { id: 'google-official', protocol: 'gemini' },
      authMode: 'official-login',
      authProvider: 'google',
      googleOfficialProjectId: 'project-1',
    },
    { protocol: 'https:', hostname: 'unused.example', port: 443, path: '' },
    'ya29.test-token',
    '/v1/images/generations',
    1000
  );
invokeHandler(clientResponse);

assert.strictEqual(upstreamOptions.path, '/v1internal:generateContent');
assert.strictEqual(upstreamOptions.headers.authorization, 'Bearer ya29.test-token');
assert.strictEqual(upstreamBody.model, 'gemini-3.1-flash-image');
assert.deepStrictEqual(upstreamBody.request.generationConfig, {
  responseModalities: ['IMAGE'],
});
assert.deepStrictEqual(upstreamBody.request.contents, [
  { role: 'user', parts: [{ text: 'Draw a red circle.' }] },
]);
assert.strictEqual(clientResponse.status, 200);
assert.deepStrictEqual(clientResponse.body.data, [{ b64_json: 'aW1hZ2U=' }]);
assert.strictEqual(requestEnds.at(-1)[4].type, 'openai_images_to_gemini');

responseBodyOverride = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"aW1hZ2U="}}]}}]}}',
  'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":1}}}',
  'data: [DONE]',
].join('\n\n');
invokeHandler(clientResponse);
assert.strictEqual(clientResponse.status, 200);
assert.deepStrictEqual(clientResponse.body.data, [{ b64_json: 'aW1hZ2U=' }]);

responseBodyOverride =
  '{"response":{"candidates":[{"finishReason":"NO_IMAGE","content":{"parts":[{"text":"private user content"}]}}]}}';
invokeHandler(clientResponse);
assert.strictEqual(clientResponse.status, 502);
assert.match(clientResponse.body.error.message, /NO_IMAGE/);
assert.ok(!JSON.stringify(requestEnds).includes('private user content'));
assert.ok(!JSON.stringify(clientResponse).includes('private user content'));

responseBodyOverride = '{"private user content":invalid-json}';
invokeHandler(clientResponse);
assert.strictEqual(clientResponse.status, 502);
assert.ok(!JSON.stringify(requestEnds).includes('private user content'));
assert.ok(!JSON.stringify(clientResponse).includes('private user content'));

console.log('[openai-images-handler.test] ok');
