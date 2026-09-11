'use strict';

const STARTUP_PHASE_PATTERN = /^[a-z][a-z0-9_]*$/;

function createStartupTiming({ now = () => process.hrtime.bigint() } = {}) {
  if (typeof now !== 'function')
    throw new TypeError('createStartupTiming requires a clock function');
  const startedAt = now();
  if (typeof startedAt !== 'bigint') {
    throw new TypeError('startup timing clock must return bigint nanoseconds');
  }
  const phases = new Map();

  function mark(phase) {
    if (typeof phase !== 'string' || !STARTUP_PHASE_PATTERN.test(phase)) {
      throw new TypeError('Invalid startup phase: ' + phase);
    }
    if (phases.has(phase)) return phases.get(phase);
    const current = now();
    if (typeof current !== 'bigint') {
      throw new TypeError('startup timing clock must return bigint nanoseconds');
    }
    const seconds = Math.max(0, Number(current - startedAt) / 1e9);
    phases.set(phase, seconds);
    return seconds;
  }

  function snapshot() {
    return Object.fromEntries(phases);
  }

  function observe(gauge) {
    if (!gauge || typeof gauge.set !== 'function') {
      throw new TypeError('startup timing observe requires a gauge');
    }
    for (const [phase, seconds] of phases) {
      gauge.set(seconds, { phase });
    }
  }

  return { mark, observe, snapshot };
}

module.exports = { createStartupTiming };
