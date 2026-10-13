'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { parseClaudeSseEvent, deltaPartialJson } = require('../lib/proxy/sse');
const { createHttpUtils } = require('../lib/proxy/handlers/http-utils');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createGeminiResponsesStream } = require('../lib/proxy/gemini-responses-stream');
const { geminiUsageToClaude } = require('../lib/proxy/gemini-usage');
const noop = () => {};
const deps = {
  ...createClaudeFilters({ protocolOptions: {} }),
  ...require('../lib/proxy/tools'),
  parseClaudeSseEvent,
  deltaPartialJson,
  fallbackId: (prefix) => prefix + '_fixture',
  stableHash: () => 'fixture',
  stableCreated: () => 1,
  sampleGeminiToolEvent: noop,
};
const frame = (type, data) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
function route(source, target, options = {}) {
  let callback,
    sent,
    requests = 0;
  const errors = [],
    writes = [];
  const sendJsonError = (_res, status, body) => errors.push({ status, body });
  const gemini = createGeminiProtocol({ ...deps, protocolOptions: options.protocolOptions });
  const ai = createOpenAIProtocol({
    ...deps,
    normalizeClaudeSystem: gemini.normalizeClaudeSystem,
    protocolOptions: options.protocolOptions,
  });
  const state = createResponsesState({
    ...deps,
    ...ai,
    sendJsonError,
    log: { info: noop, warn: noop },
    cacheFile: options.cacheFile,
    cacheSaveDelayMs: 0,
  });
  const client = new EventEmitter();
  client.writeHead = () => {
    client.headersSent = true;
  };
  client.setHeader = noop;
  client.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  client.end = (chunk) => {
    if (chunk) writes.push(String(chunk));
    client.writableEnded = true;
  };
  const ctx = {
    ...createHttpUtils({}),
    ...deps,
    ...ai,
    ...gemini,
    ...state,
    ...createRequestValidators({ sendJsonError }),
    sendJsonError,
    parseProxyBody: () => source,
    log: { info: noop, warn: noop },
    CORS_HEADERS: {},
    protocolOptions: options.protocolOptions,
    shouldUseCodeAssistUpstream: () => options.codeAssist === true,
    codeAssistGenerateRequest: (_req, request) => ({
      body: { request },
      target: new URL('http://fixture/v1internal:generateContent'),
    }),
    codeAssistUserAgent: () => 'fixture',
    unwrapCodeAssistResponse: (value) => value,
    createGeminiResponsesStream: (responseState, streamOptions) =>
      createGeminiResponsesStream({
        deps: { ...deps, ...gemini, geminiUsageToClaude, protocolOptions: options.protocolOptions },
        responseState,
        emitter: ai.createResponsesStreamEmitter(true),
        options: streamOptions,
      }),
    getGeminiCooldown: () => null,
    http: {
      request: (_options, cb) => {
        requests++;
        callback = cb;
        return {
          on: noop,
          end: (bytes) => {
            sent = JSON.parse(bytes);
          },
        };
      },
    },
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    logRequestEnd: noop,
    logProxyEvent: noop,
    responsesToChatWithHistory: () => assert.fail('legacy Chat history selected'),
    openAIResponsesToChat: () => assert.fail('legacy Chat mapping selected'),
  };
  const method =
    target === 'Claude'
      ? 'handleOpenAIResponsesToClaudeMessages'
      : 'handleOpenAIResponsesToGeminiMessages';
  const before = JSON.stringify(source);
  createRouteHandlers(ctx)[method](
    { method: 'POST', headers: {} },
    client,
    {
      rewriteTo: options.model ?? (target === 'Claude' ? 'claude-sonnet-4-6' : 'gemini-3.8-flash'),
      buffer: Buffer.from('{}'),
      profile: {},
    },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/responses',
    1
  );
  if (callback) {
    const upstream = new EventEmitter();
    upstream.statusCode = 200;
    upstream.setEncoding = noop;
    upstream.pause = noop;
    upstream.resume = noop;
    upstream.destroy = noop;
    callback(upstream);
    const claude = {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'model',
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const geminiPayload = {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'reply' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
    const payload = source.stream
      ? target === 'Gemini'
        ? 'data: ' + JSON.stringify(geminiPayload) + '\n\n'
        : [
            frame('message_start', { message: { ...claude, content: [], stop_reason: null } }),
            frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
            frame('content_block_delta', {
              index: 0,
              delta: { type: 'text_delta', text: 'reply' },
            }),
            frame('content_block_stop', { index: 0 }),
            frame('message_delta', {
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            }),
            frame('message_stop', {}),
          ].join('')
      : JSON.stringify(target === 'Claude' ? claude : geminiPayload);
    upstream.emit('data', Buffer.from(payload));
    upstream.emit('end');
  }
  assert.equal(JSON.stringify(source), before);
  return {
    state,
    sent: options.codeAssist === true ? sent?.request : sent,
    errors,
    writes,
    requests,
    diagnostics: client.__diagnostics?.hpmDiagnostics,
  };
}
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-history-policy-'));
  try {
    for (const target of ['Claude', 'Gemini'])
      for (const stream of [false, true])
        for (const store of [false, true, undefined]) {
          const cacheFile = path.join(directory, target + '-' + stream + '-' + store + '.json');
          const result = route(Object.freeze({ input: 'question', stream, store }), target, {
            cacheFile,
          });
          assert.equal(result.requests, 1);
          assert.deepEqual(result.errors, []);
          assert.ok(result.writes.join('').includes('reply'));
          assert.equal(result.state.responsesHistory.size, store === false ? 0 : 1);
          assert.equal(result.state.responsesSummaries.size, store === false ? 0 : 1);
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(fs.existsSync(cacheFile), store !== false);
          if (store !== false)
            assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).length, 1);
          assert.ok(!JSON.stringify(result.sent).includes('truncation'));
        }
    const protocolOptions = {
      maxContextTokens: 3000,
      outputReserveTokens: 100,
      safetyMarginTokens: 100,
      contextWindowPolicy: 'disabled',
    };
    const input = [
      { role: 'user', content: 'old'.repeat(10000) },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'current' },
    ];
    for (const target of ['Claude', 'Gemini']) {
      const rejected = route({ input, truncation: 'disabled' }, target, { protocolOptions });
      assert.equal(rejected.requests, 0);
      assert.equal(rejected.errors[0].status, 400);
      assert.equal(rejected.errors[0].body.error.code, 'context_length_exceeded');
      const automatic = route({ input, truncation: 'auto', store: false }, target, {
        protocolOptions,
      });
      assert.equal(automatic.requests, 1);
      assert.deepEqual(automatic.errors, []);
      assert.ok(!JSON.stringify(automatic.sent).includes('oldoldold'));
      for (const source of [
        { input: 'question', store: 'SECRET' },
        { input: 'question', truncation: 'SECRET' },
      ]) {
        const invalid = route(source, target);
        assert.equal(invalid.requests, 0);
        assert.equal(invalid.errors[0].status, 400);
        assert.ok(!JSON.stringify(invalid.errors).includes('SECRET'));
      }
    }
  } finally {
    for (const filename of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, filename));
    fs.rmdirSync(directory);
  }
}
if (require.main === module)
  main().catch((error) => {
    process.stderr.write(String(error.stack) + '\n');
    process.exitCode = 1;
  });
module.exports = { route };
