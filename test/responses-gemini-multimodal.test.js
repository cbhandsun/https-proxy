'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const protocol = require('../openai-proxy');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');
const { MAX_INLINE_MEDIA_BYTES } = require('../lib/proxy/multimodal-content');

// Transport fixtures verify byte preservation, not Google's ability to decode media.
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=';
const audio = Buffer.from('audio transport fixture').toString('base64');
const video = Buffer.from('video transport fixture').toString('base64');
const media = [
  { type: 'input_image', image_url: `data:image/png;base64,${image}` },
  { type: 'input_audio', input_audio: { format: 'wav', data: audio } },
  { type: 'input_video', video_url: `data:video/mp4;base64,${video}` },
];
const expectedMedia = [
  { inlineData: { mimeType: 'image/png', data: image } },
  { inlineData: { mimeType: 'audio/wav', data: audio } },
  { inlineData: { mimeType: 'video/mp4', data: video } },
];
const noop = () => {};

function harness({
  official = true,
  upstreamStatus = 200,
  outputParts = [{ text: 'MEDIA_OK' }],
} = {}) {
  const requests = [];
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const deps = {
    ...protocol,
    log: { info: noop, warn: noop, error: noop },
    logRequestEnd: noop,
    logProxyEvent: noop,
    sampleResponseChunk: noop,
    stableCreated: () => 1,
    CORS_HEADERS: {},
    conversionResponseLimit: 1024 * 1024,
    sendJsonError: sendJson,
    writeJsonResponse: sendJson,
    parseProxyBody: (_res, buffer) => JSON.parse(buffer.toString('utf8')),
    parseJsonOrSseJson: JSON.parse,
    upstreamRequestOptions: (target, path, headers) => ({
      hostname: target.hostname,
      path,
      headers,
    }),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    writeClaudeSseEvent: (res, event, payload) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
    ...createCodeAssist({ fallbackId: protocol.fallbackId }),
  };
  const state = createResponsesState(deps);
  const transport = {
    request(options, callback) {
      const req = new EventEmitter();
      req.end = (buffer) => {
        requests.push({ options, body: JSON.parse(buffer.toString('utf8')) });
        const upstream = new EventEmitter();
        upstream.statusCode = upstreamStatus;
        upstream.headers = {};
        callback(upstream);
        const payload =
          upstreamStatus === 200
            ? {
                candidates: [
                  { content: { role: 'model', parts: outputParts }, finishReason: 'STOP' },
                ],
                usageMetadata: {
                  promptTokenCount: 12,
                  candidatesTokenCount: 3,
                  totalTokenCount: 15,
                },
              }
            : {
                error: {
                  code: upstreamStatus,
                  message: 'Permission denied',
                  status: 'PERMISSION_DENIED',
                },
              };
        const envelope = official && upstreamStatus === 200 ? { response: payload } : payload;
        const stream = options.path.includes('streamGenerateContent') && upstreamStatus === 200;
        upstream.emit(
          'data',
          Buffer.from(stream ? `data: ${JSON.stringify(envelope)}\n\n` : JSON.stringify(envelope))
        );
        upstream.emit('end');
      };
      return req;
    },
  };
  const handlers = createRouteHandlers({
    ...deps,
    ...state,
    ...createRequestValidators(deps),
    http: transport,
    https: transport,
  });
  function run(input, extra = {}) {
    const res = {
      statusCode: 0,
      chunks: [],
      headersSent: false,
      writeHead(status) {
        this.statusCode = status;
        this.headersSent = true;
      },
      write(chunk) {
        this.chunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk) this.write(chunk);
        this.writableEnded = true;
      },
    };
    const body = { model: 'gemini-3.7-flash-high', input, ...extra };
    handlers.handleOpenAIResponsesToGeminiMessages(
      { method: 'POST', url: '/v1/responses' },
      res,
      {
        model: body.model,
        rewriteTo: body.model,
        profile: { id: 'test', protocol: 'gemini' },
        authMode: official ? 'official-login' : 'api-key',
        authProvider: 'google',
        googleOfficialProjectId: 'test-project',
        buffer: Buffer.from(JSON.stringify(body)),
      },
      {
        protocol: 'https:',
        hostname: 'generativelanguage.googleapis.com',
        port: '443',
        path: '/v1beta',
      },
      official ? 'ya29.synthetic-test' : 'synthetic-api-key',
      '/v1/responses',
      Date.now()
    );
    res.text = res.chunks.join('');
    return res;
  }
  return { run, requests };
}

for (const official of [false, true]) {
  for (const stream of [false, true]) {
    test(`Responses media survives real converters and ${official ? 'Code Assist' : 'Gemini API'} route, stream=${stream}`, () => {
      const h = harness({ official });
      const res = h.run(
        [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect media' }, ...media] }],
        { stream }
      );
      assert.equal(res.statusCode, 200, res.text);
      assert.equal(h.requests.length, 1);
      const wire = h.requests[0];
      const body = official ? wire.body.request : wire.body;
      assert.deepEqual(body.contents[0].parts, [{ text: 'Inspect media' }, ...expectedMedia]);
      if (official) {
        assert.equal(wire.body.model, 'gemini-3.7-flash-tiered');
        assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
        assert.equal(wire.options.hostname, 'daily-cloudcode-pa.googleapis.com');
      }
      assert.equal(wire.options.path.includes('streamGenerateContent'), stream);
      if (stream) {
        assert.match(res.text, /response.output_text.delta/);
        assert.match(res.text, /response.completed/);
      } else {
        const result = JSON.parse(res.text);
        assert.equal(result.object, 'response');
        assert.equal(result.status, 'completed');
        assert.equal(result.output[0].content[0].text, 'MEDIA_OK');
      }
      assert.match(res.text, /MEDIA_OK/);
    });
  }
}

test('previous_response_id retains media and assistant response on the next Gemini turn', () => {
  const h = harness();
  const first = h.run([{ role: 'user', content: media }]);
  const id = JSON.parse(first.text).id;
  const next = h.run('Continue', { previous_response_id: id });
  assert.equal(next.statusCode, 200, next.text);
  const contents = h.requests[1].body.request.contents;
  assert.deepEqual(contents[0].parts, expectedMedia);
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts[0].text, 'MEDIA_OK');
  assert.equal(contents[2].parts[0].text, 'Continue');
});

for (const stream of [false, true]) {
  test(`Gemini generated image is returned as Markdown in Responses text, stream=${stream}`, () => {
    const h = harness({ outputParts: [expectedMedia[0]] });
    const res = h.run('Draw an image', { model: 'gemini-3.1-flash-image', stream });
    assert.equal(res.statusCode, 200, res.text);
    assert.deepEqual(h.requests[0].body.request.generationConfig.responseModalities, [
      'TEXT',
      'IMAGE',
    ]);
    assert.ok(res.text.includes(`![generated image](data:image/png;base64,${image})`));
    assert.doesNotMatch(res.text, /image_generation_call/);
    if (!stream) assert.equal(JSON.parse(res.text).output[0].content[0].type, 'output_text');
    else assert.match(res.text, /response.completed/);
  });
}

test('unsupported and malformed media fail before transport without reflecting payloads', () => {
  const cases = [
    { type: 'input_image', image_url: 'https://127.0.0.1/private-secret' },
    { type: 'input_image', file_id: 'private-secret' },
    { type: 'input_file', file_data: 'private-secret' },
    { type: 'input_audio', input_audio: { format: 'wav', data: '' } },
    { type: 'input_video', video_url: 'data:image/png;base64,cHJpdmF0ZS1zZWNyZXQ=' },
    { type: 'input_audio', input_audio: { format: 'wav', data: 'private-secret' } },
    {
      type: 'input_audio',
      input_audio: {
        format: 'wav',
        data: Buffer.alloc(MAX_INLINE_MEDIA_BYTES + 1).toString('base64'),
      },
    },
  ];
  for (const part of cases) {
    const h = harness();
    const res = h.run([{ role: 'user', content: [part] }]);
    assert.equal(res.statusCode, 400);
    assert.equal(h.requests.length, 0);
    assert.doesNotMatch(res.text, /private-secret/);
  }
});

test('upstream permission errors never become successful Responses, including requested SSE', () => {
  for (const stream of [false, true]) {
    const h = harness({ upstreamStatus: 403 });
    const res = h.run([{ role: 'user', content: media }], { stream });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.text).error.upstream, 'gemini');
    assert.doesNotMatch(res.text, /response.completed|MEDIA_OK/);
  }
});
