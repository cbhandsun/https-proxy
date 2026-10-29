'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { storageDirectory } = require('../../lib/proxy/context-recovery-storage-paths');
const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
const { CAPACITY_PROFILES } = require('./context-recovery-capacity-workload');
const { parseCapacityReports } = require('./context-recovery-capacity-parallel');
const { exercisePersistentCapacityProfile } = require('./context-recovery-capacity-persistent');
const { createCapacityRealtimeClock } = require('./context-recovery-capacity-clock');
const { createCapacityRetentionWitness } = require('./context-recovery-capacity-retention');
const { diagnosticIdentity } = require('./context-recovery-diagnostic-identity');
const { capacityFailureReceipt } = require('./context-recovery-capacity-failure');
const { createNativeDayAdvance } = require('./context-recovery-native-day-advance');

const failure = () => new Error('native_capacity_day_failed');

// Operational composition only. All public receipts contain fixed labels,
// numerical progress or the existing bounded capacity report, never stored data.
async function runNativeCapacityDay(directory, emit) {
  directory = storageDirectory(directory);
  if (process.platform !== 'win32' || typeof emit !== 'function') throw failure();
  const identity = diagnosticIdentity();
  if (!identity.nativeSha256) throw failure();
  const pin = ({ head, sourceSha256, nativeSha256, nodeSha256 }) =>
    JSON.stringify([head, sourceSha256, nativeSha256, nodeSha256]);
  let driverFailed = false;
  function verifyIdentity() {
    if (driverFailed) throw failure();
    if (pin(diagnosticIdentity()) !== pin(identity)) throw failure();
  }
  emit({ event: 'identity', ...identity });
  const profile = CAPACITY_PROFILES[0];
  assert.equal(profile.name, 'day-small');
  const clock = createCapacityRealtimeClock();
  const witness = createCapacityRetentionWitness({
    roots: profile.roots,
    now: clock.now,
    monotonic: () => performance.now(),
  });
  let storeOpens = 0;
  let storeCloses = 0;
  let stage = 'capacity';
  let driverFailure = null;
  async function open() {
    verifyIdentity();
    const attempt = ++storeOpens;
    return openContextRecoveryStorage({
      directory,
      onFailure: ({ operation, phase, cleanupFailed }) => {
        driverFailed = true;
        emit({
          event: 'storage_operation_failed',
          stage,
          attempt,
          operation,
          phase,
          cleanupFailed,
        });
      },
      onStartup: ({ phase, elapsedMs }) =>
        emit({ event: 'startup', stage, attempt, phase, elapsedMs }),
    });
  }
  try {
    const raw = await exercisePersistentCapacityProfile(
      profile,
      {
        now: witness.now,
        advance: createNativeDayAdvance({
          clock,
          verifyIdentity,
          emit,
          onFailure(advanceFailure) {
            driverFailed = true;
            emit({ event: 'native_day_failed', stage, storeOpens, storeCloses, advanceFailure });
          },
        }),
        async openStorage() {
          const storage = await open();
          return {
            // Preserve the actual function's WeakSet capability declarations.
            execute: storage.execute,
            async close() {
              try {
                witness.observeCatalog(await storage.execute({ operation: 'catalog' }));
                verifyIdentity();
              } finally {
                await storage.close();
                storeCloses++;
              }
              emit({ event: 'capacity_closed', storeOpens, storeCloses, ...witness.inspect() });
            },
          };
        },
      },
      (token) => {
        driverFailed = true;
        driverFailure = capacityFailureReceipt(token);
        emit({ event: 'native_day_failed', stage, storeOpens, storeCloses, driverFailure });
      }
    );
    driverFailure = capacityFailureReceipt(raw) ?? driverFailure;
    verifyIdentity();
    const report = parseCapacityReports([raw], [0])[0];
    emit({ event: 'capacity_profile_result', report, storeOpens, storeCloses });
    assert.equal(report.qualified, true);
    assert.equal(storeOpens, 13);
    assert.equal(storeCloses, 13);
    // day-small's final scheduled turn is only 23h55m. The final five minutes
    // and each root's actual birth-to-expiry interval must really elapse.
    stage = 'expiry_wait';
    verifyIdentity();
    await clock.advance(86400000);
    verifyIdentity();
    await witness.waitForExpiry();
    verifyIdentity();
    assert.ok(clock.inspect().elapsedMs >= 86400000);
    emit({ event: 'root_expiry_elapsed', ...clock.inspect(), ...witness.inspect() });
    stage = 'expired_reopen';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const storage = await open();
      try {
        await witness.assertExpired(storage);
      } finally {
        await storage.close();
        storeCloses++;
        verifyIdentity();
      }
      emit({ event: 'expired_reopen_passed', attempt });
    }
    verifyIdentity();
    const result = {
      event: 'native_day_completed',
      realtime24hPassed: true,
      expiredReopens: 2,
      storeOpens,
      storeCloses,
      realModelRequests: 0,
      report,
      clock: clock.inspect(),
    };
    emit(result);
    return result;
  } catch (error) {
    const diagnostic = capacityFailureReceipt(error) ?? driverFailure;
    emit({
      event: 'native_day_failed',
      stage,
      storeOpens,
      storeCloses,
      ...(diagnostic ? { driverFailure: diagnostic } : {}),
    });
    throw failure();
  }
}

module.exports = { runNativeCapacityDay };
