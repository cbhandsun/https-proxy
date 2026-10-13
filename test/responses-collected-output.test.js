'use strict';
const assert = require('node:assert/strict');
const { createResponsesCollector } = require('../lib/proxy/forced-stream-collector');
const { collapseForcedStreamResponse } = require('../lib/proxy/forced-stream-collector');
const { EventEmitter } = require('node:events');
const event = (payload) => Buffer.from('data: ' + JSON.stringify(payload) + '\n\n');
const message = {
  id: 'message',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: '你好' }],
};
const tool = {
  id: 'tool',
  type: 'function_call',
  call_id: 'call',
  name: 'probe',
  arguments: '{"ok":true}',
};
const opaqueCompaction = {
  id: 'cmp_opaque',
  type: 'compaction',
  encrypted_content: 'opaque-provider-bytes',
  summary: [{ type: 'summary_text', text: 'bounded summary' }],
  provider_metadata: { version: 1, checksum: 'abc123' },
};
function complete(collector, status = 'completed', output = []) {
  collector.push(
    event({
      type: 'response.' + status,
      response: {
        id: 'response',
        object: 'response',
        status,
        output,
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    })
  );
  return collector.finish();
}
for (const status of ['completed', 'incomplete', 'failed']) {
  const collector = createResponsesCollector(4096);
  collector.push(event({ type: 'response.output_item.done', output_index: 1, item: tool }));
  const bytes = event({ type: 'response.output_item.done', output_index: 0, item: message });
  for (const byte of bytes) collector.push(Buffer.from([byte]));
  collector.push(event({ type: 'response.output_item.done', output_index: 0, item: message }));
  const result = complete(collector, status);
  assert.deepEqual(
    result.output,
    status === 'completed' ? [message, tool] : status === 'incomplete' ? [message] : []
  );
  assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
}
const missing = createResponsesCollector(4096);
missing.push(event({ type: 'response.output_item.done', output_index: 0, item: tool }));
assert.throws(() => missing.finish(), /terminal response/);
const authoritative = createResponsesCollector(4096);
authoritative.push(event({ type: 'response.output_item.done', output_index: 0, item: message }));
assert.deepEqual(complete(authoritative, 'completed', [tool]).output, [tool]);
const conflicting = createResponsesCollector(4096);
conflicting.push(event({ type: 'response.output_item.done', output_index: 0, item: message }));
assert.throws(
  () => conflicting.push(event({ type: 'response.output_item.done', output_index: 0, item: tool })),
  /conflicting/
);
for (const output_index of [-1, 4096, 1.5, '0', null]) {
  const collector = createResponsesCollector(4096);
  assert.throws(
    () => collector.push(event({ type: 'response.output_item.done', output_index, item: message })),
    /invalid completed/
  );
}
for (const item of [null, [], 'sensitive']) {
  const collector = createResponsesCollector(4096);
  assert.throws(
    () => collector.push(event({ type: 'response.output_item.done', output_index: 0, item })),
    /invalid completed/
  );
}
const invalidOutput = createResponsesCollector(4096);
assert.throws(() => complete(invalidOutput, 'completed', 'sensitive'), /invalid terminal/);
const bounded = createResponsesCollector(100);
assert.throws(
  () => bounded.push(event({ type: 'response.output_item.done', output_index: 0, item: message })),
  /limit/
);
assert.deepEqual(complete(createResponsesCollector(4096)).output, []);
{
  const collector = createResponsesCollector(4096);
  collector.push(
    event({ type: 'response.output_item.done', output_index: 0, item: opaqueCompaction })
  );
  const result = complete(collector, 'completed');
  assert.deepEqual(result.output, [opaqueCompaction]);
  assert.equal(JSON.stringify(result.output), JSON.stringify([opaqueCompaction]));
}
const late = createResponsesCollector(4096);
late.push(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
assert.throws(
  () => late.push(event({ type: 'response.output_item.done', output_index: 0, item: tool })),
  /after its terminal/
);
const discarded = createResponsesCollector(4096);
discarded.push(event({ type: 'response.output_item.done', output_index: 0, item: tool }));
discarded.discard();
assert.deepEqual(complete(discarded).output, []);
const upstream = new EventEmitter();
let captured;
collapseForcedStreamResponse({
  clientRes: {},
  proxyRes: upstream,
  kind: 'responses',
  maxBytes: 4096,
  statusCode: 200,
  sendJsonError: (_res, status, payload) => {
    captured = { status, payload };
  },
});
upstream.emit('error', new Error('sensitive token cookie user content'));
assert.equal(captured.status, 502);
assert.equal(captured.payload.error.message, 'Upstream stream response could not be collected');
assert.ok(!JSON.stringify(captured).includes('sensitive'));
for (const status of ['in_progress', 'failed', undefined]) {
  const collector = createResponsesCollector(4096);
  assert.throws(
    () => collector.push(event({ type: 'response.completed', response: { status, output: [] } })),
    /conflicting terminal/
  );
}
