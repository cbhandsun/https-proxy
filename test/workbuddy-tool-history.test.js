'use strict';

const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const {
  normalizeWorkBuddyToolHistory,
  workBuddyToolHistoryError,
} = require('../lib/proxy/workbuddy-tool-history');

const call = (...ids) => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => ({
    id,
    type: 'function',
    function: { name: 'exec', arguments: '{}' },
  })),
});
const result = (id, content = 'ok', extra = {}) => ({
  role: 'tool',
  tool_call_id: id,
  content,
  ...extra,
});
const normalize = normalizeWorkBuddyToolHistory;
const rejects = (messages, reason, options) =>
  assert.throws(
    () => normalize(messages, options),
    (error) => {
      assert.equal(error.code, 'invalid_workbuddy_tool_history');
      assert.equal(error.reason, reason);
      assert.ok(!JSON.stringify(workBuddyToolHistoryError(error)).includes('SECRET'));
      return true;
    }
  );

const plain = [{ role: 'user', content: 'question' }];
assert.equal(normalize(plain).messages, plain);
assert.equal(normalize(plain).changed, false);
assert.deepEqual(normalize([]).messages, []);
for (const content of ['', null, [], 'Unicode \u4e2d\u6587\ntext']) {
  const history = [call('one'), result('one', content)];
  assert.equal(normalize(history).messages, history);
}
const parallel = [call('a', 'b'), result('b'), result('a'), { role: 'user', content: 'next' }];
assert.equal(normalize(parallel).messages, parallel);

const identical = [call('one'), result('one'), result('one')];
const before = JSON.stringify(identical);
const deduplicated = normalize(identical);
assert.equal(deduplicated.messages.length, 2);
assert.equal(deduplicated.diagnostics.deduplicatedResults, 1);
assert.equal(deduplicated.diagnostics.combinedResults, 0);
assert.equal(JSON.stringify(identical), before);
rejects(identical, 'duplicate_result', { repair: false });

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } };
const multipart = [
  call('a', 'b'),
  result('a', [{ type: 'text', text: 'first' }, image]),
  result('b', 'other call'),
  result('a', 'second', { is_error: true }),
];
const multipartBefore = JSON.stringify(multipart);
const merged = normalize(multipart);
assert.equal(merged.messages.length, 3);
assert.equal(merged.messages[1].is_error, true);
assert.ok(merged.messages[1].content.includes(image), 'media stays structured');
assert.ok(merged.messages[1].content.some((part) => part.text === 'first'));
assert.ok(merged.messages[1].content.some((part) => part.text === 'second'));
assert.match(merged.messages[1].content[0].text, /may disagree/);
assert.match(merged.messages[1].content.at(-2).text, /marked as error/);
assert.equal(merged.messages[2].content, 'other call');
assert.equal(merged.diagnostics.combinedCalls, 1);
assert.equal(merged.diagnostics.combinedResults, 1);
assert.equal(JSON.stringify(multipart), multipartBefore);
assert.equal(normalize(merged.messages).changed, false, 'repair is idempotent');
assert.equal(normalize(merged.messages, { repair: false }).changed, false);

const mixedStatus = normalize([
  call('one'),
  result('one', 'ok'),
  result('one', 'ok', { status: 'error' }),
]);
assert.equal(mixedStatus.diagnostics.deduplicatedResults, 0);
assert.equal(mixedStatus.messages[1].is_error, true);
assert.equal(mixedStatus.messages[1].status, undefined);

for (const value of [null, {}, '', [null], [{ role: 'unknown' }], Array(16385).fill(plain[0])])
  rejects(value, 'invalid_shape');
for (const id of ['', ' ', '\nSECRET', 'x'.repeat(4097), null, 42]) {
  rejects([call(id), result(id)], 'invalid_id');
}
rejects([call('same', 'same'), result('same')], 'duplicate_call');
rejects([call('same'), result('same'), call('same'), result('same')], 'duplicate_call');
rejects([result('SECRET')], 'orphan_result');
rejects([call('a'), result('b')], 'orphan_result');
rejects([call('a')], 'missing_result');
rejects([call('a', 'b'), result('a')], 'missing_result');
rejects([call('a'), { role: 'user', content: 'new task' }, result('a')], 'missing_result');
rejects([call('a'), result('a'), { role: 'user', content: 'next' }, result('a')], 'orphan_result');
rejects([{ role: 'assistant', function_call: { name: 'exec', arguments: '{}' } }], 'invalid_shape');
rejects([call(...Array.from({ length: 65 }, (_, index) => String(index)))], 'invalid_shape');
rejects([call('a'), ...Array.from({ length: 65 }, () => result('a'))], 'result_limit');
assert.equal(
  normalize([call('a'), ...Array.from({ length: 64 }, () => result('a'))]).messages.length,
  2
);
for (const content of [undefined, 12, {}, new Date(), [{ text: () => 'SECRET' }]])
  rejects([call('one'), { ...result('one'), content }], 'invalid_shape');
let invoked = false;
const getter = Object.defineProperty({}, 'text', {
  get() {
    invoked = true;
    return 'SECRET';
  },
  enumerable: true,
});
rejects([call('one'), result('one', [getter])], 'invalid_shape');
assert.equal(invoked, false);
const hook = {
  toJSON() {
    invoked = true;
    return 'SECRET';
  },
};
rejects([call('one'), result('one', [hook])], 'invalid_shape');
assert.equal(invoked, false);
const callGetter = call('one');
Object.defineProperty(callGetter.tool_calls, '0', {
  get() {
    invoked = true;
    return null;
  },
});
rejects([callGetter], 'invalid_shape');
assert.equal(invoked, false);
const messageGetter = [plain[0]];
Object.defineProperty(messageGetter, '0', {
  get() {
    invoked = true;
    return null;
  },
});
rejects(messageGetter, 'invalid_shape');
assert.equal(invoked, false);
const cyclic = {};
cyclic.child = cyclic;
rejects([call('one'), result('one', [cyclic])], 'invalid_shape');
assert.equal(workBuddyToolHistoryError(new Error('SECRET')), null);
assert.equal(
  workBuddyToolHistoryError({ code: 'invalid_workbuddy_tool_history', reason: 'SECRET' }),
  null
);

// Reported failure: custom exec emitted an execution-layer error and a separate
// successful child-command result under the same call_id before compaction.
const protocol = createOpenAIProtocol({
  cleanToolArgs: (_name, args) => args,
  fallbackId: (prefix) => `${prefix}_fixture`,
  stableCreated: () => 1,
  protocolOptions: { contextWindowPolicy: 'disabled' },
});
const input = [{ role: 'user', content: 'Synthetic task' }];
for (let index = 0; index < 12; index += 1) {
  input.push(
    { type: 'custom_tool_call', call_id: `old_${index}`, name: 'exec', input: 'synthetic' },
    { type: 'custom_tool_call_output', call_id: `old_${index}`, output: 'synthetic output' }
  );
}
const executionError = "TypeError: Cannot read properties of undefined (reading 'slice')";
const executionResult = JSON.stringify({
  text: JSON.stringify({ exit_code: 0, output: 'synthetic success' }),
});
input.push(
  { type: 'custom_tool_call', call_id: 'reported', name: 'exec', input: 'synthetic' },
  {
    type: 'custom_tool_call_output',
    call_id: 'reported',
    output: [{ type: 'input_text', text: executionError }],
  },
  { type: 'custom_tool_call_output', call_id: 'reported', name: 'exec', output: executionResult }
);
const chat = protocol.openAIResponsesToChat({ model: 'deepseek-v4.1-flash', input });
chat.messages = normalize(chat.messages).messages;
const plan = planWorkBuddyWbipcRequest(chat, { force: true, targetBodyBytes: 4096 });
assert.equal(plan.fits, true);
assert.equal(plan.diagnostics.checkpointValid, true);
assert.ok(plan.diagnostics.evictedToolRounds > 0);
normalize(plan.body.messages, { repair: false });
const finalResults = plan.body.messages.filter((message) => message.tool_call_id === 'reported');
assert.equal(finalResults.length, 1);
assert.ok(JSON.stringify(finalResults[0].content).includes('reading'));
assert.ok(finalResults[0].content.some((part) => part.text === executionResult));
assert.ok(finalResults[0].content.some((part) => part.text.includes(executionError)));
process.stdout.write('workbuddy-tool-history.test.js passed\n');
