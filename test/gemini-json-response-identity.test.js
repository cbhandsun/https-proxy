'use strict';
const assert = require('node:assert/strict');

const ids = require('../lib/proxy/ids');
const crypto = require('node:crypto');
for (const prefix of ['resp', 'chatcmpl', 'msg_gemini']) {
  const seen = new Set();
  for (let index = 0; index < 1000; index++)
    seen.add(ids.fallbackId(prefix, { input: 'same synthetic input' }));
  assert.equal(seen.size, 1000, 'Locally generated response IDs must identify separate requests');
  const seed = {};
  seed.self = seed;
  assert.ok(ids.fallbackId(prefix, seed).startsWith(prefix + '_'));
  const hostile = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      throw new Error('SECRET');
    },
  });
  assert.match(ids.fallbackId(prefix, hostile), new RegExp('^' + prefix + '_[0-9a-f-]{36}$'));
  assert.notEqual(
    ids.fallbackId(prefix, null, { stableToolUseIds: true }),
    ids.fallbackId(prefix, null, { stableToolUseIds: true })
  );
}
const toolSeed = { name: 'synthetic', args: { ok: true } };
assert.equal(ids.fallbackId('call', toolSeed), ids.fallbackId('call', toolSeed));
assert.equal(ids.fallbackId('toolu', toolSeed), ids.fallbackId('toolu', toolSeed));
const originalUuid = crypto.randomUUID;
try {
  crypto.randomUUID = () => {
    throw new Error('UUID unavailable');
  };
  assert.throws(() => ids.fallbackId('resp', {}), /UUID unavailable/);
} finally {
  crypto.randomUUID = originalUuid;
}
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const deps = { ...ids, ...require('../lib/proxy/tools') };
const g = createGeminiProtocol(deps);
const ai = createOpenAIProtocol({ ...deps, ...g });
assert.equal(
  ai.openAIChatToResponses({ id: 'chatcmpl_provider', choices: [] }, 'synthetic').id,
  'resp_provider'
);
assert.notEqual(
  ai.openAIChatToResponses({ choices: [] }, 'synthetic').id,
  ai.openAIChatToResponses({ choices: [] }, 'synthetic').id
);
const errors = [];
const state = createResponsesState({
  ...ids,
  log: { info() {}, warn() {} },
  sendJsonError: (_res, status) => errors.push(status),
  openAIResponsesToChat: () => ({ messages: [] }),
});
const payload = {
  candidates: [{ content: { parts: [{ text: 'synthetic' }] }, finishReason: 'STOP' }],
};
const options = { buildResponse: ai.buildResponsesResponse };
const first = g.geminiResponseToResponses(payload, 'synthetic', [], options);
const second = g.geminiResponseToResponses(payload, 'synthetic', [], options);
const bridge = (response) => ({
  responseState: { id: response.id, completedOutputItems: response.output },
});
state.rememberResponsesFromBridge(
  bridge(first),
  applyResponsesHistoryPolicy(
    { messages: [{ role: 'user', content: 'synthetic stored' }] },
    { store: true }
  )
);
state.rememberResponsesFromBridge(
  bridge(second),
  applyResponsesHistoryPolicy(
    { messages: [{ role: 'user', content: 'synthetic unstored' }] },
    { store: false }
  )
);
assert.notEqual(first.id, second.id);
assert.equal(
  state.responsesToChatWithHistory({}, { input: [], previous_response_id: second.id }, 'synthetic'),
  null
);
assert.ok(errors.includes(400));
assert.ok(
  state.responsesToChatWithHistory({}, { input: [], previous_response_id: first.id }, 'synthetic')
);
assert.deepEqual(first.output, second.output);
