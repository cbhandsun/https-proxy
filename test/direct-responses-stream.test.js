'use strict';

const assert = require('node:assert/strict');
const { harness } = require('./internal-stream-events.test');
const { createGeminiResponsesStream } = require('../lib/proxy/gemini-responses-stream');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { finishGeminiClaudeStream } = require('../lib/proxy/handlers/route-gemini-utils');
const { geminiUsageToClaude } = require('../lib/proxy/gemini-usage');

const noop = () => {};
const deps = {
  cleanToolArgs: (_name, input) => input,
  stripEmptyOptionalToolArgs: (input) => input,
  sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
  sampleGeminiToolEvent: noop,
  auditToolCall: noop,
  sampleOutboundSse: noop,
  geminiFunctionCallArgs: (call) => call.args || {},
  geminiClaudeToolId: (call, index) => call.id || 'call_' + index,
  rememberGeminiToolCall: noop,
  claudeStopReasonFromGemini: (reason) =>
    reason === 'MAX_TOKENS' ? 'max_tokens' : reason === 'SAFETY' ? 'refusal' : 'end_turn',
  geminiUsageToClaude,
  geminiInlineImageToClaudeBlock: (part) =>
    part.inlineData ? { type: 'image', source: part.inlineData } : null,
};

function runGemini(direct, payloads, options = {}, collect = true, extraDeps = {}) {
  const h = harness(!direct, options, collect);
  const config = { ...deps, ...extraDeps, protocolOptions: options };
  if (direct) {
    const converter = createGeminiResponsesStream({
      deps: config,
      responseState: h.responses,
      emitter: h.protocol.createResponsesStreamEmitter(true),
      options: { toolPreambleText: 'Working.' },
    });
    for (const item of payloads)
      converter.processChunk(
        h.sink,
        typeof item === 'string' ? item : 'data: ' + JSON.stringify(item) + '\n\n'
      );
    converter.finish(h.sink);
    return { ...h, provider: converter.state };
  }
  const stream = createClaudeStream(config);
  const state = {
    buffer: '',
    textIndex: -1,
    usage: { input_tokens: 0, output_tokens: 0 },
    responsesToolPreambleText: 'Working.',
  };
  h.send('message_start', { message: { usage: state.usage } });
  for (const item of payloads) {
    if (typeof item === 'string') throw new Error('Wire-fragment fixtures require direct mode');
    stream.processGeminiSseEvent(h.claudeSink, 'data: ' + JSON.stringify(item), state, 'fixture');
  }
  finishGeminiClaudeStream({ sink: h.claudeSink, state, targetModel: 'fixture', ...stream });
  h.finish();
  return { ...h, provider: state };
}
const payload = (parts = [], reason = 'STOP', usage) => ({
  candidates: [{ content: { parts }, finishReason: reason }],
  ...(usage ? { usageMetadata: usage } : {}),
});
const frame = (type, data = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
function runClaude(direct, frames, options = {}, collect = true) {
  const h = harness(false, options, collect);
  if (direct) {
    const converter = h.protocol.createClaudeResponsesStream(h.responses);
    for (const raw of frames) converter.processChunk(h.sink, raw, converter.state);
    converter.flush(h.sink, converter.state);
    return { ...h, provider: converter.state };
  }
  for (const raw of frames) h.protocol.processClaudeSseChunkToOpenAI(h.chatSink, raw, h.chat);
  h.finish();
  return { ...h, provider: h.chat };
}
function checkSafeFailure(h) {
  assert.equal(h.responses.failed, true);
  const output = h.writes.join('');
  assert.equal((output.match(/event: response.failed\n/g) || []).length, 1);
  assert.equal(output.includes('event: response.completed\n'), false);
  assert.equal(output.includes('do-not-leak'), false);
  assert.equal(output.includes('"type":"function_call"'), false);
}

if (require.main === module) {
  for (const reason of ['STOP', 'MAX_TOKENS', 'SAFETY']) {
    for (const parts of [
      [],
      [{ text: '中文 😀\n"\\' }],
      [{ text: ' ', thought: true }],
      [{ thought: true, text: 'reason' }, { text: 'answer' }],
      [{ text: 'before' }, { thought: true, text: 'reason' }, { text: 'after' }],
      [{ inlineData: { media_type: 'image/png', data: 'AA==' } }],
      [
        { functionCall: { name: 'lookup', args: { q: 1 } }, thoughtSignature: 'signature' },
        { functionCall: { name: 'lookup', args: { q: 2 } } },
      ],
      [{ text: 'answer' }, { functionCall: { name: 'lookup', args: {} } }],
    ]) {
      const input = [
        payload(parts, reason, {
          promptTokenCount: 12,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 3,
          cachedContentTokenCount: 4,
          totalTokenCount: 20,
        }),
      ];
      assert.deepEqual(runGemini(true, input).writes, runGemini(false, input).writes);
    }
  }
  const partial = [
    payload([{ functionCall: { name: 'lookup', args: { q: 'a' } } }], null),
    payload([{ functionCall: { args: { q: 'abc', other: 1 } } }]),
  ];
  assert.deepEqual(runGemini(true, partial).writes, runGemini(false, partial).writes);
  const signatures = [];
  runGemini(
    true,
    [payload([{ functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'signature' }])],
    {},
    true,
    { rememberGeminiToolCall: (...args) => signatures.push(args) }
  );
  assert.equal(signatures[0][3], 'signature');
  for (const input of [
    'data: {"secret":"do-not-leak"\n\n',
    'data: null\n\n',
    'data: []\n\n',
    'data: {"candidates":"invalid"}\n\n',
    'data: {"error":{"message":"do-not-leak"}}\n\n',
    'data: {"candidates":[{"content":{"parts":[null]}}]}\n\n',
  ])
    checkSafeFailure(runGemini(true, [input]));
  for (const reason of ['MALFORMED_FUNCTION_CALL', 'OTHER', 'FINISH_REASON_UNSPECIFIED', 'unknown'])
    checkSafeFailure(
      runGemini(true, [payload([{ functionCall: { name: 'lookup', args: {} } }], reason)])
    );
  checkSafeFailure(
    runGemini(true, [
      { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: {} } }] } }] },
    ])
  );
  checkSafeFailure(runGemini(true, []));
  for (const call of [
    false,
    { name: 'lookup', args: [] },
    { name: 'lookup', args: null },
    { name: 'lookup', args: '{do-not-leak' },
    { name: 'lookup', args: '[1]' },
    { name: 'lookup', args: 'null' },
    { name: 42, args: {} },
    { name: 'lookup', id: {}, args: {} },
    { name: 'lookup', args: {}, willContinue: true },
    {
      name: 'lookup',
      partialArgs: [{ jsonPath: '$.q', stringValue: 'partial', willContinue: true }],
    },
    { name: 'lookup', args: {}, willContinue: 'false' },
  ])
    checkSafeFailure(runGemini(true, [payload([{ functionCall: call }])]));
  for (const reason of [
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
  ]) {
    const h = runGemini(true, [payload([{ functionCall: { name: 'lookup', args: {} } }], reason)]);
    assert.equal(h.responses.finishReason, 'content_filter');
    assert.equal(h.responses.toolCalls.length, 0);
    assert.ok(h.writes.join('').includes('event: response.incomplete\n'));
  }
  for (const options of [
    { maxConversionStreamBytes: 200 },
    { maxSseBufferChars: 20 },
    { maxConversionToolArgumentBytes: 3 },
    { maxConversionToolCalls: 1 },
  ])
    checkSafeFailure(
      runGemini(
        true,
        [
          payload([
            { functionCall: { name: 'lookup', args: { q: 1 } } },
            { functionCall: { name: 'lookup', args: { q: 2 } } },
          ]),
        ],
        options
      )
    );
  // Sanitization expansion and non-object results remain bounded and non-executable.
  checkSafeFailure(
    runGemini(
      true,
      [payload([{ functionCall: { name: 'lookup', args: {} } }])],
      { maxConversionToolArgumentBytes: 10 },
      true,
      { cleanToolArgs: () => ({ q: 'x'.repeat(100) }) }
    )
  );
  checkSafeFailure(
    runGemini(true, [payload([{ functionCall: { name: 'lookup', args: {} } }])], {}, true, {
      cleanToolArgs: () => [],
    })
  );
  const raw = 'data: ' + JSON.stringify(payload([{ text: 'fragment' }])) + '\n\n';
  assert.deepEqual(
    runGemini(true, [raw.slice(0, 15), raw.slice(15)]).writes,
    runGemini(true, [raw]).writes
  );
  assert.deepEqual(runGemini(true, [raw.trimEnd()]).writes, runGemini(true, [raw]).writes);

  const start = frame('message_start', {
    message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
  });
  const startTool = (index = 1) =>
    frame('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: 'call_' + index, name: 'lookup', input: {} },
    });
  const args = (value, index = 1) =>
    frame('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: value },
    });
  const stopTool = (index = 1) => frame('content_block_stop', { index });
  for (const reason of ['end_turn', 'tool_use', 'max_tokens', 'refusal']) {
    const input = [
      start,
      frame('content_block_delta', { delta: { type: 'text_delta', text: 'ok' } }),
      startTool(),
      args('{"q":1}'),
      stopTool(),
      startTool(2),
      args('{"q":2}', 2),
      stopTool(2),
      frame('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 8 } }),
      frame('message_stop'),
    ];
    assert.deepEqual(runClaude(true, input).writes, runClaude(false, input).writes);
    const joined = input.join('');
    assert.deepEqual(
      runClaude(true, [joined.slice(0, 29), joined.slice(29)]).writes,
      runClaude(true, input).writes
    );
  }
  for (const input of [
    [],
    [start],
    [start, frame('message_stop')],
    [start, startTool(), args('{}'), stopTool(), frame('message_stop')],
    [start, startTool(), args('{"q":1}'), stopTool()],
    [start, startTool(), args('{"secret":"do-not-leak"'), stopTool(), frame('message_stop')],
    [start, startTool(), args('{}'), stopTool(), startTool(2), args('[]', 2), stopTool(2)],
  ])
    checkSafeFailure(runClaude(true, input));
  for (const reason of ['unknown', 'compaction']) {
    checkSafeFailure(
      runClaude(true, [
        start,
        startTool(),
        args('{}'),
        stopTool(),
        frame('message_delta', { delta: { stop_reason: reason } }),
        frame('message_stop'),
      ])
    );
  }
  for (const reason of ['pause_turn', 'model_context_window_exceeded']) {
    const h = runClaude(true, [
      start,
      startTool(),
      args('{}'),
      stopTool(),
      frame('message_delta', { delta: { stop_reason: reason } }),
      frame('message_stop'),
    ]);
    assert.equal(h.responses.toolCalls.length, 0);
    assert.equal(h.responses.finishReason, reason === 'pause_turn' ? 'stop' : 'length');
  }
  for (const options of [
    { maxConversionStreamBytes: 20 },
    { maxSseBufferChars: 20 },
    { maxConversionToolArgumentBytes: 3 },
    { maxConversionToolCalls: 1 },
  ])
    checkSafeFailure(
      runClaude(
        true,
        [startTool(), args('{"q":1}'), stopTool(), startTool(2), args('{}', 2)],
        options
      )
    );
  console.log('direct-responses-stream.test.js passed');
}

module.exports = { runGemini, runClaude, payload };
