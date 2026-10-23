'use strict';
const { types } = require('node:util');
const { snapshot } = require('../n09-ipc/lifecycle-channel.js');
const { managementFailurePhase } = require('../shared/management-failure-phase.js');
const failure = (phase) => Object.assign(new Error('n09_management_http_not_ready'), { phase });

function initializationPending(response) {
  try {
    const value = snapshot(response);
    const body = snapshot(value.body);
    return (
      Object.keys(value).sort().join(',') === 'body,status' &&
      value.status === 503 &&
      Object.keys(body).join(',') === 'error' &&
      body.error === 'Management initialization unavailable'
    );
  } catch {
    return false;
  }
}

// Preload precedes listen and asynchronous credential publication. Only refused
// connections and the exact pending health reply are startup probes; no business
// call is retried. Other HTTP replies retain the caller's failure attestation.
async function waitForManagementHttp(read, deadline, dependencies = {}) {
  let now, sleep;
  try {
    dependencies = snapshot(dependencies);
    if (Object.keys(dependencies).some((key) => !['now', 'sleep'].includes(key)))
      throw failure(186);
    if (Object.values(dependencies).some((fn) => typeof fn !== 'function' || types.isProxy(fn)))
      throw failure(186);
    now = dependencies.now ?? Date.now;
    sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const fn of [read, now, sleep])
      if (typeof fn !== 'function' || types.isProxy(fn)) throw failure(186);
  } catch {
    throw failure(186);
  }
  let previous;
  const clock = () => {
    let time;
    try {
      time = now();
    } catch {
      throw failure(186);
    }
    if (!Number.isFinite(time) || (previous !== undefined && time < previous) || time >= deadline)
      throw failure(189);
    previous = time;
    return time;
  };
  if (!Number.isFinite(deadline)) throw failure(189);
  if (deadline > clock() + 15000) throw failure(189);
  for (let polls = 0; polls < 300; polls++) {
    clock();
    let response, rejectedPhase;
    try {
      response = await read();
    } catch (error) {
      rejectedPhase = managementFailurePhase(error);
    }
    clock();
    if (rejectedPhase === undefined && !initializationPending(response)) return response;
    if (rejectedPhase !== undefined && rejectedPhase !== 191) throw failure(rejectedPhase);
    try {
      await sleep(Math.min(50, deadline - previous));
    } catch {
      throw failure(186);
    }
  }
  throw failure(189);
}
module.exports = { waitForManagementHttp };
