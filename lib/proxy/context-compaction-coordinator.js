'use strict';

const { createHash } = require('node:crypto');

function positive(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
function identity(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

function abortSignal(value) {
  return value === undefined || value === null || value instanceof globalThis.AbortSignal;
}

function createContextCompactionCoordinator(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const deadlineMs = positive(options.deadlineMs, 12000, 30000);
  const ttlMs = positive(options.ttlMs, 30000, 300000);
  const maxEntries = positive(options.maxEntries, 64, 256);
  const maxActive = positive(options.maxActive, 4, 16);
  const maxValueBytes = positive(options.maxValueBytes, 32 * 1024, 256 * 1024);
  const maxCacheBytes = Math.max(
    maxValueBytes,
    positive(options.maxCacheBytes, 2 * 1024 * 1024, 8 * 1024 * 1024)
  );
  const cache = new Map();
  const flights = new Map();
  let cacheBytes = 0;
  let lastTime = 0;
  let generation = 0;
  let closed = false;

  function prune() {
    const current = now();
    if (
      !Number.isSafeInteger(current) ||
      current < lastTime ||
      current > Number.MAX_SAFE_INTEGER - ttlMs
    ) {
      cache.clear();
      cacheBytes = 0;
      return null;
    }
    lastTime = current;
    for (const [key, entry] of cache)
      if (current >= entry.expiresAt) {
        cache.delete(key);
        cacheBytes -= entry.bytes;
      }
    return current;
  }
  function outcome(reason) {
    return { ok: false, reason };
  }

  function subscribe(flight, signal) {
    if (signal?.aborted) return Promise.resolve(outcome('compaction_cancelled'));
    flight.subscribers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      function finish(value, error) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        flight.subscribers -= 1;
        if (flight.subscribers === 0 && !flight.completed) flight.cancel();
        if (error) reject(error);
        else resolve(value);
      }
      function cancel() {
        finish(outcome('compaction_cancelled'));
      }
      signal?.addEventListener('abort', cancel, { once: true });
      flight.promise.then(
        (value) => finish(value),
        (error) => finish(undefined, error)
      );
      if (signal?.aborted) cancel();
    });
  }

  return {
    run(request = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request))
        return Promise.resolve(outcome('invalid_compaction_request'));
      const { owner, scope, operationId, snapshotDigest, produce, validate, signal } = request;
      const current = prune();
      if (closed) return Promise.resolve(outcome('compaction_closed'));
      if (current === null) return Promise.resolve(outcome('compaction_clock_invalid'));
      if (
        !identity(owner) ||
        !identity(scope) ||
        !identity(operationId) ||
        typeof snapshotDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
        typeof produce !== 'function' ||
        typeof validate !== 'function' ||
        !abortSignal(signal)
      )
        return Promise.resolve(outcome('invalid_compaction_request'));
      if (signal?.aborted) return Promise.resolve(outcome('compaction_cancelled'));
      const key = createHash('sha256')
        .update(JSON.stringify([owner, scope, operationId]))
        .digest('hex');
      const cached = cache.get(key);
      if (cached)
        return Promise.resolve().then(() => {
          if (cached.digest !== snapshotDigest) return outcome('compaction_id_conflict');
          if (signal?.aborted) return outcome('compaction_cancelled');
          if (validate(cached.value) !== true) return outcome('invalid_compaction_candidate');
          return { ok: true, value: cached.value, generation: cached.generation, reused: true };
        });
      const existing = flights.get(key);
      if (existing)
        return existing.digest === snapshotDigest
          ? subscribe(existing, signal).then((result) =>
              result.ok && validate(result.value) !== true
                ? outcome('invalid_compaction_candidate')
                : result
            )
          : Promise.resolve(outcome('compaction_id_conflict'));
      if (
        flights.size >= maxActive ||
        cache.size + flights.size >= maxEntries ||
        cacheBytes + (flights.size + 1) * maxValueBytes > maxCacheBytes ||
        [...flights.values()].some((flight) => flight.owner === owner)
      )
        return Promise.resolve(outcome('compaction_busy'));
      const controller = new globalThis.AbortController();
      let settleCancellation;
      const cancellation = new Promise((resolve) => {
        settleCancellation = resolve;
      });
      const flight = {
        owner,
        digest: snapshotDigest,
        subscribers: 0,
        completed: false,
        cancel(reason = 'compaction_cancelled') {
          settleCancellation(outcome(reason));
          controller.abort();
        },
      };
      const timer = setTimeout(() => flight.cancel('compaction_timeout'), deadlineMs);
      const work = Promise.resolve().then(async () => {
        if (controller.signal.aborted) return outcome('compaction_cancelled');
        const value = await produce(controller.signal);
        if (controller.signal.aborted) return outcome('compaction_cancelled');
        if (
          typeof value !== 'string' ||
          !value.trim() ||
          Buffer.byteLength(value) > maxValueBytes ||
          validate(value) !== true
        )
          return outcome('invalid_compaction_candidate');
        return { ok: true, value };
      });
      flight.promise = Promise.race([work, cancellation]).then((result) => {
        const completionTime = prune();
        if (controller.signal.aborted && result.ok) return outcome('compaction_cancelled');
        if (completionTime === null) return outcome('compaction_clock_invalid');
        if (!result.ok) return result;
        generation += 1;
        const bytes = Buffer.byteLength(result.value);
        // A full cache is not permission to drop a live response. Return it
        // uncached; no task data is persisted to disk or logged.
        if (!closed && cache.size < maxEntries && cacheBytes + bytes <= maxCacheBytes) {
          cache.set(key, {
            value: result.value,
            digest: snapshotDigest,
            bytes,
            generation,
            expiresAt: completionTime + ttlMs,
          });
          cacheBytes += bytes;
        }
        return { ...result, generation, reused: false };
      });
      flights.set(key, flight);
      // Install both terminal handlers without an ignored rejecting finally
      // promise. Even an abandoned producer rejection is observed safely.
      function clean() {
        clearTimeout(timer);
        flight.completed = true;
        flights.delete(key);
      }
      flight.promise.then(clean, clean);
      return subscribe(flight, signal);
    },
    stats() {
      prune();
      return { active: flights.size, entries: cache.size, cacheBytes };
    },
    close() {
      closed = true;
      cache.clear();
      cacheBytes = 0;
      for (const flight of flights.values()) flight.cancel('compaction_closed');
    },
  };
}

module.exports = { createContextCompactionCoordinator };
