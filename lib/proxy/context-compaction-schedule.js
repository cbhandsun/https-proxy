'use strict';

const { createHash } = require('node:crypto');

function dataFields(input, fields) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== fields.length
  )
    throw new TypeError('Invalid compaction schedule input');
  const result = Object.create(null);
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(input, field);
    if (!d || !Object.hasOwn(d, 'value')) throw new TypeError('Invalid compaction schedule input');
    result[field] = d.value;
  }
  if (
    typeof result.key !== 'string' ||
    !result.key ||
    result.key.length > 1024 ||
    Array.from(result.key).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new TypeError('Invalid compaction schedule key');
  return result;
}

// Numeric-only per-route observations never merge client histories. Latency
// headroom is a bounded forecast, not proof of billing or provider capacity.
function createContextCompactionSchedule(options = {}) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    !Reflect.ownKeys(options).every(
      (key) =>
        key === 'now' && Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')
    )
  )
    throw new TypeError('Invalid compaction schedule options');
  const now = options.now === undefined ? Date.now : options.now;
  if (typeof now !== 'function') throw new TypeError('Invalid compaction schedule clock');
  const samples = new Map();
  let lastTime = 0;
  function currentTime() {
    const time = now();
    if (
      !Number.isSafeInteger(time) ||
      time < lastTime ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - 1800000
    ) {
      samples.clear();
      return null;
    }
    lastTime = time;
    for (const [key, value] of samples) if (time >= value.expiresAt) samples.delete(key);
    return time;
  }
  const identity = (key) => createHash('sha256').update(key).digest('hex');
  return Object.freeze({
    observe(input) {
      const value = dataFields(input, ['key', 'kind', 'durationMs']);
      if (
        !['summary', 'main'].includes(value.kind) ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0 ||
        value.durationMs > 3600000
      )
        throw new TypeError('Invalid compaction schedule measurement');
      const time = currentTime();
      if (time === null) return false;
      const key = identity(value.key);
      let entry = samples.get(key);
      if (!entry) {
        if (samples.size >= 64) samples.delete(samples.keys().next().value);
        entry = { summary: [], main: [], expiresAt: time + 1800000 };
        samples.set(key, entry);
      }
      entry[value.kind].push(value.durationMs);
      if (entry[value.kind].length > 8) entry[value.kind].shift();
      entry.expiresAt = time + 1800000;
      return true;
    },
    decide(input) {
      const fields = [
        'key',
        'bodyBytes',
        'inputTokens',
        'hardBodyBytes',
        'inputTokenLimit',
        'growthReserveBytes',
        'preflightBodyBytes',
      ];
      const value = dataFields(input, fields);
      for (const field of fields.slice(1))
        if (!Number.isSafeInteger(value[field]) || value[field] < 0)
          throw new TypeError('Invalid compaction schedule budget');
      if (!value.hardBodyBytes || !value.inputTokenLimit || !value.preflightBodyBytes)
        throw new TypeError('Invalid compaction schedule budget');
      const time = currentTime();
      const entry = time === null ? null : samples.get(identity(value.key));
      const summaryMs = Math.ceil(Math.max(0, ...(entry?.summary || [])));
      const main = [...(entry?.main || [])].sort((a, b) => a - b);
      const mainMs = main.length ? Math.max(1, Math.ceil(main[Math.floor(main.length / 2)])) : 0;
      const forecastTurns =
        mainMs && summaryMs ? Math.min(4, Math.max(1, Math.ceil(summaryMs / mainMs))) : 1;
      const reserveBytes = Math.min(
        Math.floor(value.hardBodyBytes / 4),
        value.growthReserveBytes * forecastTurns
      );
      const reserveTokens = Math.min(
        Math.floor(value.inputTokenLimit / 4),
        Math.ceil(reserveBytes / 2)
      );
      const triggerBodyBytes = Math.min(
        value.preflightBodyBytes,
        value.hardBodyBytes - reserveBytes
      );
      const triggerInputTokens = value.inputTokenLimit - reserveTokens;
      const required =
        value.bodyBytes > value.hardBodyBytes || value.inputTokens > value.inputTokenLimit;
      return Object.freeze({
        mode: required
          ? 'required'
          : value.bodyBytes > triggerBodyBytes || value.inputTokens > triggerInputTokens
            ? 'background'
            : 'none',
        triggerBodyBytes,
        triggerInputTokens,
        reserveBytes,
        reserveTokens,
        forecastTurns,
        observedSummaryMs: summaryMs,
        observedMainMs: mainMs,
        summarySamples: entry?.summary.length || 0,
        mainSamples: entry?.main.length || 0,
      });
    },
    stats() {
      currentTime();
      return { routes: samples.size };
    },
  });
}

module.exports = { createContextCompactionSchedule };
