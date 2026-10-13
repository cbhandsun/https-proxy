'use strict';

const assert = require('node:assert/strict');
const { geminiToolId } = require('../lib/proxy/gemini-tool-id');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const deps = {
  ...require('../lib/proxy/tools'),
  ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
  stableHash: () => 'stable',
  fallbackId: () => 'fallback',
  sampleGeminiToolEvent: () => {},
};
const protocol = createGeminiProtocol(deps);
const ids = [
  'a-b',
  'a_b',
  'a/b',
  'a.b',
  'a:b',
  'a b',
  'a\nb',
  'a😀b',
  '',
  'x'.repeat(4096),
  'x'.repeat(4095) + 'y',
];
const mapped = ids.map(geminiToolId);
assert.equal(new Set(mapped).size, ids.length);
assert.equal(geminiToolId('a_b'), 'toolu_a_b');
for (let i = 0; i < ids.length; i++) {
  assert.equal(geminiToolId(ids[i]), mapped[i]);
  assert.match(mapped[i], /^toolu_[A-Za-z0-9_]+$/);
  assert.ok(mapped[i].length <= 134);
}
assert.equal(protocol.geminiClaudeToolId({}, 1), 'toolu_stable');
const payload = {
  candidates: [
    {
      finishReason: 'STOP',
      content: {
        parts: ['a-b', 'a_b'].map((id) => ({
          functionCall: { id, name: 'lookup', args: { q: id } },
        })),
      },
    },
  ],
};
const output = protocol.geminiResponseToClaude(payload, 'model');
const calls = output.content.filter((part) => part.type === 'tool_use');
assert.equal(calls.length, 2);
assert.notEqual(calls[0].id, calls[1].id);
for (let i = 0; i < calls.length; i++) {
  const id = payload.candidates[0].content.parts[i].functionCall.id;
  assert.equal(calls[i].id, geminiToolId(id));
  const replay = protocol.tryOpenAIChatToGemini(
    {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: calls[i].id,
              type: 'function',
              function: { name: 'lookup', arguments: JSON.stringify(calls[i].input) },
            },
          ],
        },
        { role: 'tool', tool_call_id: calls[i].id, content: 'result' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    },
    'gemini-2.5-pro'
  ).request;
  assert.equal(replay.contents[0].parts[0].functionCall.id, id);
  assert.equal(replay.contents[1].parts[0].functionResponse.id, id);
}
