'use strict';
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { snapshotOwnData } = require('../shared/boundary');
const { isN09NativePromise, discardN09PromiseRejection } = require('../n09-ack/contract');
const { recoveryHealthCounters, RECOVERY_FAILURE_COUNTERS } = require('./recovery-health-counters');
const fail = () => new Error('n09_recovery_cancellation_unavailable');

// Only the deliberately cancelled, isolated HTTP request may produce this
// outcome. A failure stage alone precedes durable cleanup and cannot qualify it.
function recoveryCancellationSnapshot(input, pid) {
  try {
    const counters = recoveryHealthCounters(input, pid);
    if (
      RECOVERY_FAILURE_COUNTERS.some(
        (name) => !['failed', 'httpSendingFailed'].includes(name) && counters[name] !== 0
      ) ||
      counters.failed > 1 ||
      counters.httpSendingFailed > 1
    )
      throw fail();
    return Object.freeze({
      bound: counters.bound,
      completed: counters.completed,
      failed: counters.failed,
      httpSendingFailed: counters.httpSendingFailed,
    });
  } catch {
    throw fail();
  }
}
async function waitForRecoveryCancellation(read, input, pid, deadline, dependencies = {}) {
  try {
    const baseline = snapshotOwnData(input);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      Object.keys(baseline).sort().join(',') !== 'bound,completed' ||
      Object.values(baseline).some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1
      )
    )
      throw fail();
    dependencies = snapshotOwnData(dependencies);
    if (Object.keys(dependencies).some((key) => !['now', 'sleep'].includes(key))) throw fail();
    const now = dependencies.now ?? Date.now,
      sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if ([read, now, sleep].some((fn) => typeof fn !== 'function' || types.isProxy(fn)))
      throw fail();
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
    if (!Number.isFinite(deadline)) throw fail();
    const initial = clock();
    if (deadline > initial + 15000) throw fail();
    const hardDeadline = performance.now() + deadline - initial;
    function remaining() {
      const value = Math.min(deadline - clock(), hardDeadline - performance.now());
      if (value <= 0) throw fail();
      return value;
    }
    async function waitNative(value) {
      if (!isN09NativePromise(value)) {
        discardN09PromiseRejection(value);
        throw fail();
      }
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(fail()), remaining());
          Reflect.apply(Promise.prototype.then, value, [
            (data) => resolve(Object.freeze(Object.assign(Object.create(null), { value: data }))),
            () => reject(fail()),
          ]);
        });
      } finally {
        clearTimeout(timer);
      }
    }
    let last = { bound: 0, failed: 0, httpSendingFailed: 0 };
    for (let polls = 0; polls < 300; polls++) {
      remaining();
      const raw = Reflect.apply(read, undefined, []);
      const current = recoveryCancellationSnapshot(
        types.isPromise(raw) ? (await waitNative(raw)).value : raw,
        pid
      );
      remaining();
      const change = {
        bound: current.bound - baseline.bound,
        failed: current.failed,
        httpSendingFailed: current.httpSendingFailed,
      };
      if (
        current.completed !== baseline.completed ||
        Object.values(change).some((value) => value !== 0 && value !== 1) ||
        change.failed > change.httpSendingFailed ||
        change.httpSendingFailed > change.bound ||
        Object.keys(last).some((key) => change[key] < last[key])
      )
        throw fail();
      last = change;
      if (change.bound === 1 && change.failed === 1 && change.httpSendingFailed === 1)
        return Object.freeze({ cancelled: true, cleanupFinished: true, hostDurableAck: false });
      const pending = Reflect.apply(sleep, undefined, [Math.min(50, remaining())]);
      if (!isN09NativePromise(pending)) {
        discardN09PromiseRejection(pending);
        throw fail();
      }
      if ((await waitNative(pending)).value !== undefined) throw fail();
    }
    throw fail();
  } catch {
    throw fail();
  }
}
module.exports = { recoveryCancellationSnapshot, waitForRecoveryCancellation };
