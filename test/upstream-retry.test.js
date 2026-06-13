const assert = require('assert');

const {
  isRetryableStatusCode,
  shouldRetryAttempt,
  retryDelayMs,
  shouldRetryUpstreamStatus,
  shouldFailoverOnStatus,
  shouldFailoverOnError,
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

testRetryableStatusCodes();
testRetryAttemptBoundary();
testRetryDelayBoundsJitter();
testStatusRetryCombinesCodeAndAttempt();
testStatusFailoverOnlyFirstRetryableAttempt();
testErrorFailoverOnlyFirstAttempt();

console.log('[upstream-retry.test] ok');
