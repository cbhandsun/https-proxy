'use strict';
const { types } = require('node:util');
const { snapshot } = require('../n09-ipc/lifecycle-channel.js');
const { managementFailurePhase } = require('../shared/management-failure-phase.js');
const { seedReplyFailurePhase } = require('../shared/seed-reply-phase.js');
const failure = (phase, detailPhase) =>
  Object.assign(new Error('n09_applied_recovery_not_ready'), {
    phase,
    ...(detailPhase === undefined ? {} : { detailPhase }),
  });

// Listening and private credential publication do not attest asynchronous store
// startup. Only the product's explicit pending_application state is a probe.
async function waitForAppliedRecovery(
  read,
  isAlive,
  pid,
  deadline,
  dependencies = {},
  expectedInput = { enabled: true, persistent: true }
) {
  let now, sleep, expected;
  try {
    expected = snapshot(expectedInput);
    if (
      Object.keys(expected).sort().join(',') !== 'enabled,persistent' ||
      typeof expected.enabled !== 'boolean' ||
      typeof expected.persistent !== 'boolean'
    )
      throw failure(188);
    dependencies = snapshot(dependencies);
    if (Object.keys(dependencies).some((key) => !['now', 'sleep'].includes(key)))
      throw failure(188);
    if (Object.values(dependencies).some((fn) => typeof fn !== 'function' || types.isProxy(fn)))
      throw failure(188);
    now = dependencies.now ?? Date.now;
    sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const fn of [read, isAlive, now, sleep])
      if (typeof fn !== 'function' || types.isProxy(fn)) throw failure(188);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(deadline)) throw failure(188);
  } catch {
    throw failure(188);
  }
  let previous;
  const clock = () => {
    let value;
    try {
      value = now();
    } catch {
      throw failure(189);
    }
    if (
      !Number.isFinite(value) ||
      (previous !== undefined && value < previous) ||
      value >= deadline
    )
      throw failure(189);
    previous = value;
    return value;
  };
  if (deadline > clock() + 15000) throw failure(189);
  for (let polls = 0; polls < 150; polls++) {
    clock();
    let response;
    try {
      response = await read();
    } catch (error) {
      throw failure(managementFailurePhase(error));
    }
    clock();
    let body, recovery;
    try {
      response = snapshot(response);
      if (response.status !== 200) throw failure(seedReplyFailurePhase(response.status));
    } catch (error) {
      const phase = Object.getOwnPropertyDescriptor(error, 'phase')?.value;
      throw failure(Number.isInteger(phase) && phase >= 162 && phase <= 173 ? phase : 188);
    }
    try {
      body = snapshot(response.body);
      recovery = snapshot(body.contextRecovery);
    } catch {
      throw failure(188);
    }
    if (body.pid !== pid) throw failure(190, 232);
    if (
      recovery.configValid === true &&
      recovery.requestedEnabled === expected.enabled &&
      recovery.appliedEnabled === expected.enabled &&
      recovery.state === (expected.enabled ? 'enabled_restricted' : 'disabled') &&
      ['memory', 'persistent'].includes(recovery.storage) &&
      (!expected.enabled || recovery.storage === (expected.persistent ? 'persistent' : 'memory'))
    )
      return true;
    if (recovery.configValid !== true) throw failure(190, 233);
    if (recovery.requestedEnabled !== expected.enabled) throw failure(190, 234);
    if (['unavailable', 'failed'].includes(recovery.state)) throw failure(190, 235);
    if (!['memory', 'persistent'].includes(recovery.storage)) throw failure(190, 237);
    if (recovery.state !== 'pending_application') {
      if (recovery.appliedEnabled !== expected.enabled) throw failure(190, 236);
      if (expected.enabled && recovery.storage !== (expected.persistent ? 'persistent' : 'memory'))
        throw failure(190, 237);
      throw failure(190, 238);
    }
    if (![false, true, null].includes(recovery.appliedEnabled)) throw failure(190, 236);
    let alive;
    try {
      alive = await isAlive();
    } catch {
      throw failure(190, 239);
    }
    clock();
    if (alive !== true) throw failure(190, 239);
    try {
      await sleep(Math.min(100, deadline - previous));
    } catch {
      throw failure(189);
    }
  }
  throw failure(189);
}
module.exports = { waitForAppliedRecovery };
