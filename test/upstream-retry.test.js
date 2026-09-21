const assert = require('assert');

const {
  isRetryableStatusCode,
  shouldRetryAttempt,
  parseRetryAfterMs,
  retryDelayMs,
  shouldRetryUpstreamStatus,
  shouldFailoverOnStatus,
  shouldFailoverOnError,
  isValidIdempotencyKey,
  canReplayRequest,
  resolveUpstreamRecovery,
  isPreTransmissionFailure,
  readPreTransmissionContext,
} = require('../lib/proxy/upstream-retry');

function testRetryableStatusCodes() {
  assert.strictEqual(isRetryableStatusCode(429), true);
  assert.strictEqual(isRetryableStatusCode(500), true);
  assert.strictEqual(isRetryableStatusCode(503), true);
  assert.strictEqual(isRetryableStatusCode(499), false);
  assert.strictEqual(isRetryableStatusCode(400), false);
}

function testRetryAttemptBoundary() {
  assert.strictEqual(shouldRetryAttempt(1, 2), true);
  assert.strictEqual(shouldRetryAttempt(2, 2), true);
  assert.strictEqual(shouldRetryAttempt(3, 2), false);
  assert.strictEqual(shouldRetryAttempt('Infinity', 2), false);
  assert.strictEqual(shouldRetryAttempt(1, 'Infinity'), false);
  assert.strictEqual(shouldRetryAttempt(NaN, 2), false);
}

function testRetryDelayBoundsJitter() {
  assert.strictEqual(
    retryDelayMs(1, () => 0),
    2000
  );
  assert.strictEqual(
    retryDelayMs(1, () => 1),
    2500
  );
  assert.strictEqual(
    retryDelayMs(2, () => 0.25),
    4125
  );
  assert.strictEqual(
    retryDelayMs(1, () => -5),
    2000
  );
  assert.strictEqual(
    retryDelayMs(1, () => 99),
    2500
  );
}

function testRetryAfterParsingAndBounds() {
  assert.strictEqual(parseRetryAfterMs('2.5'), 2500);
  assert.strictEqual(parseRetryAfterMs('999999'), 120000);
  assert.strictEqual(parseRetryAfterMs('invalid'), null);
  assert.strictEqual(
    parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')),
    2000
  );
  assert.strictEqual(
    retryDelayMs(1, () => 0, '5'),
    5000
  );
  assert.strictEqual(
    retryDelayMs(Infinity, () => 0),
    1000
  );
}

function testStatusRetryCombinesCodeAndAttempt() {
  assert.strictEqual(shouldRetryUpstreamStatus(429, 1, 2), true);
  assert.strictEqual(shouldRetryUpstreamStatus(503, 2, 2), true);
  assert.strictEqual(shouldRetryUpstreamStatus(503, 3, 2), false);
  assert.strictEqual(shouldRetryUpstreamStatus(400, 1, 2), false);
}

function testStatusFailoverOnlyFirstRetryableAttempt() {
  const prepared = { profile: { backupProfileId: 'backup' } };
  const backup = { id: 'backup' };
  const profiles = [{ id: 'primary' }, backup];

  assert.strictEqual(shouldFailoverOnStatus(503, 1, prepared, profiles), backup);
  assert.strictEqual(shouldFailoverOnStatus(429, 1, prepared, profiles), backup);
  assert.strictEqual(shouldFailoverOnStatus(400, 1, prepared, profiles), null);
  assert.strictEqual(shouldFailoverOnStatus(503, 2, prepared, profiles), null);
  assert.strictEqual(shouldFailoverOnStatus(503, 1, { profile: {} }, profiles), null);
}

function testErrorFailoverOnlyFirstAttempt() {
  const prepared = { profile: { backupProfileId: 'backup' } };
  const backup = { id: 'backup' };

  assert.strictEqual(shouldFailoverOnError(1, prepared, [backup]), backup);
  assert.strictEqual(shouldFailoverOnError(2, prepared, [backup]), null);
  assert.strictEqual(shouldFailoverOnError(1, prepared, []), null);
}

function testRecoveryPrefersFailoverBeforeRetry() {
  const backup = { id: 'backup' };
  const prepared = { profile: { backupProfileId: 'backup' } };
  const profiles = [{ id: 'primary' }, backup];

  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      kind: 'status',
      statusCode: 503,
      attempt: 1,
      maxRetries: 2,
      prepared,
      profiles,
      method: 'GET',
    }),
    { type: 'failover', profile: backup }
  );
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      kind: 'error',
      attempt: 1,
      maxRetries: 2,
      prepared,
      profiles,
      method: 'HEAD',
    }),
    { type: 'failover', profile: backup }
  );
}

function testRecoveryRetriesWhenNoBackupExists() {
  const statusRecovery = resolveUpstreamRecovery({
    kind: 'status',
    statusCode: 429,
    attempt: 1,
    maxRetries: 2,
    prepared: { profile: {} },
    profiles: [],
    retryAfter: '5',
    random: () => 0,
    method: 'GET',
  });
  assert.deepStrictEqual(statusRecovery, { type: 'retry', delayMs: 5000 });

  const errorRecovery = resolveUpstreamRecovery({
    kind: 'error',
    attempt: 2,
    maxRetries: 2,
    prepared: { profile: {} },
    profiles: [],
    random: () => 0,
    method: 'OPTIONS',
  });
  assert.deepStrictEqual(errorRecovery, { type: 'retry', delayMs: 4000 });
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      kind: 'error',
      attempt: 3,
      maxRetries: 2,
      prepared: { profile: {} },
      profiles: [],
      method: 'GET',
    }),
    { type: 'none' }
  );
}

function testUnsafeRequestsRequireExplicitIdempotencyContract() {
  const backup = { id: 'backup' };
  const baseOptions = {
    kind: 'status',
    statusCode: 503,
    attempt: 1,
    maxRetries: 2,
    profiles: [backup],
    method: 'POST',
  };

  assert.strictEqual(canReplayRequest({ method: 'POST' }), false);
  assert.strictEqual(
    canReplayRequest({
      method: 'POST',
      headers: { 'idempotency-key': 'request-123' },
      prepared: { profile: {} },
    }),
    false
  );
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      ...baseOptions,
      prepared: { profile: { backupProfileId: 'backup' } },
    }),
    { type: 'none' }
  );
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      ...baseOptions,
      headers: { 'Idempotency-Key': 'request-123' },
      prepared: {
        profile: {
          backupProfileId: 'backup',
          retryUnsafeRequests: true,
        },
      },
      random: () => 0,
    }),
    { type: 'retry', delayMs: 2000 }
  );
}

/**
 * 回归：DNS 被投毒时 chatgpt.com 会连到持有别人证书的服务器，TLS 校验以
 * ERR_TLS_CERT_ALTNAME_INVALID 失败。请求体从未发出，重放没有副作用，因此不
 * 带 Idempotency-Key 的 POST 也必须能重试，否则一次投毒就会让整段对话 502。
 */
function testPreTransmissionTlsFailuresAreRetryableForUnsafeMethods() {
  assert.strictEqual(isPreTransmissionFailure('ERR_TLS_CERT_ALTNAME_INVALID'), true);
  assert.strictEqual(isPreTransmissionFailure('err_tls_cert_altname_invalid'), true);
  assert.strictEqual(isPreTransmissionFailure('  UNABLE_TO_VERIFY_LEAF_SIGNATURE '), true);
  assert.strictEqual(isPreTransmissionFailure('ERR_SSL_WRONG_VERSION_NUMBER'), true);
  assert.strictEqual(isPreTransmissionFailure('ECONNRESET'), false);
  assert.strictEqual(isPreTransmissionFailure('EPIPE'), false);
  assert.strictEqual(isPreTransmissionFailure('ETIMEDOUT'), false);
  assert.strictEqual(isPreTransmissionFailure(undefined), false);
  assert.strictEqual(isPreTransmissionFailure(null), false);

  const poisoned = {
    kind: 'error',
    attempt: 1,
    maxRetries: 2,
    prepared: { profile: {} },
    profiles: [],
    method: 'POST',
    headers: {},
    errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID',
    random: () => 0,
  };
  assert.deepStrictEqual(resolveUpstreamRecovery(poisoned), { type: 'retry', delayMs: 2000 });

  // 重试次数用尽后必须停下，不能无限重放。
  assert.deepStrictEqual(resolveUpstreamRecovery({ ...poisoned, attempt: 3 }), { type: 'none' });

  // 响应已经开始时不得重试，避免客户端收到重复内容。
  assert.deepStrictEqual(resolveUpstreamRecovery({ ...poisoned, responseStarted: true }), {
    type: 'none',
  });

  // 普通连接中断仍需依赖显式幂等契约，不能借 TLS 豁免通道。
  assert.deepStrictEqual(resolveUpstreamRecovery({ ...poisoned, errorCode: 'ECONNRESET' }), {
    type: 'none',
  });
}

/**
 * 回归：DNS 投毒除了让证书不匹配，还可能让握手阶段直接被重置，错误是
 * ECONNRESET + "disconnected before secure TLS connection was established"。
 * TLS 握手未完成时应用层字节从未送出，重放同样安全，因此不能因为错误码是
 * ECONNRESET 就整体放行——只认"握手未完成"这一结构性证据。
 */
function testHandshakePhaseResetsAreReplayableWithoutWeakeningResetsInGeneral() {
  // 握手未完成：可重放，即使是不带幂等键的 POST。
  assert.strictEqual(
    isPreTransmissionFailure('ECONNRESET', { tlsHandshakeIncomplete: true, reusedSocket: false }),
    true
  );
  // 握手已完成（或复用连接）：ECONNRESET 不享受豁免。
  assert.strictEqual(
    isPreTransmissionFailure('ECONNRESET', { tlsHandshakeIncomplete: false, reusedSocket: false }),
    false
  );
  assert.strictEqual(
    isPreTransmissionFailure('ECONNRESET', { tlsHandshakeIncomplete: true, reusedSocket: true }),
    false
  );
  // 没有上下文时保持原有保守行为。
  assert.strictEqual(isPreTransmissionFailure('ECONNRESET'), false);
  assert.strictEqual(isPreTransmissionFailure('ECONNRESET', null), false);
  assert.strictEqual(isPreTransmissionFailure('ECONNRESET', 'nope'), false);
  assert.strictEqual(isPreTransmissionFailure('EPIPE', { tlsHandshakeIncomplete: false }), false);
  // 错误码本身足够时，不需要任何上下文。
  assert.strictEqual(
    isPreTransmissionFailure('ERR_TLS_CERT_ALTNAME_INVALID', { reusedSocket: true }),
    true
  );

  const baseOptions = {
    kind: 'error',
    attempt: 1,
    maxRetries: 2,
    prepared: { profile: {} },
    profiles: [],
    method: 'POST',
    headers: {},
    errorCode: 'ECONNRESET',
    random: () => 0,
  };
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      ...baseOptions,
      preTransmissionContext: { tlsHandshakeIncomplete: true, reusedSocket: false },
    }),
    { type: 'retry', delayMs: 2000 }
  );
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      ...baseOptions,
      preTransmissionContext: { tlsHandshakeIncomplete: false, reusedSocket: false },
    }),
    { type: 'none' }
  );
  // 重试次数用尽后必须停下。
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      ...baseOptions,
      attempt: 3,
      preTransmissionContext: { tlsHandshakeIncomplete: true, reusedSocket: false },
    }),
    { type: 'none' }
  );
  // 响应已经开始时不得重放。
  assert.deepStrictEqual(
    resolveUpstreamRecovery({
      ...baseOptions,
      responseStarted: true,
      preTransmissionContext: { tlsHandshakeIncomplete: true, reusedSocket: false },
    }),
    { type: 'none' }
  );
}

/**
 * 上下文读取必须只依赖连接的真实状态，不能把普通 socket 误判成握手中的 TLS。
 */
function testPreTransmissionContextReadsSocketState() {
  assert.deepStrictEqual(readPreTransmissionContext(null), {
    tlsHandshakeIncomplete: false,
    reusedSocket: false,
  });
  assert.deepStrictEqual(readPreTransmissionContext(undefined), {
    tlsHandshakeIncomplete: false,
    reusedSocket: false,
  });
  assert.deepStrictEqual(readPreTransmissionContext({}), {
    tlsHandshakeIncomplete: false,
    reusedSocket: false,
  });
  // 普通 HTTP socket 没有 secureConnecting，必须判为握手中=false。
  assert.deepStrictEqual(readPreTransmissionContext({ socket: { encrypted: false } }), {
    tlsHandshakeIncomplete: false,
    reusedSocket: false,
  });
  assert.deepStrictEqual(
    readPreTransmissionContext({ socket: { secureConnecting: true }, reusedSocket: true }),
    { tlsHandshakeIncomplete: true, reusedSocket: true }
  );
  assert.deepStrictEqual(
    readPreTransmissionContext({ socket: { secureConnecting: false }, reusedSocket: false }),
    { tlsHandshakeIncomplete: false, reusedSocket: false }
  );
}

function testReplayValidationRejectsMalformedBoundaryValues() {
  assert.strictEqual(isValidIdempotencyKey(''), false);
  assert.strictEqual(isValidIdempotencyKey('x'.repeat(256)), true);
  assert.strictEqual(isValidIdempotencyKey('x'.repeat(257)), false);
  assert.strictEqual(isValidIdempotencyKey('unsafe\r\nheader'), false);
  assert.strictEqual(
    canReplayRequest({
      method: 'POST',
      headers: { 'idempotency-key': ['one', 'two'] },
      prepared: { profile: { retryUnsafeRequests: true } },
    }),
    false
  );
  assert.strictEqual(
    canReplayRequest({
      method: 'GET',
      responseStarted: true,
    }),
    false
  );
  assert.strictEqual(canReplayRequest({ method: 'TRACE' }), false);
}

testRetryableStatusCodes();
testRetryAttemptBoundary();
testRetryDelayBoundsJitter();
testRetryAfterParsingAndBounds();
testStatusRetryCombinesCodeAndAttempt();
testStatusFailoverOnlyFirstRetryableAttempt();
testErrorFailoverOnlyFirstAttempt();
testRecoveryPrefersFailoverBeforeRetry();
testRecoveryRetriesWhenNoBackupExists();
testUnsafeRequestsRequireExplicitIdempotencyContract();
testPreTransmissionTlsFailuresAreRetryableForUnsafeMethods();
testHandshakePhaseResetsAreReplayableWithoutWeakeningResetsInGeneral();
testPreTransmissionContextReadsSocketState();
testReplayValidationRejectsMalformedBoundaryValues();

console.log('[upstream-retry.test] ok');
