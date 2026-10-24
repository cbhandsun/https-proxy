'use strict';

const { types } = require('node:util');
const { snapshotOwnData } = require('../shared/boundary');
const fail = () => new Error('n09_recovery_completion_unavailable');
const failures = Object.freeze([
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

function recoveryCompletionSnapshot(input, pid) {
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
    for (const name of ['bound', 'completed', ...failures]) {
      if (
        !Number.isSafeInteger(counters[name]) ||
        counters[name] < 0 ||
        counters[name] === Number.MAX_SAFE_INTEGER
      )
        throw fail();
    }
    if (failures.some((name) => counters[name] !== 0)) throw fail();
    return Object.freeze({ bound: counters.bound, completed: counters.completed });
  } catch {
    throw fail();
  }
}

// Only for this isolated, serial synthetic scenario. The existing core outcome
// counter advances AFTER finishPublicationAsync and its original storage ACK.
// This is a readiness prerequisite, never a durable-save/revoke receipt. Every
// real command still requires exact snapshot/producer revision equality.
async function waitForRecoveryCompletion(read, input, pid, deadline, dependencies = {}) {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) throw fail();
    const baseline = snapshotOwnData(input);
    if (
      Object.keys(baseline).sort().join(',') !== 'bound,completed' ||
      Object.values(baseline).some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1
      )
    )
      throw fail();
    dependencies = snapshotOwnData(dependencies);
    if (Object.keys(dependencies).some((name) => !['now', 'sleep'].includes(name))) throw fail();
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const fn of [read, now, sleep])
      if (typeof fn !== 'function' || types.isProxy(fn)) throw fail();
    let previous;
    function clock() {
      const current = now();
      if (
        !Number.isFinite(current) ||
        (previous !== undefined && current < previous) ||
        current >= deadline
      )
        throw fail();
      previous = current;
      return current;
    }
    if (!Number.isFinite(deadline) || deadline > clock() + 15000) throw fail();
    let lastBound = baseline.bound;
    for (let polls = 0; polls < 300; polls++) {
      clock();
      const current = recoveryCompletionSnapshot(await read(), pid);
      clock();
      const bound = current.bound - baseline.bound;
      const completed = current.completed - baseline.completed;
      if (
        ![0, 1].includes(bound) ||
        ![0, 1].includes(completed) ||
        completed > bound ||
        current.bound < lastBound
      )
        throw fail();
      lastBound = current.bound;
      if (completed === 1) return Object.freeze({ completed: true, hostDurableAck: false });
      await sleep(Math.min(50, deadline - previous));
    }
    throw fail();
  } catch {
    throw fail();
  }
}

module.exports = { recoveryCompletionSnapshot, waitForRecoveryCompletion };
