const assert = require('assert');
const { EventEmitter } = require('events');

const {
  decodeBodyBuffer,
  estimateTokens,
  collectLimitedRequestBody,
} = require('../lib/proxy/request-utils');

function createReq() {
  return new EventEmitter();
}

function testDecodeBodyBufferFallsBackOnBadCompressedBody() {
  const body = Buffer.from('plain');
  assert.strictEqual(decodeBodyBuffer(body, 'gzip'), 'plain');
}

function testEstimateTokensHandlesNestedValues() {
  assert.strictEqual(
    estimateTokens({
      text: '12345678',
      arr: ['1234', null],
      flag: true,
    }),
    4
  );
}

function testCollectLimitedRequestBodyCombinesChunks() {
  const req = createReq();
  let result = null;

  collectLimitedRequestBody(req, {
    limit: 16,
    onComplete(nextResult) {
      result = nextResult;
    },
  });

  req.emit('data', Buffer.from('hello '));
  req.emit('data', 'world');
  req.emit('end');

  assert.strictEqual(result.tooLarge, false);
  assert.strictEqual(result.bytes, 11);
  assert.strictEqual(result.limit, 16);
  assert.strictEqual(result.buffer.toString('utf8'), 'hello world');
}

function testCollectLimitedRequestBodyReportsTooLargeOnce() {
  const req = createReq();
  const tooLargeEvents = [];
  let result = null;

  collectLimitedRequestBody(req, {
    limit: 5,
    onTooLarge(event) {
      tooLargeEvents.push(event);
    },
    onComplete(nextResult) {
      result = nextResult;
    },
  });

  req.emit('data', Buffer.from('1234'));
  req.emit('data', Buffer.from('56'));
  req.emit('data', Buffer.from('ignored'));
  req.emit('end');

  assert.strictEqual(tooLargeEvents.length, 1);
  assert.deepStrictEqual(tooLargeEvents[0], { bytes: 6, limit: 5 });
  assert.strictEqual(result.tooLarge, true);
  assert.strictEqual(result.bytes, 6);
  assert.strictEqual(result.buffer.length, 0);
}

function testCollectLimitedRequestBodyAllowsExactLimit() {
  const req = createReq();
  let result = null;

  collectLimitedRequestBody(req, {
    limit: 5,
    onComplete(nextResult) {
      result = nextResult;
    },
  });

  req.emit('data', Buffer.from('12345'));
  req.emit('end');

  assert.strictEqual(result.tooLarge, false);
  assert.strictEqual(result.bytes, 5);
  assert.strictEqual(result.buffer.toString('utf8'), '12345');
}

function testCollectLimitedRequestBodyAbortedCallback() {
  const req = createReq();
  let aborted = 0;

  collectLimitedRequestBody(req, {
    limit: 5,
    onComplete() {},
    onAborted() {
      aborted += 1;
    },
  });

  req.emit('aborted');

  assert.strictEqual(aborted, 1);
}

testDecodeBodyBufferFallsBackOnBadCompressedBody();
testEstimateTokensHandlesNestedValues();
testCollectLimitedRequestBodyCombinesChunks();
testCollectLimitedRequestBodyReportsTooLargeOnce();
testCollectLimitedRequestBodyAllowsExactLimit();
testCollectLimitedRequestBodyAbortedCallback();

console.log('[request-utils.test] ok');
