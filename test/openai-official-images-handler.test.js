'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createOpenAIOfficialImagesHandler,
  imageResponsesModelForRoute,
} = require('../lib/proxy/handlers/openai-official-images');
const { createProxyHandlers } = require('../lib/proxy/handlers');

let upstreamOptions;
let upstreamBody;
let responseStatusCode = 200;
let responseBodyOverride;
const requestEnds = [];
const transport = {
  request(options, callback) {
    upstreamOptions = options;
    const request = new EventEmitter();
    request.end = (body) => {
      upstreamBody = JSON.parse(Buffer.from(body).toString('utf8'));
      const response = new EventEmitter();
      response.statusCode = responseStatusCode;
      response.headers = { 'content-type': 'application/json' };
      response.testBody =
        responseBodyOverride ||
        JSON.stringify({
          output: [
            {
              type: 'image_generation_call',
              result: 'aW1hZ2U=',
              revised_prompt: 'A sharper prompt.',
            },
          ],
        });
      callback(response);
    };
    return request;
  },
};

const handler = createOpenAIOfficialImagesHandler({
  collectBoundedResponse(proxyRes, _clientRes, _path, _type, callback) {
    callback(proxyRes.testBody);
  },
  http: transport,
  https: transport,
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
  sendJsonError(response, status, body) {
    response.status = status;
    response.body = body;
  },
  sendUpstreamError(response, status, _headers, body) {
    response.status = status;
    response.body = { upstream: body };
  },
  upstreamRequestOptions(target, path, headers) {
    return {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path,
      headers,
    };
  },
  writeJsonResponse(response, status, body) {
    response.status = status;
    response.body = body;
  },
});

function invoke(body, response = {}) {
  handler(
    { method: 'POST', url: '/v1/images/generations' },
    response,
    {
      buffer: Buffer.from(JSON.stringify(body)),
      route: { responsesModel: 'gpt-6-astra' },
      model: body.model,
      profile: { id: 'openai-official', protocol: 'responses' },
      authMode: 'official-login',
      authProvider: 'openai',
    },
    { protocol: 'https:', hostname: 'chatgpt.com', port: 443, path: '/backend-api/codex' },
    'session-token',
    '/v1/images/generations',
    1000
  );
  return response;
}

const clientResponse = invoke({
  model: 'gpt-image-2.5-flare',
  prompt: 'Draw a red circle.',
  size: '1024x1024',
  quality: 'high',
  response_format: 'b64_json',
});

assert.strictEqual(upstreamOptions.path, '/backend-api/codex/responses');
assert.strictEqual(upstreamOptions.headers.authorization, 'Bearer session-token');
assert.deepStrictEqual(upstreamBody, {
  model: 'gpt-6-astra',
  input: [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Draw a red circle.' }],
    },
  ],
  tools: [
    {
      type: 'image_generation',
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
      quality: 'high',
    },
  ],
  stream: true,
  store: false,
});
assert.strictEqual(clientResponse.status, 200);
assert.deepStrictEqual(clientResponse.body.data, [
  { b64_json: 'aW1hZ2U=', revised_prompt: 'A sharper prompt.' },
]);
assert.strictEqual(requestEnds.at(-1)[4].type, 'openai_official_images');

responseBodyOverride = JSON.stringify({
  type: 'response.completed',
  response: { output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }] },
});
const urlResponse = invoke({
  model: 'gpt-image-2.5-sunburst',
  prompt: 'Draw a blue square.',
  response_format: 'url',
});
assert.strictEqual(urlResponse.status, 200);
assert.deepStrictEqual(urlResponse.body.data, [{ url: 'data:image/png;base64,aW1hZ2U=' }]);

responseBodyOverride = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"c3RyZWFtLWltYWdl"}}',
  'data: {"type":"response.done"}',
  'data: [DONE]',
].join('\n\n');
const sseResponse = invoke({
  model: 'gpt-image-2.5-flare',
  prompt: 'Draw a yellow star.',
});
assert.strictEqual(sseResponse.status, 200);
assert.deepStrictEqual(sseResponse.body.data, [{ b64_json: 'c3RyZWFtLWltYWdl' }]);

const invalidResponse = invoke({ model: '../secret', prompt: 'x' });
assert.strictEqual(invalidResponse.status, 400);
assert.strictEqual(invalidResponse.body.error.type, 'invalid_request_error');

responseStatusCode = 429;
responseBodyOverride = '{"error":{"message":"rate limited"}}';
const upstreamErrorResponse = invoke({
  model: 'gpt-image-2.5-flare',
  prompt: 'Draw a green triangle.',
});
assert.strictEqual(upstreamErrorResponse.status, 429);
assert.deepStrictEqual(upstreamErrorResponse.body, {
  upstream: '{"error":{"message":"rate limited"}}',
});

assert.strictEqual(
  imageResponsesModelForRoute({}, { imageResponsesModel: 'gpt-6-custom ' }),
  'gpt-6-custom'
);
assert.strictEqual(imageResponsesModelForRoute({}, {}), 'gpt-6-astra');

const proxyHandlers = createProxyHandlers({
  sendJsonError() {},
  extractSseDataPayloads: () => [],
  fallbackId: () => 'id',
  logProxyEvent() {},
  logRequestEnd() {},
});
assert.strictEqual(typeof proxyHandlers.handleOpenAIImagesToOpenAIOfficialResponses, 'function');

console.log('[openai-official-images-handler.test] ok');
