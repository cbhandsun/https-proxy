'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

// Reserve synchronously immediately before forwarding, not at HTTP headers:
// several concurrent bodies must not all consume the same final allowance.
function createNativeBenchmarkRequestBudget(input) {
  let options;
  try {
    options = normalizeCompactionData(input, 4096);
  } catch {
    throw new TypeError('Invalid native benchmark request budget');
  }
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).sort().join(',') !== 'cumulativeLimit,priorRequests' ||
    !Number.isSafeInteger(options.priorRequests) ||
    options.priorRequests < 0 ||
    !Number.isSafeInteger(options.cumulativeLimit) ||
    options.cumulativeLimit < 1 ||
    options.cumulativeLimit > 1000 ||
    options.priorRequests > options.cumulativeLimit
  )
    throw new TypeError('Invalid native benchmark request budget');
  let reserved = 0;
  const inspect = () => ({
    cumulativeLimit: options.cumulativeLimit,
    priorRequests: options.priorRequests,
    reservedRequests: reserved,
    cumulativeRequests: options.priorRequests + reserved,
    remainingRequests: options.cumulativeLimit - options.priorRequests - reserved,
  });
  return {
    inspect,
    admit() {
      if (options.priorRequests + reserved >= options.cumulativeLimit)
        return { ok: false, code: 'benchmark_request_limit' };
      reserved++;
      return { ok: true };
    },
  };
}

module.exports = { createNativeBenchmarkRequestBudget };
