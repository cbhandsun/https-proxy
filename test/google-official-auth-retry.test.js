const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const {
  createGoogleOfficialAuthRetry,
} = require('../lib/proxy/handlers/google-official-auth-retry');

const noop = () => {};

function createClientResponse(done) {
  return {
    headersSent: false,
    writeHead() {},
    write() {},
    end() {},
    done,
  };
}

function createHarness() {
  const attempts = [];
  const proxyEvents = [];
  const requestEnds = [];
  let jsonResponse = null;
  let upstreamError = null;
  let refreshCalls = 0;

  const transport = {
    request(options, callback) {
      return {
        on() {
          return this;
        },
        end(body) {
          attempts.push({ options, body: Buffer.from(body || '').toString('utf8') });
          const proxyRes = new EventEmitter();
          proxyRes.statusCode = attempts.length === 1 ? 401 : 200;
          proxyRes.headers = { 'content-type': 'application/json' };
          proxyRes.destroy = noop;
          process.nextTick(() => {
            callback(proxyRes);
            const payload =
              attempts.length === 1
                ? { error: { message: 'invalid access token' } }
                : { response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
            proxyRes.emit('data', Buffer.from(JSON.stringify(payload)));
            proxyRes.emit('end');
          });
        },
      };
    },
  };

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const handlers = createRouteHandlers({
    https: transport,
    http: transport,
    log: { info: noop, warn: noop, error: noop },
    CORS_HEADERS: {},
    sendJsonError: noop,
    sendUpstreamError(_clientRes, statusCode, _headers, responseBody, upstreamProvider) {
      upstreamError = { statusCode, responseBody, upstreamProvider };
      resolveDone();
    },
    logRequestEnd: (method, path, startTime, statusCode, meta) => {
      requestEnds.push({ method, path, startTime, statusCode, meta });
    },
    logProxyEvent: (kind, payload) => {
      proxyEvents.push({ kind, payload });
    },
    fallbackId: () => 'retry-test',
    stableCreated: () => 1,
    sendGeminiRateLimit: noop,
    writeClaudeSseEvent: noop,
    processClaudeSseChunkToOpenAI: noop,
    flushClaudeSseToOpenAI: noop,
    processOpenAIChatSseChunkToResponses: noop,
    processGeminiSseEvent: noop,
    flushPendingGeminiToolCall: noop,
    geminiClaudeStopReason: () => 'end_turn',
    sampleResponseChunk: noop,
    openAIChatToClaudeMessages: () => ({ messages: [], tools: [] }),
    claudeMessagesToGemini: () => ({ contents: [] }),
    geminiGeneratePath: () => {
      throw new Error('Google official login should use Code Assist upstream');
    },
    geminiResponseToClaude: () => ({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    claudeResponseToOpenAIChat: () => ({
      id: 'chatcmpl-retry',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }),
    openAIChatToResponses: () => ({
      id: 'resp-retry',
      object: 'response',
      status: 'completed',
      output_text: 'ok',
      output: [],
    }),
    parseGeminiError: () => ({ type: 'authentication_error', message: 'invalid token' }),
    getGeminiCooldown: () => null,
    setGeminiCooldown: noop,
    writeJsonResponse(_clientRes, statusCode, payload) {
      jsonResponse = { statusCode, payload };
      resolveDone();
    },
    parseProxyBody: () => ({
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: 'hello' }],
      input: 'hello',
      stream: false,
    }),
    upstreamRequestOptions: noop,
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    parseJsonOrSseJson: JSON.parse,
    shouldUseCodeAssistUpstream: () => true,
    codeAssistUserAgent: () => 'antigravity-cli/test',
    codeAssistGenerateRequest: (_prepared, _body, _model, stream) => ({
      target: new URL(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:' +
          (stream ? 'streamGenerateContent?alt=sse' : 'generateContent')
      ),
      body: { model: 'gemini-3.7-flash-tiered', request: { contents: [] } },
    }),
    unwrapCodeAssistResponse: (payload) =>
      payload && payload.response ? payload.response : payload,
    unwrapCodeAssistSseEvent: (event) => event,
    collectBoundedResponse(proxyRes, _clientRes, _path, _type, callback) {
      let body = '';
      proxyRes.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      proxyRes.on('end', () => callback(body));
    },
    createChatToResponsesBridge: noop,
    responsesToChatWithHistory: () => ({
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }),
    rememberResponsesFromChatResponse: noop,
    rememberResponsesFromBridge: noop,
    rejectUnsupportedResponsesNonOpenAIConversion: () => false,
    rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
    refreshAntigravityOfficialAccessToken: async () => {
      refreshCalls += 1;
      return 'ya29.new-route-token';
    },
    maxConversionResponseBytes: 4096,
    protocolOptions: {},
  });

  return {
    attempts,
    done,
    handlers,
    jsonResponse: () => jsonResponse,
    proxyEvents,
    requestEnds,
    refreshCalls: () => refreshCalls,
    upstreamError: () => upstreamError,
  };
}

function officialPrepared() {
  return {
    buffer: Buffer.from('{}'),
    model: 'gemini-3.7-flash',
    rewriteTo: 'gemini-3.7-flash-tiered',
    profile: { id: 'google-official', protocol: 'gemini' },
    authMode: 'official-login',
    authProvider: 'google',
  };
}

async function assertRetriesWithFreshToken(kind) {
  const harness = createHarness();
  const clientReq = {
    method: 'POST',
    url: kind === 'chat' ? '/v1/chat/completions' : '/v1/responses',
  };
  const clientRes = createClientResponse(harness.done);
  const target = { protocol: 'https:', hostname: 'example.test', port: 443, path: '/v1' };
  const args = [clientReq, clientRes, officialPrepared(), target, 'ya29.old-route-token'];
  if (kind === 'chat') {
    harness.handlers.handleOpenAIChatToGeminiMessages(...args, '/chat/completions', Date.now());
  } else {
    harness.handlers.handleOpenAIResponsesToGeminiMessages(...args, '/responses', Date.now());
  }
  await harness.done;

  assert.equal(harness.refreshCalls(), 1);
  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.attempts[0].options.headers.authorization, 'Bearer ya29.old-route-token');
  assert.equal(harness.attempts[1].options.headers.authorization, 'Bearer ya29.new-route-token');
  assert.equal(harness.jsonResponse().statusCode, 200);
  assert.equal(harness.upstreamError(), null);
  assert.equal(
    harness.proxyEvents.filter((event) => event.kind === 'google_official_auth_retry').length,
    1
  );
  assert.ok(!JSON.stringify(harness.proxyEvents).includes('ya29.'));
  assert.equal(
    harness.requestEnds.some((entry) => entry.statusCode === 401),
    false
  );
}

async function assertRefreshPassesRejectedToken() {
  const proxyEvents = [];
  const refreshOptions = [];
  let handlerToken = '';
  let jsonError = null;
  const retryGoogleOfficialAuthOnce = createGoogleOfficialAuthRetry({
    logProxyEvent: (kind, payload) => proxyEvents.push({ kind, payload }),
    refreshAntigravityOfficialAccessToken: async (options) => {
      refreshOptions.push(options);
      return 'ya29.new-route-token';
    },
  });
  const done = new Promise((resolve) => {
    const handled = retryGoogleOfficialAuthOnce({
      clientReq: { method: 'POST', url: '/v1/responses' },
      clientRes: {},
      prepared: officialPrepared(),
      apiKey: 'ya29.old-route-token',
      useCodeAssist: true,
      proxyRes: { statusCode: 401 },
      routeType: 'responses_to_gemini',
      upstreamPath: '/responses',
      startTime: Date.now(),
      sendJsonError: (_clientRes, statusCode, payload) => {
        jsonError = { statusCode, payload };
        resolve();
      },
      logRequestEnd: noop,
      target: {},
      handler: (_clientReq, _clientRes, _prepared, _target, apiKey) => {
        handlerToken = apiKey;
        resolve();
      },
    });
    assert.equal(handled, true);
  });
  await done;

  assert.equal(handlerToken, 'ya29.new-route-token');
  assert.equal(jsonError, null);
  assert.deepEqual(refreshOptions, [
    {
      reason: 'upstream_auth_failure',
      routeType: 'responses_to_gemini',
      rejectedToken: 'ya29.old-route-token',
    },
  ]);
  assert.deepEqual(
    proxyEvents.map((event) => event.payload.action),
    ['refresh_antigravity_token']
  );
  assert.ok(!JSON.stringify(proxyEvents).includes('ya29.'));
}

(async () => {
  await assertRetriesWithFreshToken('chat');
  await assertRetriesWithFreshToken('responses');
  await assertRefreshPassesRejectedToken();
  console.log('[google-official-auth-retry.test] ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
