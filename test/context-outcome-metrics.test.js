'use strict';

const assert = require('node:assert/strict');
const {
  buildWorkBuddyContextOutcome,
  createWorkBuddyContextOutcomeRecorder,
} = require('../lib/proxy/context-outcome-metrics');

const outcome = buildWorkBuddyContextOutcome({
  preflightPlan: {
    changed: true,
    diagnostics: {
      preflightApplied: true,
      cleanupSavedBytes: 9000,
      minimumCleanupSatisfied: true,
      checkpointStatus: 'validated',
      checkpointValid: true,
      stablePrefixPreserved: true,
    },
  },
  retryPlan: {
    changed: true,
    diagnostics: {
      cleanupSavedBytes: 12000,
      minimumCleanupSatisfied: true,
      checkpointStatus: 'validated',
      checkpointValid: true,
      stablePrefixPreserved: true,
    },
  },
  retryAttempted: true,
  artifactReadRounds: 1,
  artifactsResolved: 2,
  artifactsAttempted: 2,
  artifactsDelivered: 2,
  terminalCode: 'completed',
  finalResponse: { ok: true, status: 200, body: 'private response body' },
});

assert.deepEqual(outcome, {
  provider: 'workbuddy',
  preflightApplied: true,
  compactionApplied: true,
  cleanupSavedBytes: 12000,
  minimumCleanupSatisfied: true,
  checkpointStatus: 'validated',
  checkpointValid: true,
  stablePrefixPreserved: true,
  retryAttempted: true,
  retrySucceeded: true,
  artifactReadRounds: 1,
  artifactsResolved: 2,
  artifactsAttempted: 2,
  artifactsUnavailable: 0,
  artifactsBudgetExceeded: 0,
  artifactsDelivered: 2,
  artifactReadSucceeded: true,
  artifactDeliverySucceeded: true,
  finalOk: true,
  finalStatus: 200,
  terminalCode: 'completed',
});
assert.equal(JSON.stringify(outcome).includes('private response body'), false);

const hostile = buildWorkBuddyContextOutcome({
  preflightPlan: {
    diagnostics: {
      cleanupSavedBytes: Infinity,
      checkpointStatus: '<script>',
      stablePrefixPreserved: false,
    },
  },
  retryAttempted: true,
  artifactReadRounds: -1,
  artifactsResolved: Number.MAX_SAFE_INTEGER,
  finalResponse: { ok: false, status: 999, body: 'secret' },
});
assert.equal(hostile.cleanupSavedBytes, 0);
assert.equal(hostile.checkpointStatus, 'invalid');
assert.equal(hostile.artifactReadRounds, 0);
assert.equal(hostile.artifactsResolved, 1024 * 1024 * 1024);
assert.equal(hostile.retrySucceeded, false);
assert.equal(JSON.stringify(hostile).includes('secret'), false);

const events = [];
const recorder = createWorkBuddyContextOutcomeRecorder(
  (kind, value) => events.push({ kind, value }),
  { diagnostics: {} }
);
recorder.update({
  finalResponse: { ok: true, status: 200, body: 'PRIVATE_BODY' },
  artifactReadRounds: 1,
  artifactsAttempted: 2,
  artifactsResolved: 1,
  artifactsUnavailable: 1,
  artifactsDelivered: 0,
});
recorder.finish(413, 'PRIVATE_TOKEN');
recorder.update({ artifactsDelivered: 1 });
recorder.finish(200, 'completed');
assert.equal(events.length, 1);
assert.equal(events[0].value.finalStatus, 413);
assert.equal(events[0].value.finalOk, false);
assert.equal(events[0].value.artifactReadSucceeded, true);
assert.equal(events[0].value.artifactDeliverySucceeded, false);
assert.equal(events[0].value.terminalCode, 'context_too_large');
assert.ok(!JSON.stringify(events).includes('PRIVATE'));
const expired = buildWorkBuddyContextOutcome({
  artifactReadRounds: 1,
  artifactsAttempted: 1,
  artifactsResolved: 0,
  artifactsUnavailable: 1,
});
assert.equal(expired.artifactReadSucceeded, false);
assert.equal(expired.artifactDeliverySucceeded, false);
assert.doesNotThrow(() => createWorkBuddyContextOutcomeRecorder(null).finish(499));
console.log('[context-outcome-metrics.test] ok');
