'use strict';

const assert = require('assert');
const {
  compactWorkBuddyTools,
  compactWorkBuddyWbipcBody,
  isWorkBuddyWbipcPayloadTooLarge,
} = require('../lib/proxy/workbuddy-wbipc-payload');

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
assert.equal(foldedProtected.changed, true);
assert.equal(foldedProtected.fits, true);
assert.equal(foldedProtected.foldedProtectedMessages, 1);
assert.ok(
  foldedProtected.retryProtectedMessageBytes < foldedProtected.originalProtectedMessageBytes
);
assert.ok(foldedProtected.body.messages[0].content.startsWith('system-head-'));
assert.ok(foldedProtected.body.messages[0].content.endsWith('-system-tail'));
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
assert.equal(oversizedLatest.changed, true);
assert.equal(oversizedLatest.fits, true);
assert.equal(oversizedLatest.foldedMessages, 1);
assert.ok(oversizedLatest.body.messages[1].content.includes('reread smaller slices'));

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

const alreadySmall = compactWorkBuddyWbipcBody({ messages: [] }, 4096);
assert.equal(alreadySmall.changed, false);
assert.ok(alreadySmall.bodyBytes < 4096);

console.log('[workbuddy-wbipc-payload.test] ok');
