const assert = require('assert');
const {
  createLogger,
  newRequestId,
  withRequest,
  getReqId,
  setLevel,
  getLevel,
  serializeError,
  sanitizeLogText,
  sanitizeLogValue,
  normalizeRequestId,
  LEVELS,
  _als,
} = require('../lib/proxy/logger');

// 1. createLogger shape
const log = createLogger('test');
assert.strictEqual(log.module, 'test');
assert.strictEqual(typeof log.debug, 'function');
assert.strictEqual(typeof log.info, 'function');
assert.strictEqual(typeof log.warn, 'function');
assert.strictEqual(typeof log.error, 'function');
assert.strictEqual(typeof log.fatal, 'function');
assert.strictEqual(typeof log.log, 'function');
assert.strictEqual(typeof log.child, 'function');
console.log('[logger.test] createLogger shape ok');

// 2. child logger
const child = log.child({ component: 'sub' });
assert.strictEqual(typeof child.info, 'function');
assert.strictEqual(typeof child.child, 'function');
console.log('[logger.test] child logger ok');

// 3. newRequestId
const id1 = newRequestId();
const id2 = newRequestId();
assert.ok(id1 && id2);
assert.notStrictEqual(id1, id2, 'ids must be unique');
assert.strictEqual(typeof id1, 'string');
assert.ok(id1.length >= 8, 'id should be reasonably long');
console.log('[logger.test] newRequestId ok');

// 4. withRequest + getReqId
assert.strictEqual(getReqId(), undefined, 'no reqId outside withRequest');
let capturedId;
withRequest({ reqId: 'test-req-123' }, () => {
  capturedId = getReqId();
  assert.strictEqual(capturedId, 'test-req-123');
});
assert.strictEqual(getReqId(), undefined, 'no reqId after withRequest exits');
console.log('[logger.test] withRequest scoping ok');

// 5. withRequest async propagation
async function asyncCheck() {
  await new Promise((r) => setImmediate(r));
  return getReqId();
}
(async () => {
  const id = await withRequest({ reqId: 'async-456' }, asyncCheck);
  assert.strictEqual(id, 'async-456', 'reqId should propagate through async boundaries');
  console.log('[logger.test] withRequest async propagation ok');

  // 6. serializeError
  const err = new Error('boom');
  err.code = 'EBOOM';
  const ser = serializeError(err);
  assert.strictEqual(ser.message, 'boom');
  assert.strictEqual(ser.code, 'EBOOM');
  assert.ok(ser.stack);
  console.log('[logger.test] serializeError ok');

  // 7. serializeError with string
  assert.deepStrictEqual(serializeError('plain'), { message: 'plain' });
  assert.strictEqual(serializeError(null), null);
  assert.strictEqual(serializeError(undefined), null);
  console.log('[logger.test] serializeError string/null ok');

  // 8. secret redaction and request-id boundary
  assert.strictEqual(
    sanitizeLogText('Authorization: Bearer super-secret'),
    'Authorization: Bearer [redacted]'
  );
  assert.strictEqual(
    sanitizeLogText('https://user:pass@example.test/v1?apiKey=secret&safe=1'),
    'https://[redacted]@example.test/v1?apiKey=[redacted]&safe=1'
  );
  assert.deepStrictEqual(
    sanitizeLogValue({ authorization: 'Bearer secret', nested: { apiKey: 'sk-test', safe: 1 } }),
    { authorization: '[redacted]', nested: { apiKey: '[redacted]', safe: 1 } }
  );
  const serializedSecretError = serializeError(new Error('request failed: Bearer secret-token'));
  assert.ok(!serializedSecretError.message.includes('secret-token'));
  assert.strictEqual(normalizeRequestId('safe-id:123'), 'safe-id:123');
  assert.match(normalizeRequestId('bad\nrequest-id'), /^[a-f0-9]{12}$/);
  assert.match(normalizeRequestId('x'.repeat(129)), /^[a-f0-9]{12}$/);
  console.log('[logger.test] redaction/request-id boundary ok');

  // 9. setLevel / getLevel
  const before = getLevel();
  setLevel('warn');
  assert.strictEqual(getLevel(), 'warn');
  setLevel('info');
  assert.strictEqual(getLevel(), 'info');
  // restore
  setLevel(before);
  console.log('[logger.test] setLevel/getLevel ok');

  // 10. LEVELS export
  assert.ok(LEVELS.INFO < LEVELS.WARN);
  assert.ok(LEVELS.WARN < LEVELS.ERROR);
  console.log('[logger.test] LEVELS ordering ok');

  // 11. emit logs (no throw)
  log.info('hello world');
  log.info({ event: 'test' }, 'structured log');
  log.warn('warn msg', { extra: 1 });
  log.error({ err: new Error('test-err') }, 'with err');
  console.log('[logger.test] emit logs ok');

  console.log('[logger.test] ok');
})().catch((err) => {
  console.error('logger.test FAILED:', err);
  process.exit(1);
});
