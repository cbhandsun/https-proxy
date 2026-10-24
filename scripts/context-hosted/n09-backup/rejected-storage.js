'use strict';

const { types } = require('node:util');
const { snapshotOwnData } = require('../shared/boundary');
const fail = () => new Error('n09_restored_storage_not_rejected');

// A timeout, dead daemon, disabled setting, missing health response or ordinary
// startup error is not proof of rollback rejection. Require the live owned
// daemon's explicit persistent-storage unavailable state with admission closed.
async function waitForRejectedStorage(read, isAlive, pid, deadline, dependencies = {}) {
  try {
    const options = snapshotOwnData(dependencies);
    if (Object.keys(options).some((name) => !['now', 'sleep'].includes(name))) throw fail();
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (
      [read, isAlive, now, sleep].some((fn) => typeof fn !== 'function' || types.isProxy(fn)) ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      !Number.isFinite(deadline)
    )
      throw fail();
    let previous;
    const clock = () => {
      const value = now();
      if (
        !Number.isFinite(value) ||
        value >= deadline ||
        (previous !== undefined && value < previous)
      )
        throw fail();
      previous = value;
      return value;
    };
    if (deadline > clock() + 15000) throw fail();
    for (let poll = 0; poll < 150; poll++) {
      clock();
      const reply = snapshotOwnData(await read());
      clock();
      const body = snapshotOwnData(reply.body);
      const recovery = snapshotOwnData(body.contextRecovery);
      if (
        reply.status !== 200 ||
        body.pid !== pid ||
        recovery.configValid !== true ||
        recovery.requestedEnabled !== true
      )
        throw fail();
      if (
        recovery.state === 'unavailable' &&
        recovery.storage === 'persistent' &&
        recovery.appliedEnabled === false
      ) {
        if ((await isAlive()) !== true) throw fail();
        clock();
        return true;
      }
      if (
        recovery.state !== 'pending_application' ||
        ![false, null].includes(recovery.appliedEnabled) ||
        !['memory', 'persistent'].includes(recovery.storage)
      )
        throw fail();
      if ((await isAlive()) !== true) throw fail();
      clock();
      await sleep(Math.min(100, deadline - previous));
    }
    throw fail();
  } catch {
    throw fail();
  }
}

module.exports = { waitForRejectedStorage };
