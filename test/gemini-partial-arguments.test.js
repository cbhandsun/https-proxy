'use strict';
const assert = require('node:assert/strict');
const {
  createGeminiPartialArguments,
  parseArgumentPath,
} = require('../lib/proxy/gemini-partial-arguments');
const { normalizeCompletedGeminiFunctionInput } = require('../lib/proxy/gemini-function-input');
const { harness } = require('./internal-stream-events.test');
const { createGeminiStreamDecoder } = require('../lib/proxy/gemini-stream-decoder');
const { createGeminiChatStream } = require('../lib/proxy/gemini-chat-stream');
const { createGeminiClaudeStream } = require('../lib/proxy/gemini-claude-stream');
const { createGeminiResponsesStream } = require('../lib/proxy/gemini-responses-stream');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { geminiUsageToClaude } = require('../lib/proxy/gemini-usage');
const noop = () => {};
const part = (jsonPath, value, willContinue = false) => ({
  jsonPath,
  stringValue: value,
  willContinue,
});
const first = {
  id: 'a',
  name: 'lookup',
  partialArgs: [part('$.q', '中文 ', true)],
  willContinue: true,
};
const second = {
  id: 'b',
  name: 'lookup',
  partialArgs: [part("$['nested.key'][0].text", 'parallel')],
  willContinue: false,
};
const last = { id: 'a', partialArgs: [part('$.q', '😀')], willContinue: false };
assert.deepEqual(parseArgumentPath('$["a.b"][0][\'x\']'), ['a.b', 0, 'x']);
assert.deepEqual(parseArgumentPath('$["\\u4e2d"][0]'), ['中', 0]);
assert.deepEqual(parseArgumentPath('$[' + JSON.stringify('quoted"key') + ']'), ['quoted"key']);
const accumulator = createGeminiPartialArguments();
accumulator.append(first, 'signature');
accumulator.append(second);
accumulator.append(last);
const complete = accumulator.finish();
assert.deepEqual(
  complete.map((call) => call.args),
  [{ q: '中文 😀' }, { 'nested.key': [{ text: 'parallel' }] }]
);
assert.equal(complete[0].thoughtSignature, 'signature');
assert.deepEqual(accumulator.finish(), []);
const typed = createGeminiPartialArguments();
typed.append({
  name: 'lookup',
  partialArgs: [
    { jsonPath: '$.yes', boolValue: true },
    { jsonPath: '$.number', numberValue: 1.25 },
    { jsonPath: '$.empty', nullValue: 'NULL_VALUE' },
    part('$.list[1]', 'second'),
    part('$.list[0]', 'first'),
  ],
});
assert.deepEqual(typed.finish()[0].args, {
  yes: true,
  number: 1.25,
  empty: null,
  list: ['first', 'second'],
});
const lateId = createGeminiPartialArguments();
lateId.append({ name: 'lookup', partialArgs: [part('$.q', 'first', true)], willContinue: true });
lateId.append({ id: 'late', args: { q: 'first final', other: 2 }, willContinue: false });
assert.equal(lateId.finish()[0].id, 'late');
const snapshot = normalizeCompletedGeminiFunctionInput({
  name: 'lookup',
  args: {},
  partialArgs: [part('$.q', 'complete')],
});
assert.deepEqual(snapshot.args, { q: 'complete' });
const growingSnapshot = createGeminiPartialArguments();
growingSnapshot.append({ id: 's', name: 'lookup', args: { q: '中文 ' }, willContinue: true });
growingSnapshot.append({ id: 's', args: { q: '中文 😀' }, willContinue: false });
assert.deepEqual(growingSnapshot.finish()[0].args, { q: '中文 😀' });
for (const path of [
  '',
  '$',
  '$[0]',
  '$.a..b',
  '$[*]',
  '$[1:2]',
  '$["a","b"]',
  '$[?(@.a)]',
  '$.__proto__.SECRET',
  '$["\\u005f_proto__"].SECRET',
  '$.constructor.prototype.SECRET',
  '$.prototype.SECRET',
  '$.a[4096]',
  '$.a[-1]',
  '$.a[01]',
  '$.a[1e10]',
  '$.a["unterminated]',
  '$.' + 'long'.repeat(80),
  '$' + '.a'.repeat(65),
])
  assert.throws(() => parseArgumentPath(path));
const bad = [
  null,
  [],
  { name: 'lookup', partialArgs: {} },
  { name: 'lookup', id: {} },
  { name: 'lookup', willContinue: 'true' },
  { name: 1 },
  ...[
    { jsonPath: '$.q' },
    { jsonPath: '$.q', stringValue: 1 },
    { jsonPath: '$.q', stringValue: 'SECRET', numberValue: 1 },
    { jsonPath: '$.q', numberValue: Infinity },
    { jsonPath: '$.q', boolValue: 'true' },
    { jsonPath: '$.q', nullValue: null },
    { jsonPath: '$.q', numberValue: 1, willContinue: true },
    { jsonPath: '$.q', stringValue: 'SECRET', willContinue: 'true' },
  ].map((value) => ({ name: 'lookup', partialArgs: [value] })),
];
for (const call of bad)
  assert.throws(
    () => createGeminiPartialArguments().append(call),
    (error) =>
      error.code === 'upstream_stream_invalid_tool_arguments' && !error.message.includes('SECRET')
  );
for (const calls of [
  [first],
  [first, { id: 'a', willContinue: false }],
  [first, { id: 'a', name: 'other', ...last }],
  [second, second],
  [first, { id: 'a', args: { q: 'conflict' }, willContinue: false }],
  [{ name: 'lookup', partialArgs: [part('$.a', 'scalar'), part('$.a.b', 'nested')] }],
  [{ name: 'lookup', partialArgs: [part('$.a.b', 'nested'), part('$.a', 'scalar')] }],
  [{ name: 'lookup', partialArgs: [part('$.a[1]', 'sparse')] }],
  [{ name: 'lookup', args: JSON.parse('{"__proto__":{"SECRET":true}}'), willContinue: true }],
  [first, { ...first, id: 'b' }, { partialArgs: [part('$.q', 'ambiguous')] }],
]) {
  const value = createGeminiPartialArguments();
  assert.throws(() => {
    for (const call of calls) value.append(call);
    value.finish();
  });
  value.clear();
  assert.deepEqual(value.finish(), []);
}
assert.equal({}.SECRET, undefined);
const circular = {};
circular.SECRET = circular;
assert.throws(
  () => createGeminiPartialArguments().append({ name: 'lookup', args: circular }),
  (error) => !error.message.includes('SECRET')
);
const dense = createGeminiPartialArguments();
dense.append({
  name: 'lookup',
  args: {
    many: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => ['field' + index, index])),
  },
});
assert.equal(Object.keys(dense.finish()[0].args.many).length, 2000);
for (const [options, calls] of [
  [{ maxConversionToolArgumentBytes: 40 }, [first]],
  [{ maxConversionToolCalls: 1 }, [first, second]],
])
  assert.throws(() => {
    const value = createGeminiPartialArguments(options);
    for (const call of calls) value.append(call);
  });
const discard = createGeminiPartialArguments();
discard.append(first);
assert.deepEqual(discard.finish({ discard: true }), []);

const deps = {
  cleanToolArgs: (_name, input) => input,
  sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
  geminiFunctionCallArgs: (call) => call.args || {},
  geminiClaudeToolId: (call, index) => call.id || 'call_' + index,
  rememberGeminiToolCall: noop,
  geminiUsageToClaude,
  geminiInlineImageToClaudeBlock: () => null,
};
const payload = (calls = [], reason = null) => ({
  candidates: [
    {
      content: { parts: calls.map((functionCall) => ({ functionCall })) },
      ...(reason ? { finishReason: reason } : {}),
    },
  ],
});
const raw = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
function stream(values, targetKind = 'semantic', options = {}, split = false, extra = {}) {
  const h = harness(false, options);
  const config = { ...deps, protocolOptions: options, ...extra };
  const emitted = [],
    logs = [];
  let decoder;
  if (targetKind === 'semantic')
    decoder = createGeminiStreamDecoder({
      deps: config,
      target: {
        text: noop,
        reasoning: noop,
        tool: (_sink, call) => emitted.push(call),
        finish: (_sink, value) => logs.push(value),
        fail: (_sink, code) => logs.push(code),
      },
    });
  else if (targetKind === 'chat')
    decoder = createGeminiChatStream({ deps: config, chatState: h.chat });
  else if (targetKind === 'claude')
    decoder = createGeminiClaudeStream({
      deps: config,
      options: { id: 'msg', model: 'model', writeEvent: h.stream.writeClaudeSseEvent },
    });
  else
    decoder = createGeminiResponsesStream({
      deps: config,
      responseState: h.responses,
      emitter: h.protocol.createResponsesStreamEmitter(true),
    });
  for (const value of values)
    for (const chunk of split ? raw(value).split('') : [raw(value)])
      decoder.processChunk(h.sink, chunk);
  assert.equal(emitted.length, 0);
  assert.ok(!h.writes.join('').includes('"type":"tool_use"'));
  assert.ok(!h.writes.join('').includes('"type":"function_call"'));
  decoder.finish(h.sink);
  return { ...h, emitted, logs, state: decoder.state };
}
const frames = [payload([first]), payload([second]), payload([last], 'STOP')];
const rejectedTool = stream(frames, 'semantic', {}, false, {
  sanitizeGeminiToolCall: () => ({ error: 'invalid', text: 'Safe retry instruction' }),
});
assert.equal(rejectedTool.logs.at(-1).finishReason, 'stop');
assert.deepEqual(rejectedTool.emitted, []);
for (const stop of ['dispose', 'abort']) {
  const h = harness(false);
  const released = [];
  const decoder = createGeminiStreamDecoder({
    deps,
    target: {
      text: noop,
      reasoning: noop,
      tool: (_sink, value) => released.push(value),
      finish: noop,
      fail: noop,
    },
  });
  decoder.processChunk(h.sink, raw(payload([first])));
  decoder[stop](h.sink);
  decoder.processChunk(h.sink, raw(payload([last], 'STOP')));
  decoder.finish(h.sink);
  assert.deepEqual(released, []);
  assert.equal(decoder.state.buffer, '');
  assert.equal(decoder.state.pendingToolCall, null);
  assert.equal(decoder.state.done, true);
}
assert.deepEqual(
  stream(frames).emitted.map((call) => JSON.parse(call.arguments)),
  complete.map((call) => call.args)
);
assert.deepEqual(
  stream(frames).emitted.map((call) => call.id),
  ['a', 'b']
);
for (const target of ['chat', 'claude', 'responses']) {
  const normal = stream(frames, target);
  assert.ok(!normal.state.failed);
  assert.deepEqual(stream(frames, target, {}, true).writes, normal.writes);
  assert.ok(normal.writes.join('').includes('中文'));
  const incomplete = stream([payload([first], 'STOP')], target);
  assert.equal(incomplete.state.failed, true);
  const truncated = stream([payload([first], 'MAX_TOKENS')], target);
  assert.ok(!truncated.state.failed);
  assert.ok(!truncated.writes.join('').includes('"type":"tool_use"'));
  assert.ok(!truncated.writes.join('').includes('"type":"function_call"'));
}
const withRegular = stream([
  payload([first]),
  payload([{ name: 'regular', args: { n: 1 } }]),
  payload([last], 'STOP'),
]);
assert.deepEqual(
  withRegular.emitted.map((call) => call.name),
  ['lookup', 'regular']
);
const invalidWire = stream(
  [payload([{ name: 'lookup', partialArgs: [part('$.__proto__.SECRET', 'secret')] }], 'STOP')],
  'chat'
);
assert.equal(invalidWire.state.failed, true);
assert.ok(!invalidWire.writes.join('').includes('SECRET'));
for (const values of [
  [payload([first], 'STOP'), payload([last], 'STOP')],
  [payload([], 'STOP'), payload([], 'MAX_TOKENS')],
])
  for (const target of ['chat', 'claude', 'responses']) {
    const invalidTerminal = stream(values, target);
    assert.equal(invalidTerminal.state.failed, true);
    assert.ok(!invalidTerminal.writes.join('').includes('"type":"tool_use"'));
    assert.ok(!invalidTerminal.writes.join('').includes('"type":"function_call"'));
  }
const gemini = createGeminiProtocol({
  ...require('../lib/proxy/tools'),
  stableHash: () => 'fixture',
  fallbackId: (prefix) => prefix + '_fixture',
  sampleGeminiToolEvent: noop,
});
const completedJson = payload(
  [{ id: 'a', name: 'lookup', partialArgs: [part('$.q', 'complete')] }],
  'STOP'
);
const convertedJson = gemini.geminiResponseToChat(completedJson, 'model', [], {
  stableCreated: () => 1,
});
assert.equal(convertedJson.choices[0].message.tool_calls[0].function.arguments, '{"q":"complete"}');
assert.deepEqual(gemini.geminiResponseToClaude(completedJson, 'model').content[0].input, {
  q: 'complete',
});
assert.throws(() => gemini.geminiResponseToClaude(payload([first], 'STOP'), 'model'));
process.stdout.write('[gemini-partial-arguments.test] ok\n');
