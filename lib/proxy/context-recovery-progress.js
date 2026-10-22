'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { validateRecoveryUsageAttribution } = require('./context-recovery-usage-attribution');

function validateRecoveryUsageServiceTier(value) {
  if (![null, 'standard', 'priority', 'batch'].includes(value))
    throw new TypeError('Invalid recovery usage');
  return value;
}

function safeRecoveryUsage(input) {
  const value = normalizeCompactionData(input, 16384);
  function numbers(item, depth) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || depth > 3)
      throw new TypeError('Invalid recovery usage');
    const result = Object.create(null);
    for (const [key, amount] of Object.entries(item)) {
      if (depth === 0 && key === 'service_tier') {
        validateRecoveryUsageServiceTier(amount);
        continue;
      }
      if (depth === 0 && key === 'attribution') {
        validateRecoveryUsageAttribution(amount);
        continue;
      }
      if (!/^[a-z_]{1,64}$/.test(key)) throw new TypeError('Invalid recovery usage');
      if (amount === null || (Number.isSafeInteger(amount) && amount >= 0)) result[key] = amount;
      else if (amount && typeof amount === 'object') result[key] = numbers(amount, depth + 1);
      else throw new TypeError('Invalid recovery usage');
    }
    return result;
  }
  return numbers(value, 0);
}

function parseRecoveryProgress(input) {
  const value = normalizeCompactionData(input, 128 * 1024);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'calls,rounds,usage' ||
    !Number.isSafeInteger(value.rounds) ||
    value.rounds < 0 ||
    value.rounds > 8 ||
    !Number.isSafeInteger(value.calls) ||
    value.calls < 0 ||
    value.calls > 64 ||
    !Array.isArray(value.usage) ||
    value.usage.length > value.rounds
  )
    throw new TypeError('Invalid recovery progress');
  return { rounds: value.rounds, calls: value.calls, usage: value.usage.map(safeRecoveryUsage) };
}

module.exports = { safeRecoveryUsage, parseRecoveryProgress, validateRecoveryUsageServiceTier };
