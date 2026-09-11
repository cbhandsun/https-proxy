const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createRequestTiming,
  installClientResponseTiming,
  markRequestTiming,
  observeUpstreamResponse,
  snapshotRequestTiming,
  withUpstreamTiming,
} = require('../lib/proxy/request-timing');
const { hasVisibleTextSsePayload } = require('../lib/proxy/conversation-audit-utils');

const timing = createRequestTiming(100);
const rejectedTiming = createRequestTiming(100);
assert.strictEqual(markRequestTiming(rejectedTiming, 'upstreamHeaders', 99), false);
assert.strictEqual(markRequestTiming(timing, 'upstreamHeaders', 140), true);
assert.strictEqual(markRequestTiming(timing, 'upstreamHeaders', 150), false);
assert.strictEqual(markRequestTiming(timing, 'firstUpstreamChunk', 160), true);
assert.strictEqual(markRequestTiming(timing, 'firstClientByte', 170), true);
assert.strictEqual(markRequestTiming(timing, 'firstVisibleText', 180), true);
assert.strictEqual(markRequestTiming(timing, 'unknown', 190), false);
assert.deepStrictEqual(snapshotRequestTiming(timing), {
  upstreamHeadersMs: 40,
  firstUpstreamChunkMs: 60,
  firstClientByteMs: 70,
  firstVisibleTextMs: 80,
});

const responseWrites = [];
const response = {
  write(chunk) {
    responseWrites.push(['write', chunk]);
    return true;
  },
  end(chunk) {
    responseWrites.push(['end', chunk]);
  },
};
const responseTiming = createRequestTiming(200);
let now = 210;
installClientResponseTiming(response, responseTiming, () => now);
response.write('');
now = 215;
response.end(Buffer.from('x'));
assert.strictEqual(responseTiming.firstClientByteAt, 215);
assert.deepStrictEqual(responseWrites, [
  ['write', ''],
  ['end', Buffer.from('x')],
]);

const upstream = new EventEmitter();
const observedResponse = { __requestTiming: createRequestTiming(300) };
now = 325;
observeUpstreamResponse(observedResponse, upstream, () => now);
now = 340;
upstream.emit('data', Buffer.from('first'));
assert.deepStrictEqual(snapshotRequestTiming(observedResponse.__requestTiming), {
  upstreamHeadersMs: 25,
  firstUpstreamChunkMs: 40,
  firstClientByteMs: null,
  firstVisibleTextMs: null,
});

const wrappedResponse = { __requestTiming: createRequestTiming(400) };
const wrapped = withUpstreamTiming(
  wrappedResponse,
  (proxyRes) => proxyRes.statusCode,
  () => 425
);
assert.strictEqual(wrapped({ statusCode: 201 }), 201);
assert.strictEqual(wrappedResponse.__requestTiming.upstreamHeadersAt, 425);
assert.throws(() => withUpstreamTiming({}, null), /requires a callback/);

assert.strictEqual(hasVisibleTextSsePayload(null), false);
assert.strictEqual(
  hasVisibleTextSsePayload({ type: 'response.output_text.delta', delta: '' }),
  false
);
assert.strictEqual(
  hasVisibleTextSsePayload({ type: 'content_block_delta', delta: { text: 'first token' } }),
  true
);
assert.strictEqual(
  hasVisibleTextSsePayload({ choices: [{ delta: { content: 'first token' } }] }),
  true
);

console.log('[request-timing.test] ok');
