'use strict';
const assert = require('node:assert/strict');
const { stableCreated, fallbackId } = require('../lib/proxy/ids');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');

const originalNow = Date.now;
try {
  Date.now = () => 1791350400123;
  for (const seed of [undefined, null, '', {}, [], 'SECRET', Number.MAX_VALUE]) {
    assert.equal(stableCreated(seed), 1791350400, 'Fallback creation time must be UNIX seconds');
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(stableCreated(cyclic), 1791350400);
  const hostile = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      throw new Error('SECRET');
    },
  });
  assert.equal(stableCreated(hostile), 1791350400, 'Time generation must not inspect content');
  const state = createResponsesState({
    fallbackId,
    stableCreated,
    log: { info() {}, warn() {} },
    sendJsonError() {},
    openAIResponsesToChat: () => ({ messages: [] }),
  });
  const first = state.createResponsesStreamState({ input: [], model: 'synthetic' }, 'Gemini');
  assert.equal(first.created_at, 1791350400);
  Date.now = () => 1791350402999;
  assert.equal(first.created_at, 1791350400, 'A stream retains its initial creation time');
  const second = state.createResponsesStreamState({ input: [], model: 'synthetic' }, 'Gemini');
  assert.equal(second.created_at, 1791350402);
  assert.notEqual(first.id, second.id);
} finally {
  Date.now = originalNow;
}
const {
  createResponsesResponseConverter,
} = require('../lib/proxy/protocol-openai-responses-response');
const { createResponsesStreamDecoder } = require('../lib/proxy/responses-stream-decoder');
const { createConversionStreamBudget } = require('../lib/proxy/conversion-stream-budget');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createSseEventParser } = require('../lib/proxy/sse-buffer');
const { resolveCreatedTimestamp } = require('../lib/proxy/ids');
const chat = createOpenAIProtocol({ fallbackId, stableCreated: () => 1791350400 });
const convert = createResponsesResponseConverter({
  fallbackId: () => 'synthetic',
  stableCreated: () => 1791350400,
});
for (const value of [0, 123, Number.MAX_SAFE_INTEGER]) {
  assert.equal(
    chat.openAIChatToResponses({ created: value, choices: [] }, 'synthetic').created_at,
    value
  );
  assert.equal(
    convert.openAIResponsesToChatResponse(
      { id: 'resp_synthetic', created_at: value, output: [] },
      'synthetic'
    ).created,
    value
  );
}
for (const value of [
  -1,
  1.25,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  '123',
  {},
  [],
  true,
  null,
  undefined,
]) {
  assert.equal(
    chat.openAIChatToResponses({ created: value, choices: [] }, 'synthetic').created_at,
    1791350400
  );
  assert.equal(
    convert.openAIResponsesToChatResponse(
      { id: 'resp_synthetic', created_at: value, output: [] },
      'synthetic'
    ).created,
    1791350400
  );
}
const observed = [];
const decoder = createResponsesStreamDecoder({
  streamBudget: createConversionStreamBudget(),
  parseSseEvents: createSseEventParser(1024),
  target: {
    start(_res, state) {
      observed.push(state.created);
    },
  },
  terminal: { handleTerminalEvent() {} },
});
const state = { created: 1791350400, buffer: '' };
decoder.processChunk(
  {},
  'data: ' + JSON.stringify({ type: 'response.created', response: { created_at: 123 } }) + '\n\n',
  state
);
assert.equal(state.created, 123);
decoder.processChunk(
  {},
  'data: ' +
    JSON.stringify({ type: 'response.in_progress', response: { created_at: 456 } }) +
    '\n\n',
  state
);
assert.equal(state.created, 123, 'Timestamp stays fixed once output starts');
assert.deepEqual(observed, [123]);

for (const type of ['response.completed', 'response.incomplete', 'response.failed']) {
  const compact = { created: 1791350400, buffer: '' };
  decoder.processChunk(
    {},
    'data: ' + JSON.stringify({ type, response: { created_at: 0, output: [] } }) + '\n\n',
    compact
  );
  assert.equal(compact.created, 0, 'Compact terminal-only streams preserve a valid timestamp');
}

for (const value of [0, 123, -1, '123', {}, [], true, null, undefined]) {
  const stream = { created: 1791350400, buffer: '' };
  const wire =
    'data: ' +
    JSON.stringify({ type: 'response.created', response: { created_at: value } }) +
    '\n\n';
  decoder.processChunk({}, wire.slice(0, 9), stream);
  decoder.processChunk({}, wire.slice(9), stream);
  assert.equal(stream.created, typeof value === 'number' && value >= 0 ? value : 1791350400);
  decoder.processChunk(
    {},
    'data: ' +
      JSON.stringify({
        type: 'response.in_progress',
        response: { created_at: { secret: 'SECRET' } },
      }) +
      '\n\n',
    stream
  );
  assert.equal(stream.created, typeof value === 'number' && value >= 0 ? value : 1791350400);
}
assert.equal(
  resolveCreatedTimestamp(0, () => {
    throw new Error('Fallback must be lazy');
  }),
  0
);
assert.throws(
  () =>
    resolveCreatedTimestamp('invalid', () => {
      throw new Error('Clock unavailable');
    }),
  /Clock unavailable/
);
