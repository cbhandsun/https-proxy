'use strict';
const { WORKLOADS, createBenchmarkRequest } = require('./protocol-benchmark-workloads');

const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../../lib/proxy/claude-filters');
const { parseResponsesHistory } = require('../../lib/proxy/responses-semantic-history');
const { createConversionStreamOutput } = require('../../lib/proxy/conversion-stream-output');
// Development benchmarks share the already differential-tested stream fixtures.
// Neither fixture executes its test suite when imported.
const { runGemini, runClaude, payload } = require('../../test/direct-responses-stream.test');
const noop = () => {};
const digest = (value) => createHash('sha256').update(value).digest('hex');
function canonical(request, target) {
  const copy = JSON.parse(JSON.stringify(request));
  if (target === 'Claude') {
    function blocks(value) {
      if (typeof value === 'string') return [{ type: 'text', text: value }];
      return value.map((block) =>
        block.type === 'tool_result' ? { ...block, content: blocks(block.content) } : block
      );
    }
    for (const message of copy.messages) message.content = blocks(message.content);
  }
  if (target === 'Gemini') {
    for (const message of copy.contents)
      for (const part of message.parts) {
        if (part.functionCall) delete part.functionCall.id;
        if (part.functionResponse) delete part.functionResponse.id;
      }
  }
  if (target === 'Responses') {
    for (const item of copy.input) if (item.type === 'function_call') delete item.id;
  }
  function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])])
      );
    return value;
  }
  return JSON.stringify(ordered(copy));
}
function createRequestCases(workload = 'tool-history') {
  const deps = {
    ...require('../../lib/proxy/tools'),
    ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'drop' } }),
    fallbackId: (prefix, seed) => prefix + '_' + digest(JSON.stringify(seed)).slice(0, 16),
    stableHash: (seed) => digest(JSON.stringify(seed)),
    stableCreated: () => 1,
    sampleGeminiToolEvent: noop,
    protocolOptions: { contextWindowPolicy: 'disabled' },
  };
  const gemini = createGeminiProtocol(deps);
  const ai = createOpenAIProtocol({ ...deps, ...gemini });
  const source = createBenchmarkRequest(workload);
  const chat = ai.openAIResponsesToChat(source);
  const claude = ai.openAIChatToClaudeMessages(chat, 'claude-sonnet-4-6');
  const requests = [
    [
      'responses-claude',
      'Claude',
      () =>
        ai.responsesHistoryToClaude(
          source,
          { history: parseResponsesHistory(source.input, deps, source.instructions) },
          'claude-sonnet-4-6'
        ),
      () => ai.openAIChatToClaudeMessages(ai.openAIResponsesToChat(source), 'claude-sonnet-4-6'),
    ],
    [
      'responses-gemini',
      'Gemini',
      () =>
        gemini.responsesHistoryToGemini(
          source,
          { history: parseResponsesHistory(source.input, deps, source.instructions) },
          'gemini-3.8-flash'
        ).request,
      () =>
        gemini.tryOpenAIChatToGemini(ai.openAIResponsesToChat(source), 'gemini-3.8-flash').request,
    ],
    [
      'chat-gemini',
      'Gemini',
      () => gemini.tryOpenAIChatToGemini(chat, 'gemini-3.8-flash').request,
      () =>
        gemini.claudeMessagesToGemini(
          ai.openAIChatToClaudeMessages(chat, 'gemini-3.8-flash'),
          'gemini-3.8-flash'
        ),
    ],
    [
      'claude-responses',
      'Responses',
      () => ai.claudeMessagesToResponsesRequest(claude, 'model', { codex: false }),
      () =>
        ai.openAIChatToResponsesRequest(ai.claudeMessagesToOpenAIChat(claude, 'model'), {
          codex: false,
        }),
    ],
  ];
  return requests.map(([id, target, native, legacy]) => ({
    id: workload === 'tool-history' ? id : id + '-' + workload,
    variants: ['native', 'legacy'],
    inputBytes: Buffer.byteLength(
      JSON.stringify(id === 'claude-responses' ? claude : id === 'chat-gemini' ? chat : source)
    ),
    run(variant, capture = false) {
      const request = (variant === 'native' ? native : legacy)();
      const wire = JSON.stringify(request);
      return {
        outputBytes: Buffer.byteLength(wire),
        ...(capture ? { fingerprint: digest(canonical(request, target)) } : {}),
      };
    },
  }));
}
function createStreamCases() {
  const text = 'synthetic 中文 😀 ' + 'x'.repeat(64);
  const geminiFrames = Array.from({ length: 100 }, () => payload([{ text }], null));
  geminiFrames.push(
    payload([{ functionCall: { name: 'lookup', args: { q: 'synthetic' } } }], 'STOP', {
      promptTokenCount: 12,
      candidatesTokenCount: 108,
    })
  );
  const frame = (type, data) =>
    'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
  const claudeFrames = [frame('message_start', { message: { usage: { input_tokens: 12 } } })];
  for (let i = 0; i < 100; i++)
    claudeFrames.push(frame('content_block_delta', { delta: { type: 'text_delta', text } }));
  claudeFrames.push(
    frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 108 } }),
    frame('message_stop', {})
  );
  return [
    ['gemini-responses-stream', geminiFrames, runGemini],
    ['claude-responses-stream', claudeFrames, runClaude],
  ].map(([id, frames, convert]) => ({
    id,
    variants: ['native', 'legacy'],
    inputBytes: Buffer.byteLength(JSON.stringify(frames)),
    run(variant, capture = false) {
      const result = convert(variant === 'native', frames, {}, capture);
      if (result.responses.failed || !result.responses.done)
        throw new Error('Benchmark stream did not complete');
      return {
        outputBytes: result.bytes(),
        ...(capture ? { fingerprint: digest(result.writes.join('')) } : {}),
      };
    },
  }));
}
function slowClient(mode) {
  const client = new EventEmitter(),
    upstream = new EventEmitter();
  let bytes = 0,
    outstanding = 0,
    peak = 0,
    writes = 0,
    pauses = 0,
    reports = 0;
  client.writableLength = 0;
  client.write = (chunk) => {
    writes++;
    bytes += Buffer.byteLength(chunk);
    client.writableLength += Buffer.byteLength(chunk);
    return false;
  };
  client.end = () => {
    client.writableEnded = true;
    client.emit('finish');
  };
  client.destroy = () => {
    client.destroyed = true;
    client.emit('close');
  };
  upstream.pause = () => {
    pauses++;
  };
  upstream.resume = noop;
  upstream.destroy = noop;
  const flow = createConversionStreamOutput({
    proxyRes: upstream,
    clientRes: client,
    clientReq: { method: 'POST' },
    upstreamPath: '/synthetic',
    startTime: 1,
    logRequestEnd: () => {
      reports++;
    },
    protocolOptions: { maxConversionOutputBufferBytes: mode === 'overflow' ? 2048 : 65536 },
  });
  for (let i = 0; i < 64 && !flow.isStopped(); i++) {
    const accepted = flow.clientRes.write('x'.repeat(512));
    if (!flow.isStopped()) {
      outstanding += 512;
      peak = Math.max(peak, outstanding);
    }
    if (mode === 'cancel' && i === 10) client.destroy();
    if (mode === 'drain' && !accepted && i % 8 === 7) {
      while (outstanding > 0 && !flow.isStopped()) {
        client.writableLength = 0;
        client.emit('drain');
        outstanding = client.writableLength;
      }
    }
  }
  if (mode === 'drain') {
    flow.clientRes.end();
    while (!client.writableEnded && !flow.isStopped()) {
      client.writableLength = 0;
      client.emit('drain');
    }
  }
  const stopped = flow.isStopped();
  flow.dispose();
  if (
    (mode === 'drain' && !client.writableEnded) ||
    (mode !== 'drain' && (!stopped || reports !== 1))
  )
    throw new Error('Benchmark slow-client lifecycle failed');
  return {
    outputBytes: bytes,
    bufferedPayloadPeakBytes: peak,
    downstreamWrites: writes,
    upstreamPauses: pauses,
    stopped,
    reports,
  };
}
function createBenchmarkCases() {
  return [
    ...WORKLOADS.flatMap((workload) => createRequestCases(workload)),
    ...createStreamCases(),
    ...['drain', 'cancel', 'overflow'].map((mode) => ({
      id: 'slow-client-' + mode,
      variants: ['guard'],
      inputBytes: 32768,
      run: () => slowClient(mode),
    })),
  ];
}
module.exports = { createBenchmarkCases };
