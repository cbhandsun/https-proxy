'use strict';
const { snapshotOwnData } = require('../shared/boundary');
const fail = () => new Error('n09_recovery_health_unavailable');
const RECOVERY_FAILURE_COUNTERS = Object.freeze([
  'failed',
  'reportingFailed',
  'publicationCleanupFailed',
  'httpPreparationFailed',
  'httpRunFailed',
  'httpEncodingFailed',
  'httpPrepareFailed',
  'httpSendingFailed',
  'httpPublishingFailed',
  'httpFinishFailed',
  'bindingUnavailable',
]);

function recoveryHealthCounters(input, pid) {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) throw fail();
    const reply = snapshotOwnData(input);
    const body = snapshotOwnData(reply.body);
    const recovery = snapshotOwnData(body.contextRecovery);
    const counters = snapshotOwnData(snapshotOwnData(recovery.counters).responses);
    if (
      reply.status !== 200 ||
      body.pid !== pid ||
      body.ok !== true ||
      body.appId !== 'https-proxy-manager' ||
      body.status !== 'running' ||
      recovery.appliedEnabled !== true ||
      recovery.storage !== 'persistent' ||
      recovery.counterWindow !== 'process_lifetime'
    )
      throw fail();
    for (const name of ['bound', 'completed', ...RECOVERY_FAILURE_COUNTERS]) {
      if (
        !Number.isSafeInteger(counters[name]) ||
        counters[name] < 0 ||
        counters[name] === Number.MAX_SAFE_INTEGER
      )
        throw fail();
    }
    return Object.freeze(
      Object.fromEntries(
        ['bound', 'completed', ...RECOVERY_FAILURE_COUNTERS].map((name) => [name, counters[name]])
      )
    );
  } catch {
    throw fail();
  }
}
module.exports = { recoveryHealthCounters, RECOVERY_FAILURE_COUNTERS };
