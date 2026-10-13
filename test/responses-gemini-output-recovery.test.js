'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createResponsesGeminiHandler } = require('../lib/proxy/handlers/responses-gemini');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');
const { createUpstreamStreamGuard } = require('../lib/proxy/handlers/upstream-stream-guard');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { parseClaudeSseEvent, deltaPartialJson } = require('../lib/proxy/sse');
const { createGeminiResponsesStream } = require('../lib/proxy/gemini-responses-stream');
const noop = () => {};
const protocol = createGeminiProtocol({
  filterClaudeCompatibleBlocks: (value) =>
    Array.isArray(value) ? value : [{ type: 'text', text: value }],
  isClaudeThinkingBlock: () => false,
  geminiFunctionCallArgs: (call) => call.args || {},
  sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
  stableHash: () => 'hash',
  fallbackId: () => 'id',
  sampleGeminiToolEvent: noop,
});
const streamFns = createClaudeStream({
  ...protocol,
  sampleOutboundSse: noop,
  sampleGeminiToolEvent: noop,
  auditToolCall: noop,
  sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
  geminiFunctionCallArgs: (call) => call.args || {},
  cleanToolArgs: (_name, args) => args,
  stripEmptyOptionalToolArgs: (_name, args) => args,
});
const codeAssist = createCodeAssist({ fallbackId: () => 'probe' });

function runRoute({
  requestMode,
  requestMessages = [{ role: 'user', content: 'private prompt' }],
  stream = true,
  payloads,
  fragment = false,
  truncated = false,
  cancel = false,
  holdRecovery = false,
  converterMode,
  slowClient = false,
}) {
  const attempts = [];
  const chunks = [];
  const events = [];
  const endStatuses = [];
  let writes = 0;
  let pauses = 0;
  let resumes = 0;
  const clientReq = { method: 'POST', url: '/v1/responses' };
  const clientRes = new EventEmitter();
  clientRes.headersSent = false;
  clientRes.writeHead = () => {
    clientRes.headersSent = true;
  };
  clientRes.write = (chunk) => {
    chunks.push(String(chunk));
    writes += 1;
    return !(slowClient && writes === 1);
  };
  clientRes.end = () => {
    clientRes.writableEnded = true;
    clientRes.emit('finish');
  };
  const pending = [];
  const transport = {
    request(_options, callback) {
      const req = new EventEmitter();
      req.destroy = () => {
        req.destroyed = true;
      };
      req.end = (body) => {
        attempts.push(JSON.parse(body));
        pending.push(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.setEncoding = noop;
          res.pause = () => {
            pauses += 1;
          };
          res.resume = () => {
            resumes += 1;
          };
          res.destroy = noop;
          req.emit('response', res);
          callback(res);
          if (holdRecovery && attempts.length === 2) return;
          const payload = payloads[attempts.length - 1] || payloads.at(-1);
          const text = stream
            ? 'data: ' + JSON.stringify({ response: payload }) + (fragment ? '' : '\n\n')
            : JSON.stringify({ response: payload });
          if (fragment) {
            const middle = Math.floor(text.length / 2);
            res.emit('data', text.slice(0, middle));
            res.emit('data', text.slice(middle));
          } else res.emit('data', text);
          if (slowClient) clientRes.emit('drain');
          if (cancel) {
            clientRes.destroyed = true;
            clientRes.emit('close');
          }
          if (truncated) {
            res.aborted = true;
            res.emit('aborted');
          } else res.emit('end');
          res.emit('close');
          req.emit('close');
        });
      };
      return req;
    },
  };
  const guard = createUpstreamStreamGuard({ logProxyEvent: noop, logRequestEnd: noop });
  let compatibilityCalls = 0;
  let semanticState;
  const ctx = {
    ...protocol,
    tryOpenAIChatToGemini: undefined,
    ...streamFns,
    ...codeAssist,
    https: transport,
    http: transport,
    CORS_HEADERS: {},
    sendJsonError: (_res, _status, body) => {
      chunks.push(JSON.stringify(body));
      clientRes.end();
    },
    logRequestEnd: (_method, _path, _start, code) => endStatuses.push(code),
    logProxyEvent: (kind, fields) => events.push({ kind, ...fields }),
    fallbackId: () => 'id',
    stableCreated: () => 1,
    sampleResponseChunk: noop,
    parseProxyBody: () => ({
      model: 'gemini-3.8-flash',
      input: 'private prompt',
      stream,
      max_output_tokens: 65536,
      reasoning: { effort: 'high' },
    }),
    responsesToChatWithHistory: (_res, parsed) => ({ ...parsed, reasoning_effort: 'high' }),
    openAIChatToClaudeMessages: () => ({
      messages: [{ role: 'user', content: 'private prompt' }],
      reasoning_effort: 'high',
    }),
    processClaudeSseChunkToOpenAI: (sink, chunk) => sink.write(chunk),
    flushClaudeSseToOpenAI: noop,
    processOpenAIChatSseChunkToResponses: (sink, chunk) => sink.write(chunk),
    createChatToResponsesBridge: () => ({ responseState: {}, flush: noop }),
    rememberResponsesFromBridge: noop,
    rejectUnsupportedResponsesNonOpenAIConversion: () => false,
    unwrapCodeAssistSseEvent: (text) =>
      text.replace(
        /data: (.*)/g,
        (_line, data) => 'data: ' + JSON.stringify(JSON.parse(data).response)
      ),
    unwrapCodeAssistResponse: (value) => value.response || value,
    parseJsonOrSseJson: JSON.parse,
    onProxyTimeout: (req) => () => {
      req.destroy();
      clientRes.end();
    },
    onProxyError: () => noop,
    collectBoundedResponse: (res, _client, _path, _type, callback) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => callback(body));
    },
  };
  if (converterMode) {
    const converter = createOpenAIProtocol({
      cleanToolArgs: (_name, input) => input,
      fallbackId: () => 'id',
      stableCreated: () => 1,
      parseClaudeSseEvent,
      deltaPartialJson,
    });
    Object.assign(ctx, converter);
    if (converterMode === 'direct') {
      ctx.createGeminiResponsesStream = (responseState, options) =>
        createGeminiResponsesStream({
          responseState,
          options,
          emitter: converter.createResponsesStreamEmitter(true),
          deps: {
            ...protocol,
            cleanToolArgs: (_name, input) => input,
            sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
            geminiFunctionCallArgs: (call) => call.args || {},
          },
        });
    }
    if (converterMode === 'sse') {
      ctx.processClaudeEventToOpenAI = undefined;
      ctx.processOpenAIChatChunkToResponses = undefined;
    }
    ctx.createChatToResponsesBridge = (sink) => {
      const responseState = {
        id: 'resp_fixture',
        created_at: 1,
        model: 'fixture',
        buffer: '',
        outputIndex: 0,
        text: '',
        pendingToolCalls: [],
        toolCalls: [],
        completedOutputItems: [],
      };
      return {
        responseState,
        flush: () => converter.flushOpenAIChatSseToResponses(sink, responseState),
      };
    };
  }
  if (requestMode) {
    const requestProtocol = createOpenAIProtocol({
      fallbackId: () => 'id',
      stableCreated: () => 1,
    });
    ctx.responsesToChatWithHistory = (_res, parsed) => ({
      ...parsed,
      messages: requestMessages,
      reasoning_effort: 'high',
    });
    ctx.openAIChatToClaudeMessages = (body, model) => {
      compatibilityCalls++;
      return requestProtocol.openAIChatToClaudeMessages(body, model);
    };
    if (requestMode === 'direct') ctx.tryOpenAIChatToGemini = protocol.tryOpenAIChatToGemini;
    if (requestMode === 'semantic') {
      semanticState = createResponsesState({
        fallbackId: () => 'id',
        sendJsonError: ctx.sendJsonError,
        log: { info: noop, warn: noop },
      });
      ctx.resolveResponsesHistory = semanticState.resolveResponsesHistory;
      ctx.rememberResponsesFromBridge = semanticState.rememberResponsesFromBridge;
      ctx.responsesToChatWithHistory = () => assert.fail('Chat history selected');
      ctx.openAIChatToClaudeMessages = () => assert.fail('Chat Claude request selected');
      ctx.tryOpenAIChatToGemini = () => assert.fail('Chat Gemini request selected');
      ctx.claudeMessagesToGemini = () => assert.fail('Claude Gemini request selected');
    }
  }
  const handle = createResponsesGeminiHandler(ctx, {
    boundedResponseContext: noop,
    proxyErrorContext: () => ({}),
    retryGoogleOfficialAuthOnce: () => false,
    geminiStreamBufferMaxChars: 1024 * 1024,
    guardConversionStream: (res, options, _label, logType, onFailure) =>
      guard(res, { ...options, logType, onFailure }),
    handleResponsesToGeminiJson: ({ responseBody }) => {
      chunks.push(responseBody);
      clientRes.end();
    },
  });
  handle(
    clientReq,
    clientRes,
    {
      rewriteTo: 'gemini-3.8-flash-tiered',
      model: 'gemini-3.8-flash',
      authMode: 'official-login',
      authProvider: 'google',
      profile: { protocol: 'gemini' },
      buffer: Buffer.from('{}'),
    },
    { protocol: 'https:', hostname: 'example.test', path: '/v1beta' },
    'ya29.fake',
    '/responses',
    Date.now()
  );
  while (pending.length) pending.shift()();
  if (slowClient) clientRes.emit('drain');
  return {
    compatibilityCalls,
    attempts,
    chunks: chunks.join(''),
    events,
    clientRes,
    endStatuses,
    pauses,
    resumes,
    semanticState,
  };
}

const empty = {
  candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
  usageMetadata: { thoughtsTokenCount: 32768 },
};
const success = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] };

function outputRecoveryEvents(result) {
  return result.events.filter((event) => event.kind === 'gemini_output_budget_recovery');
}

test('native Responses requests preserve recovery, slow clients and cancellation without Chat', () => {
  for (const options of [
    { payloads: [empty, success], fragment: true },
    { payloads: [empty, empty] },
    { payloads: [success], slowClient: true },
    { payloads: [empty], cancel: true },
    { payloads: [empty], truncated: true },
  ]) {
    const baseline = runRoute({ ...options, requestMode: 'direct', converterMode: 'direct' });
    const native = runRoute({ ...options, requestMode: 'semantic', converterMode: 'direct' });
    assert.deepEqual(native.attempts, baseline.attempts);
    assert.equal(native.chunks, baseline.chunks);
    assert.deepEqual(native.endStatuses, baseline.endStatuses);
    assert.equal(native.compatibilityCalls, 0);
    if (options.cancel || options.truncated)
      assert.equal(native.semanticState.responsesHistory.size, 0);
    else {
      const entry = native.semanticState.responsesHistory.get('resp_fixture');
      assert.equal(entry.version, 2);
      assert.equal(entry.history[0].parts[0].text, 'private prompt');
      if (options.payloads.at(-1) === success)
        assert.equal(entry.history.at(-1).parts[0].text, 'ok');
    }
  }
});

test('direct conversion preserves Code Assist recovery, cancellation and terminal frames', () => {
  for (const options of [
    { payloads: [empty, success], fragment: true },
    { payloads: [empty, empty] },
    { payloads: [success] },
    { payloads: [success], slowClient: true },
    { payloads: [empty], cancel: true },
    { payloads: [empty], truncated: true },
    ...[
      { text: 'partial' },
      { text: 'reason', thought: true },
      { functionCall: { name: 'lookup', args: { q: 1 } } },
    ].map((part) => ({
      payloads: [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [part] } }] }],
    })),
  ]) {
    const wire = runRoute({ ...options, converterMode: 'sse' });
    const direct = runRoute({ ...options, converterMode: 'direct' });
    assert.equal(direct.chunks, wire.chunks, 'real route emits byte-identical output');
    assert.deepEqual(direct.attempts, wire.attempts, 'retry request and count match');
    assert.equal(direct.clientRes.writableEnded, wire.clientRes.writableEnded);
    assert.deepEqual(direct.endStatuses, wire.endStatuses);
    if (options.slowClient) {
      assert.ok(direct.pauses > 0);
      assert.ok(direct.resumes > 0);
      assert.deepEqual(direct.endStatuses, [200]);
    }
    if (options.payloads[0] === empty && options.payloads[1] === success) {
      assert.equal(direct.attempts.length, 2);
      assert.equal((direct.chunks.match(/event: response.created\n/g) || []).length, 1);
      assert.ok(direct.chunks.includes('event: response.completed\n'));
    }
  }
});

test('stream and JSON recover once with higher budget and unchanged high thinking', () => {
  for (const stream of [true, false]) {
    const h = runRoute({ stream, payloads: [empty, success], fragment: stream });
    assert.equal(h.attempts.length, 2);
    assert.equal(h.attempts[0].request.generationConfig.maxOutputTokens, 32768);
    assert.equal(h.attempts[1].request.generationConfig.maxOutputTokens, 65536);
    assert.equal(h.attempts[1].request.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.ok(h.chunks.includes('ok'));
    assert.equal(h.chunks.includes('output token budget'), false);
    assert.equal((h.chunks.match(/event: message_start/g) || []).length, stream ? 1 : 0);
    assert.equal(outputRecoveryEvents(h).length, 1);
    assert.equal(h.clientRes.writableEnded, true);
    assert.equal(JSON.stringify(h.events).includes('private prompt'), false);
  }
});

test('second exhaustion stays incomplete and is never retried a third time', () => {
  for (const stream of [true, false]) {
    const h = runRoute({ stream, payloads: [empty, empty] });
    assert.equal(h.attempts.length, 2);
    assert.ok(h.chunks.includes(stream ? 'max_tokens' : 'MAX_TOKENS'));
  }
});

test('partial text, thinking, tools, and whitespace prevent replay even on MAX_TOKENS', () => {
  for (const part of [
    { text: 'partial' },
    { text: 'thought', thought: true },
    { functionCall: { name: 'run', args: {} } },
    { text: ' ' },
  ]) {
    const result = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [part] } }] };
    for (const stream of [true, false]) {
      const h = runRoute({ stream, payloads: [result] });
      assert.equal(h.attempts.length, 1);
      assert.equal(outputRecoveryEvents(h).length, 0);
      assert.equal(h.clientRes.writableEnded, true);
    }
  }
});

test('aborted streams and cancelled clients never trigger budget recovery', () => {
  for (const options of [{ truncated: true }, { cancel: true }]) {
    const h = runRoute({ payloads: [empty], ...options });
    assert.equal(h.attempts.length, 1);
    assert.equal(outputRecoveryEvents(h).length, 0);
  }
});

test('an absolute deadline terminates a stalled recovery request', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = runRoute({ payloads: [empty], holdRecovery: true });
  assert.equal(h.attempts.length, 2);
  assert.notEqual(h.clientRes.writableEnded, true);
  t.mock.timers.tick(180000);
  assert.equal(h.clientRes.writableEnded, true);
});

test('unknown parts and additional candidates cannot be replayed', () => {
  for (const payload of [
    {
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: { parts: [{ executableCode: { code: 'private' } }] },
        },
      ],
    },
    {
      candidates: [
        { finishReason: 'MAX_TOKENS', content: { parts: [] } },
        { content: { parts: [{ functionCall: { name: 'run' } }] } },
      ],
    },
  ]) {
    for (const stream of [true, false]) {
      const h = runRoute({ stream, payloads: [payload] });
      assert.equal(h.attempts.length, 1);
      assert.equal(outputRecoveryEvents(h).length, 0);
    }
  }
});

test('native request mapping preserves route retries and reasoning history', () => {
  for (const options of [
    { payloads: [empty, success] },
    { payloads: [success], stream: false },
    { payloads: [success], slowClient: true },
    { payloads: [empty], cancel: true },
  ]) {
    const baseline = runRoute({ ...options, converterMode: 'direct', requestMode: 'legacy' });
    const direct = runRoute({ ...options, converterMode: 'direct', requestMode: 'direct' });
    assert.deepEqual(direct.attempts, baseline.attempts);
    assert.equal(direct.chunks, baseline.chunks);
    assert.deepEqual(direct.endStatuses, baseline.endStatuses);
    assert.equal(direct.compatibilityCalls, 0);
    assert.ok(baseline.compatibilityCalls > 0);
    assert.equal(direct.attempts[0].request.contents[0].parts[0].text, 'private prompt');
  }
  const reasoning = runRoute({
    payloads: [success],
    converterMode: 'direct',
    requestMode: 'direct',
    requestMessages: [{ role: 'assistant', content: 'answer', reasoning_content: 'reason' }],
  });
  assert.equal(reasoning.compatibilityCalls, 0);
  assert.deepEqual(reasoning.attempts[0].request.contents[0].parts, [
    { thought: true, text: 'reason' },
    { text: 'answer' },
  ]);
});
