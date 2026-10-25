'use strict';
const { types } = require('node:util');
// Wait for a child lifecycle event, without a runnable polling loop. The caller
// retains its original absolute deadline and phase/exit/failure assertions.
function waitForFixtureSignal(child, remainingMs) {
  if (
    !child ||
    typeof child !== 'object' ||
    types.isProxy(child) ||
    typeof child.once !== 'function' ||
    typeof child.removeListener !== 'function' ||
    !Number.isFinite(remainingMs) ||
    remainingMs < 0 ||
    remainingMs > 5000
  )
    throw new Error('fixture_phase_wait_invalid');
  if (remainingMs === 0) return Promise.resolve('deadline');
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners = new Map();
    const timer = setTimeout(() => finish('deadline'), remainingMs);
    function cleanup() {
      clearTimeout(timer);
      for (const [name, listener] of listeners) child.removeListener(name, listener);
    }
    function finish(signal) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(signal);
    }
    try {
      for (const name of ['message', 'exit', 'error']) {
        if (settled) break;
        const listener = () => finish(name);
        listeners.set(name, listener);
        child.once(name, listener);
        if (settled) cleanup();
      }
    } catch {
      settled = true;
      cleanup();
      reject(new Error('fixture_phase_wait_failed'));
    }
  });
}
module.exports = { waitForFixtureSignal };
