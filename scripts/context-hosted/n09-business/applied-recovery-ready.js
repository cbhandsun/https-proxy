'use strict';
const { types } = require('node:util');
const { snapshot } = require('../n09-ipc/lifecycle-channel.js');
const { managementFailurePhase } = require('../shared/management-failure-phase.js');
const { seedReplyFailurePhase } = require('../shared/seed-reply-phase.js');
const failure = (phase) => Object.assign(new Error('n09_applied_recovery_not_ready'), { phase });

// Listening and private credential publication do not attest asynchronous store
// startup. Only the product's explicit pending_application state is a probe.
async function waitForAppliedRecovery(read, isAlive, pid, deadline, dependencies = {}) {
  let now, sleep;
  try {
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
    if (body.pid !== pid) throw failure(190);
    if (recovery.appliedEnabled === true && recovery.storage === 'persistent') return true;
    if (
      recovery.configValid !== true ||
      recovery.requestedEnabled !== true ||
      recovery.state !== 'pending_application' ||
      ![false, null].includes(recovery.appliedEnabled) ||
      !['memory', 'persistent'].includes(recovery.storage)
    )
      throw failure(190);
    let alive;
    try {
      alive = await isAlive();
    } catch {
      throw failure(190);
    }
    clock();
    if (alive !== true) throw failure(190);
    try {
      await sleep(Math.min(100, deadline - previous));
    } catch {
      throw failure(189);
    }
  }
  throw failure(189);
}
module.exports = { waitForAppliedRecovery };
