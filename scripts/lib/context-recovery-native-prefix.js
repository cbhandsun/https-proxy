'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { storageDirectory } = require('../../lib/proxy/context-recovery-storage-paths');
const { storageCatalog } = require('../../lib/proxy/context-recovery-storage-contract');
const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
const { CAPACITY_PROFILES } = require('./context-recovery-capacity-workload');
const { exercisePersistentCapacityProfile } = require('./context-recovery-capacity-persistent');
const { createCapacityRealtimeClock } = require('./context-recovery-capacity-clock');
const { createCapacityRetentionWitness } = require('./context-recovery-capacity-retention');
const { diagnosticIdentity } = require('./context-recovery-diagnostic-identity');
const { capacityFailureReceipt } = require('./context-recovery-capacity-failure');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');

const LAST_OFFSET = 1800000;
const NEXT_OFFSET = 2100000;
const fail = () => new Error('native_capacity_prefix_failed');

// A diagnostic of the unchanged day-small prefix, NEVER a shorter capacity or
// retention qualification. The full profile and its executor remain untouched.
async function runNativeCapacityPrefix(directory, emit) {
  directory = storageDirectory(directory);
  if (
    process.platform !== 'win32' ||
    typeof emit !== 'function' ||
    types.isProxy(emit) ||
    types.isAsyncFunction(emit) ||
    types.isGeneratorFunction(emit)
  )
    throw fail();
  const identity = diagnosticIdentity();
  if (
    !identity.nativeSha256 ||
    identity.storageResolvedToCheckout !== true ||
    JSON.stringify(identity.storageExports) !==
      JSON.stringify(['openContextRecoveryStorage', 'validateStorageResult'])
  )
    throw fail();
  const pin = ({ head, sourceSha256, nativeSha256, nodeSha256 }) =>
    JSON.stringify([head, sourceSha256, nativeSha256, nodeSha256]);
  function verifyIdentity() {
    if (pin(diagnosticIdentity()) !== pin(identity)) throw fail();
  }
  const profile = CAPACITY_PROFILES[0];
  for (const [name, value] of Object.entries({
    name: 'day-small',
    roots: 1,
    turns: 288,
    intervalMs: 300000,
    outputBytes: 1024,
    reopenEvery: 24,
    recoveries: 24,
  }))
    assert.equal(profile[name], value);
  const clock = createCapacityRealtimeClock();
  const witness = createCapacityRetentionWitness({
    roots: 1,
    now: clock.now,
    monotonic: () => performance.now(),
  });
  let stage = 'capacity',
    storeOpens = 0,
    storeCloses = 0,
    ticks = 0,
    boundaryRequested = false;
  let firstCatalog;
  let driverFailure = null;
  const boundary = {
    realtime24hStarted: false,
    realtime24hPassed: false,
    fullCapacityQualified: false,
    realModelRequests: 0,
  };
  const report = (value) => {
    let reply;
    try {
      reply = emit(Object.freeze(value));
    } catch {
      throw fail();
    }
    if (reply !== undefined) {
      if (nativeReaderPromise(reply))
        Promise.prototype.then.call(
          reply,
          () => {},
          () => {}
        );
      throw fail();
    }
  };
  async function open() {
    verifyIdentity();
    const attempt = ++storeOpens;
    return openContextRecoveryStorage({
      directory,
      onFailure: ({ operation, phase, cleanupFailed }) =>
        report({
          event: 'prefix_storage_operation_failed',
          stage,
          attempt,
          operation,
          phase,
          cleanupFailed,
          ...boundary,
        }),
      onStartup: ({ phase, elapsedMs }) =>
        report({ event: 'prefix_startup', stage, attempt, phase, elapsedMs }),
    });
  }
  try {
    report({ event: 'identity', ...identity, ...boundary });
    let rejected;
    try {
      await exercisePersistentCapacityProfile(profile, {
        now: witness.now,
        async advance(offsetMs) {
          if (offsetMs === NEXT_OFFSET) {
            assert.equal(ticks, 7);
            assert.equal(clock.inspect().scheduledMs, LAST_OFFSET);
            boundaryRequested = true;
            throw fail();
          }
          assert.equal(offsetMs, ticks * profile.intervalMs);
          assert.ok(offsetMs <= LAST_OFFSET);
          await clock.advance(offsetMs);
          ticks++;
          report({
            event: offsetMs === 0 ? 'native_prefix_started' : 'native_prefix_tick',
            atUtc: new Date(clock.now()).toISOString(),
            ...boundary,
            ...clock.inspect(),
          });
        },
        async openStorage() {
          const storage = await open();
          return {
            execute: storage.execute,
            async close() {
              try {
                const current = storageCatalog(await storage.execute({ operation: 'catalog' }));
                witness.observeCatalog(current);
                firstCatalog = current;
                verifyIdentity();
              } finally {
                await storage.close();
                storeCloses++;
              }
            },
          };
        },
      });
    } catch (error) {
      rejected = error;
    }
    const diagnostic = capacityFailureReceipt(rejected);
    driverFailure = diagnostic;
    const elapsed = clock.inspect();
    if (
      !boundaryRequested ||
      !diagnostic ||
      diagnostic.cleanup ||
      diagnostic.primary.operation !== 'advance' ||
      diagnostic.primary.stage !== 'advance' ||
      diagnostic.primary.commandIndex !== 23 ||
      diagnostic.primary.scheduledMs !== NEXT_OFFSET ||
      storeOpens !== 1 ||
      storeCloses !== 1 ||
      ticks !== 7 ||
      elapsed.started !== true ||
      elapsed.scheduledMs !== LAST_OFFSET ||
      !Number.isFinite(elapsed.elapsedMs) ||
      elapsed.elapsedMs < LAST_OFFSET
    )
      throw rejected ?? fail();
    driverFailure = null;
    verifyIdentity();
    report({
      event: 'native_prefix_boundary',
      completedOffsetMs: LAST_OFFSET,
      ...boundary,
      ...clock.inspect(),
    });
    stage = 'reopen';
    const storage = await open();
    try {
      const current = storageCatalog(await storage.execute({ operation: 'catalog' }));
      witness.observeCatalog(current);
      assert.equal(JSON.stringify(current), JSON.stringify(firstCatalog));
      verifyIdentity();
    } finally {
      await storage.close();
      storeCloses++;
    }
    verifyIdentity();
    assert.equal(storeOpens, 2);
    assert.equal(storeCloses, 2);
    const result = {
      event: 'native_prefix_completed',
      scope: 'native_day_prefix_diagnostic',
      prefixCompleted: true,
      ...boundary,
      storeOpens,
      storeCloses,
      ticks,
      clock: clock.inspect(),
      retention: witness.inspect(),
    };
    report(result);
    return result;
  } catch (error) {
    const diagnostic = capacityFailureReceipt(error) ?? driverFailure;
    report({
      event: 'native_prefix_failed',
      stage,
      storeOpens,
      storeCloses,
      ticks,
      ...boundary,
      ...(diagnostic ? { driverFailure: diagnostic } : {}),
    });
    throw fail();
  }
}
module.exports = { runNativeCapacityPrefix };
