'use strict';
const { types } = require('node:util');
const { snapshot } = require('../n09-ipc/lifecycle-channel.js');
const fail = () => new Error('n09_management_status_not_ready');

// A lifecycle identity precedes preload completion and management token files.
// Poll metadata only; no management request is allowed before all three guards.
async function waitForPrivatePreload(readStatus, deadline, dependencies = {}) {
  try {
    dependencies = snapshot(dependencies);
    if (Object.keys(dependencies).some((key) => !['now', 'sleep'].includes(key))) throw fail();
    if (Object.values(dependencies).some((fn) => typeof fn !== 'function' || types.isProxy(fn)))
      throw fail();
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const fn of [readStatus, now, sleep])
      if (typeof fn !== 'function' || types.isProxy(fn)) throw fail();
    let previous = now();
    if (!Number.isFinite(previous) || !Number.isFinite(deadline) || deadline > previous + 15000)
      throw fail();
    const checkClock = () => {
      const current = now();
      if (!Number.isFinite(current) || current < previous || current >= deadline) throw fail();
      previous = current;
    };
    for (let polls = 0; polls < 300; polls++) {
      checkClock();
      const status = snapshot(await readStatus());
      checkClock();
      if (
        Object.keys(status).sort().join(',') !== 'alive,credentialsPrivate,preloadPhase' ||
        typeof status.alive !== 'boolean' ||
        typeof status.credentialsPrivate !== 'boolean' ||
        !['unobserved', 'entered', 'passed', 'failed'].includes(status.preloadPhase) ||
        !status.alive ||
        status.preloadPhase === 'failed'
      )
        throw fail();
      if (status.preloadPhase === 'passed' && status.credentialsPrivate) return;
      await sleep(Math.min(50, deadline - previous));
    }
    throw fail();
  } catch {
    throw fail();
  }
}
module.exports = { waitForPrivatePreload };
