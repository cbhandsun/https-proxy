const assert = require('assert');
const { EventEmitter } = require('events');

const {
  decodeBodyBuffer,
  estimateTokens,
  collectLimitedRequestBody,
  inspectContentLength,
  normalizeByteLimit,
  pathForLogging,
} = require('../lib/proxy/request-utils');

function createReq() {
  return new EventEmitter();
}

function testDecodeBodyBufferFallsBackOnBadCompressedBody() {
  const body = Buffer.from('plain');
  assert.strictEqual(decodeBodyBuffer(body, 'gzip'), 'plain');
}

function testDecodeBodyBufferLimitsDecompressedOutput() {
  const zlib = require('zlib');
  const compressed = zlib.gzipSync(Buffer.alloc(4096, 'a'));
  const decoded = decodeBodyBuffer(compressed, 'gzip', { maxOutputLength: 128 });
  assert.strictEqual(decoded, compressed.toString('utf8'));
}

function testNormalizeByteLimitRejectsNonFiniteValues() {
  assert.strictEqual(normalizeByteLimit(NaN, 10, 1, 100), 10);
  assert.strictEqual(normalizeByteLimit(Infinity, 10, 1, 100), 10);
  assert.strictEqual(normalizeByteLimit(-5, 10, 1, 100), 1);
  assert.strictEqual(normalizeByteLimit(500, 10, 1, 100), 100);
}

function testPathForLoggingDropsUserControlledQueryData() {
  assert.strictEqual(pathForLogging('/v1/messages?prompt=secret&token=value'), '/v1/messages');
  assert.strictEqual(pathForLogging('/v1/models#private'), '/v1/models');
  assert.strictEqual(pathForLogging(''), '/');
  assert.strictEqual(pathForLogging(null), '/');
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

function testInspectContentLengthValidatesAndBoundsInput() {
  assert.deepStrictEqual(inspectContentLength({}, 5), {
    present: false,
    valid: true,
    exceeds: false,
    value: 0,
    limit: 5,
  });
  assert.strictEqual(inspectContentLength({ 'content-length': '5' }, 5).exceeds, false);
  assert.strictEqual(inspectContentLength({ 'Content-Length': '6' }, 5).exceeds, true);
  assert.strictEqual(inspectContentLength({ 'content-length': '0' }, 5).valid, true);
  assert.strictEqual(inspectContentLength({ 'content-length': '-1' }, 5).valid, false);
  assert.strictEqual(inspectContentLength({ 'content-length': '1e3' }, 5).valid, false);
  assert.strictEqual(inspectContentLength({ 'content-length': ['1', '2'] }, 5).valid, false);
  const extreme = inspectContentLength(
    { 'content-length': '999999999999999999999999999999999' },
    5
  );
  assert.strictEqual(extreme.valid, true);
  assert.strictEqual(extreme.exceeds, true);
  assert.strictEqual(extreme.value, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(inspectContentLength({ 'content-length': '5\r\nx: y' }, 5).valid, false);
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

function testCollectLimitedRequestBodyFailsClosedForInvalidLimit() {
  for (const limit of [NaN, Infinity, 'invalid']) {
    const req = createReq();
    let result = null;
    collectLimitedRequestBody(req, {
      limit,
      onComplete(nextResult) {
        result = nextResult;
      },
    });
    req.emit('data', Buffer.from('x'));
    req.emit('end');
    assert.strictEqual(result.tooLarge, true);
    assert.strictEqual(result.limit, 0);
  }
}

testDecodeBodyBufferFallsBackOnBadCompressedBody();
testDecodeBodyBufferLimitsDecompressedOutput();
testNormalizeByteLimitRejectsNonFiniteValues();
testPathForLoggingDropsUserControlledQueryData();
testEstimateTokensHandlesNestedValues();
testInspectContentLengthValidatesAndBoundsInput();
testCollectLimitedRequestBodyCombinesChunks();
testCollectLimitedRequestBodyReportsTooLargeOnce();
testCollectLimitedRequestBodyAllowsExactLimit();
testCollectLimitedRequestBodyAbortedCallback();
testCollectLimitedRequestBodyFailsClosedForInvalidLimit();

console.log('[request-utils.test] ok');
