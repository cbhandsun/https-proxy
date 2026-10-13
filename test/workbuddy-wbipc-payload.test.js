'use strict';

const assert = require('assert');
const {
  compactWorkBuddyTools,
  compactWorkBuddyWbipcBody,
  isWorkBuddyWbipcPayloadTooLarge,
} = require('../lib/proxy/workbuddy-wbipc-payload');
const { validateCheckpointMessages } = require('../lib/proxy/context-checkpoint');

assert.equal(isWorkBuddyWbipcPayloadTooLarge(null), false);
assert.equal(isWorkBuddyWbipcPayloadTooLarge({ ok: false, status: 'connection_error' }), false);
assert.equal(isWorkBuddyWbipcPayloadTooLarge({ ok: false, status: 'E_PAYLOAD_TOO_LARGE' }), true);

const compactable = {
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: 'keep-system' },
    { role: 'user', content: 'old-' + 'x'.repeat(8000) },
    { role: 'assistant', content: 'old-answer-' + 'y'.repeat(8000) },
    { role: 'user', content: 'keep-latest' },
  ],
};
const compacted = compactWorkBuddyWbipcBody(compactable, 4096);
assert.equal(compacted.changed, true);
assert.equal(compacted.fits, true);
assert.ok(compacted.bodyBytes <= 4096);
assert.ok(compacted.droppedCount >= 2);
assert.equal(compacted.body.messages[0].content, 'keep-system');
assert.equal(compacted.body.messages.at(-1).content, 'keep-latest');
assert.equal(compactable.messages.length, 4, 'input body is not mutated');

const toolHeavy = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'keep-latest' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_workspace_file',
        description: 'tool-doc-'.repeat(1000),
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'parameter-doc-'.repeat(1000),
              minLength: 1,
              examples: ['safe/example.txt'],
            },
            mode: { type: 'string', enum: ['text', 'binary'] },
            examples: { type: 'string', description: 'real parameter named examples' },
          },
          required: ['path'],
          additionalProperties: false,
          $comment: 'documentation only',
        },
        externalDocs: { url: 'https://example.invalid/docs' },
      },
    },
  ],
};
const originalToolHeavy = JSON.stringify(toolHeavy);
const compactedToolHeavy = compactWorkBuddyWbipcBody(toolHeavy, 4096);
assert.equal(compactedToolHeavy.changed, true);
assert.equal(compactedToolHeavy.fits, true);
assert.ok(compactedToolHeavy.bodyBytes <= 4096);
assert.ok(compactedToolHeavy.retryToolsBytes < compactedToolHeavy.originalToolsBytes);
const compactedFunction = compactedToolHeavy.body.tools[0].function;
assert.equal(compactedFunction.name, 'read_workspace_file');
assert.equal(compactedFunction.description.length, 512);
assert.equal(compactedFunction.parameters.type, 'object');
assert.deepStrictEqual(compactedFunction.parameters.required, ['path']);
assert.equal(compactedFunction.parameters.properties.path.type, 'string');
assert.equal(compactedFunction.parameters.properties.path.description.length, 160);
assert.equal(compactedFunction.parameters.properties.path.minLength, 1);
assert.deepStrictEqual(compactedFunction.parameters.properties.mode.enum, ['text', 'binary']);
assert.equal(compactedFunction.parameters.properties.examples.type, 'string');
assert.equal(compactedFunction.parameters.properties.path.examples, undefined);
assert.equal(compactedFunction.parameters.$comment, undefined);
assert.equal(compactedFunction.externalDocs, undefined);
assert.equal(JSON.stringify(toolHeavy), originalToolHeavy, 'tool input is not mutated');

const directlyCompactedTools = compactWorkBuddyTools(toolHeavy.tools);
assert.equal(directlyCompactedTools.changed, true);
assert.ok(directlyCompactedTools.bodyBytes < directlyCompactedTools.originalBytes);

const oversizedProtected = {
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: 'system-head-' + 's'.repeat(500000) + '-system-tail' },
    { role: 'user', content: 'keep-latest' },
  ],
};
const foldedProtected = compactWorkBuddyWbipcBody(
  oversizedProtected,
  384 * 1024,
  64 * 1024,
  256 * 1024
);
assert.equal(foldedProtected.changed, false);
assert.equal(foldedProtected.fits, false);
assert.equal(foldedProtected.foldedProtectedMessages, 0);
assert.equal(
  foldedProtected.retryProtectedMessageBytes,
  foldedProtected.originalProtectedMessageBytes
);
assert.equal(foldedProtected.body.messages[0].content, oversizedProtected.messages[0].content);
assert.equal(oversizedProtected.messages[0].content.length, 500024, 'system input is not mutated');

const indivisible = {
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: 'keep-system' },
    { role: 'user', content: 'z'.repeat(8000) },
  ],
};
const retained = compactWorkBuddyWbipcBody(indivisible, 4096);
assert.equal(retained.changed, false);
assert.equal(retained.fits, false);
assert.equal(retained.body.messages.length, 2);

const oversizedLatest = compactWorkBuddyWbipcBody(indivisible, 4096, 1024);
assert.equal(oversizedLatest.changed, false);
assert.equal(oversizedLatest.fits, false);
assert.equal(oversizedLatest.foldedMessages, 0);
assert.equal(oversizedLatest.body.messages[1].content, indivisible.messages[1].content);

const multiMessageLatestToolExchange = {
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: 'fixed-policy-' + 'p'.repeat(70000) },
    { role: 'user', content: 'old turn' },
    {
      role: 'assistant',
      tool_calls: Array.from({ length: 12 }, (_value, index) => ({
        id: `call_${index}`,
        type: 'function',
        function: { name: 'read', arguments: '{}' },
      })),
    },
    ...Array.from({ length: 12 }, (_value, index) => ({
      role: 'tool',
      tool_call_id: `call_${index}`,
      content: `result-${index}-` + 'r'.repeat(30000),
    })),
  ],
};
const nonAdaptiveExchange = compactWorkBuddyWbipcBody(multiMessageLatestToolExchange, 256 * 1024);
assert.equal(nonAdaptiveExchange.fits, false);
const adaptiveExchange = compactWorkBuddyWbipcBody(
  multiMessageLatestToolExchange,
  256 * 1024,
  64 * 1024,
  256 * 1024,
  { adaptive: true }
);
assert.equal(adaptiveExchange.changed, true);
assert.equal(adaptiveExchange.fits, true);
assert.ok(adaptiveExchange.bodyBytes <= 256 * 1024);
assert.ok(adaptiveExchange.compactionPasses > 1);
assert.equal(adaptiveExchange.body.messages[0].role, 'system');
assert.equal(
  adaptiveExchange.body.messages[0].content,
  multiMessageLatestToolExchange.messages[0].content
);
assert.ok(adaptiveExchange.body.messages.some((message) => message.tool_call_id === 'call_11'));

const multipartLatest = compactWorkBuddyWbipcBody(
  {
    model: 'deepseek-v4.1-flash',
    messages: [
      {
        role: 'user',
        content: Array.from({ length: 8 }, () => ({ type: 'input_text', text: 'x'.repeat(8000) })),
      },
    ],
  },
  20 * 1024,
  16 * 1024
);
assert.equal(multipartLatest.fits, false, 'multipart user constraints are also preserved');
assert.equal(multipartLatest.body.messages[0].content[3].text, 'x'.repeat(8000));

const latestToolOutput = {
  model: 'deepseek-v4.1-flash',
  messages: [
    {
      role: 'assistant',
      tool_calls: [
        { id: 'call_large', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_large', content: 'head-' + 'q'.repeat(8000) + '-tail' },
    { role: 'user', content: 'keep-latest' },
  ],
};
const folded = compactWorkBuddyWbipcBody(latestToolOutput, 4096, 1024);
assert.equal(folded.changed, true);
assert.equal(folded.fits, true);
assert.equal(folded.foldedToolOutputs, 1);
const foldedTool = folded.body.messages.find((message) => message.role === 'tool');
assert.ok(foldedTool.content.startsWith('head-'));
assert.ok(foldedTool.content.endsWith('-tail'));
assert.ok(foldedTool.content.includes('reread smaller slices'));
assert.equal(latestToolOutput.messages[1].content.length, 8010, 'latest tool input is not mutated');

const exactBoundaryTarget = 393216;
const exactBoundaryCheckpoint = {
  role: 'assistant',
  content:
    '[HPM_CONTEXT_CHECKPOINT_V1]\n' +
    JSON.stringify({
      schema: 'hpm.context.checkpoint',
      version: 1,
      sourceRole: 'assistant',
      entries: [{ text: 'continue from retained state' }],
    }),
};
const exactBoundaryReceipt =
  '[HPM_EVIDENCE_RECEIPT_V1] ' +
  JSON.stringify({
    kind: 'historical_tool_evidence',
    locator: 'hca_' + 'a'.repeat(32),
    scope: 'hcs_' + 'b'.repeat(32),
    digest: 'c'.repeat(64),
    recovery: 'read_context_artifact',
  });
const exactBoundaryMessages = [
  { role: 'system', content: 'fixed-system-policy' },
  { role: 'developer', content: 'fixed-developer-policy' },
  { role: 'user', content: '' },
  exactBoundaryCheckpoint,
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '' },
  { role: 'tool', tool_call_id: 'historical_call', content: exactBoundaryReceipt },
];
const exactBoundaryBody = { model: 'deepseek-v4.1-flash', messages: exactBoundaryMessages };
const exactBoundaryBaseBytes = Buffer.byteLength(JSON.stringify(exactBoundaryBody));
const exactBoundaryContentIndexes = [2, 4, 5, 6, 7, 8, 9];
const exactBoundaryContentChars = exactBoundaryTarget + 10 - exactBoundaryBaseBytes;
for (const [offset, index] of exactBoundaryContentIndexes.entries()) {
  const chars =
    Math.floor(exactBoundaryContentChars / exactBoundaryContentIndexes.length) +
    (offset < exactBoundaryContentChars % exactBoundaryContentIndexes.length ? 1 : 0);
  exactBoundaryMessages[index].content = 'x'.repeat(chars);
}
const exactBoundaryOriginal = JSON.stringify(exactBoundaryBody);
assert.equal(Buffer.byteLength(exactBoundaryOriginal), exactBoundaryTarget + 10);
const exactBoundary = compactWorkBuddyWbipcBody(exactBoundaryBody, exactBoundaryTarget);
assert.equal(exactBoundary.fits, true);
assert.equal(exactBoundary.bodyBytes, exactBoundaryTarget);
assert.equal(exactBoundary.boundaryCompactionApplied, true);
assert.deepStrictEqual(exactBoundary.body.messages.slice(0, 2), exactBoundaryMessages.slice(0, 2));
assert.equal(exactBoundary.body.messages[3].content, exactBoundaryCheckpoint.content);
assert.equal(validateCheckpointMessages([exactBoundary.body.messages[3]]), true);
assert.equal(exactBoundary.body.messages[10].content, exactBoundaryReceipt);
assert.ok(exactBoundary.body.messages[10].content.includes('hca_' + 'a'.repeat(32)));
assert.equal(JSON.stringify(exactBoundaryBody), exactBoundaryOriginal, 'boundary fit is immutable');

const alreadySmall = compactWorkBuddyWbipcBody({ messages: [] }, 4096);
assert.equal(alreadySmall.changed, false);
assert.ok(alreadySmall.bodyBytes < 4096);

// A single user turn may contain many completed tool rounds. Their 1024-char
// individual floors must not cause a local 413 when the aggregate can still fit.
const longToolLoop = {
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: 'policy-' + 'p'.repeat(104000) },
    { role: 'user', content: 'continue the original task without changing its requirements' },
    exactBoundaryCheckpoint,
    ...Array.from({ length: 24 }, (_value, index) => [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: `loop_${index}`,
            type: 'function',
            function: { name: 'exec', arguments: JSON.stringify({ command: 'c'.repeat(700) }) },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: `loop_${index}`,
        content: 'head-' + 'r'.repeat(5000) + '-tail',
      },
    ]).flat(),
    { role: 'tool', tool_call_id: 'receipt', content: exactBoundaryReceipt },
  ],
};
const longToolLoopOriginal = JSON.stringify(longToolLoop);
const learnedLoopLimit = 149111;
const budgetedLoop = compactWorkBuddyWbipcBody(
  longToolLoop,
  learnedLoopLimit,
  undefined,
  undefined,
  { adaptive: true }
);
assert.equal(budgetedLoop.fits, true);
assert.equal(budgetedLoop.compactionPasses, 7);
assert.equal(budgetedLoop.byteBudgetCompactionApplied, true);
assert.ok(Buffer.byteLength(JSON.stringify(budgetedLoop.body)) <= learnedLoopLimit);
assert.equal(budgetedLoop.body.messages.length, longToolLoop.messages.length);
assert.deepStrictEqual(budgetedLoop.body.messages.slice(0, 3), longToolLoop.messages.slice(0, 3));
assert.equal(budgetedLoop.body.messages.at(-1).content, exactBoundaryReceipt);
assert.equal(
  budgetedLoop.body.messages.at(-2).content.length,
  1024,
  'newest result retains its budget'
);
for (let index = 3; index < budgetedLoop.body.messages.length - 1; index += 2) {
  assert.deepStrictEqual(budgetedLoop.body.messages[index], longToolLoop.messages[index]);
  const result = budgetedLoop.body.messages[index + 1];
  assert.equal(result.tool_call_id, longToolLoop.messages[index + 1].tool_call_id);
  assert.ok(result.content.length >= 256);
  assert.ok(result.content.startsWith('head-'));
  assert.ok(result.content.endsWith('-tail'));
  assert.ok(result.content.includes('reread smaller slices'));
}
assert.equal(JSON.stringify(longToolLoop), longToolLoopOriginal);

const unicodeLoop = {
  ...longToolLoop,
  messages: longToolLoop.messages.map((message) =>
    message.role === 'tool' && message.tool_call_id !== 'receipt'
      ? { ...message, content: [{ type: 'text', text: '汉字\\"\n'.repeat(1000) }] }
      : message
  ),
};
const unicodeBudgetedLoop = compactWorkBuddyWbipcBody(
  unicodeLoop,
  learnedLoopLimit,
  undefined,
  undefined,
  { adaptive: true }
);
assert.equal(unicodeBudgetedLoop.fits, true);
assert.equal(unicodeBudgetedLoop.byteBudgetCompactionApplied, true);
assert.ok(Buffer.byteLength(JSON.stringify(unicodeBudgetedLoop.body)) <= learnedLoopLimit);
assert.equal(unicodeBudgetedLoop.body.messages.length, unicodeLoop.messages.length);

const impossibleLoop = compactWorkBuddyWbipcBody(longToolLoop, 105000, undefined, undefined, {
  adaptive: true,
});
assert.equal(impossibleLoop.fits, false, 'fixed policy and call metadata still fail closed');
assert.equal(impossibleLoop.byteBudgetCompactionApplied, false);
assert.deepStrictEqual(impossibleLoop.body.messages.slice(0, 3), longToolLoop.messages.slice(0, 3));
assert.equal(impossibleLoop.body.messages.at(-1).content, exactBoundaryReceipt);
assert.equal(JSON.stringify(longToolLoop), longToolLoopOriginal);

const largeReceiptBody = {
  messages: [
    { role: 'user', content: 'latest' },
    {
      role: 'tool',
      tool_call_id: 'protected_receipt',
      content: exactBoundaryReceipt + 'x'.repeat(4000),
    },
  ],
};
const retainedReceipt = compactWorkBuddyWbipcBody(largeReceiptBody, 2048, undefined, undefined, {
  adaptive: true,
});
assert.equal(retainedReceipt.fits, false);
assert.equal(retainedReceipt.body.messages[1].content, largeReceiptBody.messages[1].content);

for (const optionalTools of [{}, { tools: undefined }, { tools: [] }]) {
  const user = { role: 'user', content: 'Keep this exact requirement.' };
  const source = {
    ...optionalTools,
    messages: [{ role: 'assistant', content: 'Historical narration. '.repeat(500) }, user],
  };
  const original = JSON.stringify(source);
  const result = compactWorkBuddyWbipcBody(source, 4096, undefined, undefined, {
    adaptive: true,
    preserveToolSchemas: true,
    preserveUserMessages: true,
  });
  assert.equal(result.fits, true, 'An absent catalog is valid under exact-catalog admission');
  assert.ok(result.body.messages.includes(user));
  assert.equal(result.body.tools, source.tools);
  assert.equal(result.bodyBytes, Buffer.byteLength(JSON.stringify(result.body)));
  assert.equal(JSON.stringify(source), original);
}

console.log('[workbuddy-wbipc-payload.test] ok');
