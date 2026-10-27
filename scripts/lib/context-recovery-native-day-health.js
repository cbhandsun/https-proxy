'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { parseCapacityReports } = require('./context-recovery-capacity-parallel');

const fail = () => new Error('native_day_health_invalid');
const finite = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function instant(value) {
  if (typeof value !== 'string' || value.length > 48 || !/^\d{4}-\d\d-\d\dT/.test(value))
    throw fail();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw fail();
  return result;
}
function safeDate(value) {
  try {
    return new Date(instant(value)).toISOString();
  } catch {
    return null;
  }
}

// Evaluate only fixed safe receipts. No database, key, raw response or process
// operation is needed; an observation failure can never become a test restart.
function inspectNativeDayHealth(input) {
  try {
    const { pin, events, previous } = normalizeCompactionData(input, 128 * 1024);
    if (
      !pin ||
      !Array.isArray(events) ||
      events.length > 32 ||
      !Number.isSafeInteger(pin.pid) ||
      pin.pid < 1 ||
      !/^v22\.\d+\.\d+$/.test(pin.node) ||
      !/^HPM-native-day-[a-zA-Z0-9-]{1,100}$/.test(pin.taskName)
    )
      throw fail();
    for (const key of ['head', 'sourceSha256', 'nativeSha256', 'nodeSha256']) {
      if (
        typeof pin[key] !== 'string' ||
        !(key === 'head' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(pin[key])
      )
        throw fail();
    }
    const unique = (name) => {
      const found = events.filter((event) => event?.event === name);
      if (found.length > 1) throw fail();
      return found[0];
    };
    const task = unique('task_status'),
      identity = unique('identity'),
      process = unique('owned_process_status');
    const started = unique('native_day_started'),
      launch = unique('process_launched');
    const integrity = unique('progress_integrity'),
      final = unique('process_finished');
    const completed = unique('native_day_completed');
    const tick = unique('capacity_tick') ?? started;
    const identityMatches = Boolean(
      task &&
      identity &&
      process &&
      launch &&
      task.taskName === pin.taskName &&
      identity.pid === pin.pid &&
      process.pid === pin.pid &&
      launch.pid === pin.pid &&
      identity.dirty === false &&
      identity.storageResolvedToCheckout === true &&
      identity.platform === 'win32' &&
      identity.arch === 'x64' &&
      identity.node === pin.node &&
      ['head', 'sourceSha256', 'nativeSha256', 'nodeSha256'].every(
        (key) =>
          identity[key] === pin[key] && launch[key === 'head' ? 'sourceHead' : key] === pin[key]
      )
    );
    // Failed storage is already a failed acceptance, even while its outer clock
    // waits for another turn. Only independent, source-bound exit evidence may
    // stop a monitor; the failure label alone must never end observation.
    const terminalConfirmed = Boolean(
      identityMatches &&
      process.alive === false &&
      ['Ready', 'Disabled'].includes(task.state) &&
      safeDate(task.checkedAtUtc) &&
      safeDate(pin.startedAtUtc) &&
      instant(task.checkedAtUtc) >= instant(pin.startedAtUtc) &&
      final &&
      Number.isInteger(final.exitCode) &&
      final.exitCode >= -2147483648 &&
      final.exitCode <= 0xffffffff &&
      Number.isInteger(task.lastTaskResult) &&
      task.lastTaskResult === final.exitCode >>> 0 &&
      ['child_exit', 'outer_deadline', 'output_limit'].includes(final.reason)
    );
    const result = {
      taskName: pin.taskName,
      checkedAtUtc: safeDate(task?.checkedAtUtc),
      state: 'unverified',
      reason: 'incomplete_evidence',
      passed: false,
      lastScheduledMs:
        Number.isSafeInteger(tick?.scheduledMs) && tick.scheduledMs >= 0 ? tick.scheduledMs : null,
      elapsedMs: finite(tick?.elapsedMs) ? tick.elapsedMs : null,
      observedTicks:
        Number.isSafeInteger(integrity?.tickCount) &&
        integrity.tickCount >= 0 &&
        integrity.tickCount <= 288
          ? integrity.tickCount
          : 0,
      processAlive: process?.alive === true,
      terminalConfirmed,
    };
    const state = (value, reason) => ({
      ...result,
      state: value,
      reason,
      passed: value === 'passed',
    });
    if (
      events.some((event) => ['native_day_failed', 'controller_failed'].includes(event?.event)) ||
      (final && final.exitCode !== 0)
    )
      return state('failed', 'terminal_failure');
    if (events.some((event) => event?.event === 'storage_operation_failed'))
      return state('failed', 'storage_operation_failed');
    if (!task || !identity || !process || !started || !launch || !integrity) return result;
    if (!identityMatches) return state('unverified', 'identity_mismatch');
    if (
      integrity.invalidCompleteLines !== 0 ||
      integrity.timelineErrors !== 0 ||
      integrity.identityCount !== 1 ||
      integrity.startedCount !== 1 ||
      !Number.isSafeInteger(integrity.tickCount) ||
      integrity.tickCount < 1 ||
      integrity.tickCount > 288 ||
      !Number.isSafeInteger(integrity.bytes) ||
      integrity.bytes < 1 ||
      integrity.bytes > 16777216
    )
      return state('unverified', 'progress_integrity');
    if (
      !tick ||
      tick.scheduledMs !== (integrity.tickCount - 1) * 300000 ||
      !finite(tick.elapsedMs) ||
      tick.elapsedMs < tick.scheduledMs ||
      tick.realtime24hStarted !== true ||
      started.scheduledMs !== 0 ||
      started.realtime24hStarted !== true ||
      instant(started.atUtc) !== instant(pin.startedAtUtc)
    )
      return state('unverified', 'invalid_timeline');
    const now = instant(task.checkedAtUtc),
      at = instant(tick.atUtc);
    if (now < at || now < instant(started.atUtc)) return state('unverified', 'observation_clock');
    if (
      !Array.isArray(integrity.tickSamples) ||
      integrity.tickSamples.length !== integrity.tickCount
    )
      return state('unverified', 'invalid_timeline');
    let previousElapsed = -1,
      previousAt = instant(started.atUtc);
    for (let index = 0; index < integrity.tickSamples.length; index++) {
      const sample = integrity.tickSamples[index];
      if (
        sample?.scheduledMs !== index * 300000 ||
        !finite(sample.elapsedMs) ||
        sample.elapsedMs < sample.scheduledMs ||
        sample.elapsedMs < previousElapsed ||
        instant(sample.atUtc) < previousAt ||
        instant(sample.atUtc) - instant(pin.creationDate) < sample.scheduledMs ||
        instant(sample.atUtc) > now
      )
        return state('unverified', 'invalid_timeline');
      // A fresh final tick cannot erase an earlier period with no evidence of
      // continuous work (for example sleep followed by timer catch-up).
      if (
        index > 0 &&
        (sample.elapsedMs - previousElapsed > 600000 || instant(sample.atUtc) - previousAt > 600000)
      )
        return state('unverified', 'continuity_gap');
      previousElapsed = sample.elapsedMs;
      previousAt = instant(sample.atUtc);
    }
    const lastSample = integrity.tickSamples.at(-1);
    if (
      lastSample.scheduledMs !== tick.scheduledMs ||
      lastSample.elapsedMs !== tick.elapsedMs ||
      instant(lastSample.atUtc) !== at
    )
      return state('unverified', 'invalid_timeline');
    if (
      previous &&
      previous.taskName === pin.taskName &&
      (tick.scheduledMs < previous.lastScheduledMs || tick.elapsedMs < previous.elapsedMs)
    )
      return state('unverified', 'progress_rollback');
    if (completed) {
      let qualified = false;
      try {
        const report = parseCapacityReports([completed.report], [0])[0];
        qualified = report.qualified === true && report.reopenCount === 12;
      } catch {
        /* No completion credit without the original full profile. */
      }
      const expiry = unique('root_expiry_elapsed');
      if (
        !qualified ||
        completed.realtime24hPassed !== true ||
        completed.realModelRequests !== 0 ||
        completed.expiredReopens !== 2 ||
        completed.storeOpens !== 15 ||
        completed.storeCloses !== 15 ||
        !finite(completed.clock?.elapsedMs) ||
        completed.clock.elapsedMs < 86400000 ||
        completed.clock.scheduledMs !== 86400000 ||
        now - instant(started.atUtc) < 86400000 ||
        !finite(expiry?.elapsedMs) ||
        expiry.elapsedMs < 86400000 ||
        expiry.expiryWaitCompleted !== true ||
        expiry.rootsObserved !== 1 ||
        !Number.isSafeInteger(expiry.maxRootExpiresAt) ||
        expiry.minRootExpiresAt !== expiry.maxRootExpiresAt ||
        expiry.maxRootExpiresAt < instant(started.atUtc) + 86400000 ||
        now < expiry.maxRootExpiresAt ||
        integrity.tickCount !== 288 ||
        JSON.stringify(integrity.expiryAttempts) !== '[1,2]'
      )
        return state('unverified', 'incomplete_completion');
      if (!final) {
        const writtenAt = safeDate(integrity.lastWriteAtUtc);
        if (writtenAt && now - instant(writtenAt) > 600000)
          return state('stalled', 'exit_receipt_stalled');
        return state('finishing', 'awaiting_exit_receipt');
      }
      if (
        final.exitCode !== 0 ||
        final.reason !== 'child_exit' ||
        process.alive !== false ||
        task.state === 'Running' ||
        task.lastTaskResult !== 0
      )
        return state('unverified', 'exit_not_verified');
      return state('passed', 'qualified_completion');
    }
    if (final) return state('failed', 'exit_without_completion');
    if (task.state !== 'Running' || process.alive !== true)
      return state('failed', 'process_not_running');
    if (
      process.executableMatches !== true ||
      instant(process.creationDate) !== instant(pin.creationDate)
    )
      return state('unverified', 'process_identity_mismatch');
    if (now - at > 600000) return state('stalled', 'no_tick_for_ten_minutes');
    return state(
      'running',
      previous && tick.scheduledMs > previous.lastScheduledMs
        ? 'progress_advanced'
        : 'fresh_real_tick'
    );
  } catch {
    throw fail();
  }
}

module.exports = { inspectNativeDayHealth };
