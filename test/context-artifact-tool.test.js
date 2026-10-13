'use strict';

const assert = require('assert');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  CONTEXT_ARTIFACT_TOOL_NAME,
  appendContextArtifactTool,
  contextArtifactContinuation,
  contextArtifactToolDefinition,
  createContextArtifactContinuationRequest,
  parseArguments,
} = require('../lib/proxy/context-artifact-tool');

const definition = contextArtifactToolDefinition();
assert.equal(definition.function.name, CONTEXT_ARTIFACT_TOOL_NAME);
assert.equal(definition.function.parameters.additionalProperties, false);
assert.deepStrictEqual(definition.function.parameters.required, ['locator', 'scope', 'digest']);

const originalTools = [{ type: 'function', function: { name: 'read', parameters: {} } }];
const appended = appendContextArtifactTool(originalTools);
assert.equal(originalTools.length, 1);
assert.equal(appended.length, 2);
assert.strictEqual(appendContextArtifactTool(appended), appended);
assert.equal(appendContextArtifactTool(null).length, 1);

const store = createContextArtifactStore();
const scope = 'hcs_' + '1'.repeat(32);
const stored = store.put('owner', scope, { safe: 'artifact text' });
const completion = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: CONTEXT_ARTIFACT_TOOL_NAME,
              arguments: JSON.stringify({
                locator: stored.locator,
                scope,
                digest: stored.digest,
              }),
            },
          },
        ],
      },
    },
  ],
};
const cloneCompletion = () => JSON.parse(JSON.stringify(completion));
const continuation = contextArtifactContinuation(completion, store, 'owner');
assert.equal(continuation.ok, true);
assert.equal(continuation.resolvedCount, 1);
assert.equal(continuation.messages[0].role, 'assistant');
assert.equal(continuation.messages[1].role, 'tool');
const firstPage = JSON.parse(continuation.messages[1].content);
assert.equal(firstPage.ok, true);
assert.equal(firstPage.page.encoding, 'json');
assert.equal(firstPage.page.nextOffsetBytes, null);
assert.deepStrictEqual(JSON.parse(firstPage.page.text), { safe: 'artifact text' });

const unavailable = cloneCompletion();
unavailable.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({
  locator: 'hca_' + '0'.repeat(32),
  scope,
  digest: '0'.repeat(64),
});
assert.deepStrictEqual(
  JSON.parse(contextArtifactContinuation(unavailable, store, 'owner').messages[1].content),
  { ok: false, error: 'context_artifact_unavailable' }
);
const unavailableContinuation = contextArtifactContinuation(unavailable, store, 'owner');
assert.equal(unavailableContinuation.attemptedCount, 1);
assert.equal(unavailableContinuation.resolvedCount, 0);
assert.equal(unavailableContinuation.unavailableCount, 1);

const mixed = cloneCompletion();
mixed.choices[0].message.tool_calls.push({
  id: 'call_2',
  type: 'function',
  function: { name: 'external_tool', arguments: '{}' },
});
assert.equal(contextArtifactContinuation(mixed, store, 'owner').ok, false);

const malformed = cloneCompletion();
malformed.choices[0].message.tool_calls[0].function.arguments =
  '{"locator":"bad","scope":"bad","digest":"bad","__proto__":{}}';
const malformedResult = contextArtifactContinuation(malformed, store, 'owner');
assert.deepStrictEqual(JSON.parse(malformedResult.messages[1].content), {
  ok: false,
  error: 'context_artifact_unavailable',
});
assert.equal({}.polluted, undefined);
for (const value of [null, '', '[]', 'null', '{}', '{"locator":{}}', 'x'.repeat(1025), '{bad'])
  assert.equal(parseArguments(value), null);
for (const range of [
  { offsetBytes: -1 },
  { offsetBytes: '0' },
  { limitBytes: 0 },
  { limitBytes: Infinity },
  { limitBytes: 65537 },
  { unexpected: true },
]) {
  assert.equal(
    parseArguments(
      JSON.stringify({ locator: stored.locator, scope, digest: stored.digest, ...range })
    ),
    null
  );
}
const partial = contextArtifactContinuation(completion, store, 'owner', { maxResultBytes: 0 });
assert.equal(partial.resolvedCount, 0);
assert.equal(partial.attemptedCount, 0);
assert.equal(partial.budgetExceededCount, 1);
const paired = cloneCompletion();
paired.choices[0].message.tool_calls.push({
  ...unavailable.choices[0].message.tool_calls[0],
  id: 'second',
});
const pairedResult = contextArtifactContinuation(paired, store, 'owner');
assert.equal(pairedResult.attemptedCount, 2);
assert.equal(pairedResult.resolvedCount, 1);
assert.equal(pairedResult.unavailableCount, 1);
assert.equal(contextArtifactContinuation({ choices: [] }, store, 'owner'), null);

const request = createContextArtifactContinuationRequest({
  responseBody: JSON.stringify(completion),
  chatBody: { messages: [{ role: 'user', content: 'continue' }], stream: false },
  store,
  owner: 'owner',
});
assert.equal(request.matched, true);
assert.equal(request.ok, true);
assert.equal(request.body.messages.length, 3);

const streamBody = [
  `data: ${JSON.stringify({
    id: 'chat_1',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_stream',
              type: 'function',
              function: {
                name: CONTEXT_ARTIFACT_TOOL_NAME,
                arguments: JSON.stringify({
                  locator: stored.locator,
                  scope,
                  digest: stored.digest,
                }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  })}`,
  'data: [DONE]',
  '',
].join('\n\n');
const streamRequest = createContextArtifactContinuationRequest({
  responseBody: streamBody,
  chatBody: { messages: [], stream: true },
  store,
  owner: 'owner',
});
assert.equal(streamRequest.ok, true);
assert.equal(streamRequest.body.messages[0].tool_calls[0].id, 'call_stream');

assert.deepStrictEqual(
  createContextArtifactContinuationRequest({
    responseBody: 'not-json',
    chatBody: { messages: [] },
  }),
  { matched: false }
);

console.log('[context-artifact-tool.test] ok');
