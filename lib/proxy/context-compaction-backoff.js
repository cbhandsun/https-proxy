'use strict';

const { createHash } = require('node:crypto');
const { validateLocalCompactionBinding } = require('./context-compaction-envelope');
const { safeCompactionFailureReason } = require('./context-compaction-failure');

const DIGEST = /^[a-f0-9]{64}$/;
function digest(value) {
  return typeof value === 'string' && DIGEST.test(value);
}
function fields(value, allowed) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(
      (key) =>
        allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
    )
  );
}

function compactionBackoffKey(binding, messageDigest, controlDigest, planDigest) {
  if (![messageDigest, controlDigest, planDigest].every(digest))
    throw new TypeError('Invalid compaction retry fingerprint');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'hpm.compaction.failure.v1',
        validateLocalCompactionBinding(binding),
        messageDigest,
        controlDigest,
        planDigest,
      ])
    )
    .digest('hex');
}

// Failure-only, exact-input cooldown. No summaries, receipts, content or
// execution capabilities cross request scopes. This is not a route circuit breaker.
function createContextCompactionBackoff(options = {}) {
  if (!fields(options, ['now', 'cooldownMs', 'maxEntries']))
    throw new TypeError('Invalid compaction backoff options');
  const { now = Date.now, cooldownMs = 15000, maxEntries = 128 } = options;
  if (
    typeof now !== 'function' ||
    !Number.isSafeInteger(cooldownMs) ||
    cooldownMs < 1 ||
    cooldownMs > 30000 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 256
  )
    throw new TypeError('Invalid compaction backoff limits');
  const failures = new Map();
  let lastTime = 0;
  function prune() {
    const time = now();
    if (
      !Number.isSafeInteger(time) ||
      time < lastTime ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - cooldownMs
    ) {
      failures.clear();
      return null;
    }
    lastTime = time;
    for (const [key, entry] of failures) if (time >= entry.expiresAt) failures.delete(key);
    return time;
  }
  return Object.freeze({
    async run(input) {
      if (
        !fields(input, ['key', 'signal', 'produce']) ||
        !digest(input.key) ||
        typeof input.produce !== 'function' ||
        (input.signal != null && !(input.signal instanceof globalThis.AbortSignal))
      )
        throw new TypeError('Invalid compaction backoff request');
      if (input.signal?.aborted) return { ok: false, reason: 'compaction_cancelled' };
      const time = prune();
      const previous = time === null ? null : failures.get(input.key);
      if (previous)
        return {
          ok: false,
          reason: previous.reason,
          ...(previous.failureReason ? { failureReason: previous.failureReason } : {}),
          backoffApplied: true,
          retryAfterMs: previous.expiresAt - time,
        };
      const result = await input.produce();
      const completedAt = prune();
      if (input.signal?.aborted || time === null || completedAt === null) return result;
      if (
        fields(result, ['ok', 'reason', 'failureReason']) &&
        result.ok === false &&
        (result.reason === 'compaction_timeout' ||
          (result.reason === 'invalid_compaction_candidate' &&
            safeCompactionFailureReason(result.failureReason)))
      ) {
        if (failures.size >= maxEntries && !failures.has(input.key))
          failures.delete(failures.keys().next().value);
        failures.set(input.key, {
          reason: result.reason,
          failureReason: safeCompactionFailureReason(result.failureReason),
          expiresAt: completedAt + cooldownMs,
        });
      }
      return result;
    },
    stats() {
      prune();
      return { entries: failures.size };
    },
    clear() {
      failures.clear();
    },
  });
}

module.exports = { compactionBackoffKey, createContextCompactionBackoff };
