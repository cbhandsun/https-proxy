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
testReplayValidationRejectsMalformedBoundaryValues();

console.log('[upstream-retry.test] ok');
