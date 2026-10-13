'use strict';

const DEFAULT_CAPACITY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REJECTION_RATIO = 0.7;
const DEFAULT_SUCCESSES_TO_PROBE = 3;
const DEFAULT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_CAPACITY_BYTES = 16 * 1024;
const CAPACITY_PROBE_RATIO = 1.05;
const ACCEPTED_SAMPLE_TTL_MS = 5 * 60 * 1000;
const MAX_ACCEPTED_SAMPLES = 8;
const DEFAULT_MAX_CAPACITY_ENTRIES = 256;

function positiveInteger(value, fallback) {
  const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(Math.floor(numeric)) && numeric >= 1 ? Math.floor(numeric) : fallback;
}

function createContextCapacityController(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
  const entries = new Map();
  const maxEntries = Math.min(
    4096,
    positiveInteger(options.maxEntries, DEFAULT_MAX_CAPACITY_ENTRIES)
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_CAPACITY_TTL_MS);
  const successesToProbe = positiveInteger(options.successesToProbe, DEFAULT_SUCCESSES_TO_PROBE);
  const probeCooldownMs = positiveInteger(options.probeCooldownMs, DEFAULT_PROBE_COOLDOWN_MS);
  const requestedRatio =
    typeof options.rejectionRatio === 'number' || typeof options.rejectionRatio === 'string'
      ? Number(options.rejectionRatio)
      : NaN;
  const rejectionRatio =
    Number.isFinite(requestedRatio) && requestedRatio > 0 && requestedRatio < 1
      ? requestedRatio
      : DEFAULT_REJECTION_RATIO;

  function rememberEntry(key, entry) {
    entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    entries.set(key, entry);
  }

  function activeEntry(key) {
    const normalizedKey = String(key || 'default');
    const entry = entries.get(normalizedKey);
    if (!entry) return { key: normalizedKey, entry: null };
    if (entry.expiresAt <= now()) {
      entries.delete(normalizedKey);
      return { key: normalizedKey, entry: null };
    }
    return { key: normalizedKey, entry };
  }

  function targetBytes(key, configuredBytes) {
    const configured = positiveInteger(configuredBytes, 0);
    const current = activeEntry(key).entry;
    if (!current || !current.safeBytes) return configured;
    return configured ? Math.min(configured, current.safeBytes) : current.safeBytes;
  }

  function recentAcceptedSamples(entry, currentTime) {
    return (entry?.acceptedSamples || []).filter(
      (sample) => sample.at <= currentTime && currentTime - sample.at < ACCEPTED_SAMPLE_TTL_MS
    );
  }

  function recordRejection(key, rejectedBytes) {
    const rejected = positiveInteger(rejectedBytes, 0);
    if (!rejected) return null;
    const current = activeEntry(key);
    if (rejected <= 1) return null;
    const belowRejected = Math.max(1, rejected - Math.min(1024, Math.ceil(rejected * 0.05)));
    const reduced = Math.min(belowRejected, Math.floor(rejected * rejectionRatio));
    const acceptedSamples = recentAcceptedSamples(current.entry, now());
    const acceptedFloor = acceptedSamples.reduce(
      (maximum, sample) =>
        sample.bytes <= belowRejected ? Math.max(maximum, sample.bytes) : maximum,
      0
    );
    const conservativeBytes = current.entry?.safeBytes
      ? Math.min(current.entry.safeBytes, reduced)
      : Math.max(Math.min(MIN_CAPACITY_BYTES, belowRejected), reduced);
    const safeBytes = Math.max(conservativeBytes, acceptedFloor);
    const entry = {
      safeBytes,
      successes: 0,
      expiresAt: now() + ttlMs,
      nextProbeAt: now() + probeCooldownMs,
      // Host RPC rejection is not a proven monotonic provider limit. Use it as
      // a temporary conservative envelope, expiring with this learning epoch.
      probeCeiling: Math.min(current.entry?.probeCeiling ?? belowRejected, belowRejected),
      acceptedSamples,
    };
    entry.safeBytes = Math.min(entry.safeBytes, entry.probeCeiling);
    rememberEntry(current.key, entry);
    return { safeBytes: entry.safeBytes, successes: entry.successes };
  }

  function recordSuccess(key, acceptedBytes, configuredBytes) {
    const accepted = positiveInteger(acceptedBytes, 0);
    const configured = positiveInteger(configuredBytes, 0);
    const current = activeEntry(key);
    if (!accepted) return null;
    const currentTime = now();
    const acceptedSamples = [
      ...recentAcceptedSamples(current.entry, currentTime),
      { bytes: accepted, at: currentTime },
    ].slice(-MAX_ACCEPTED_SAMPLES);
    if (!current.entry?.safeBytes) {
      // Remember transport acceptance even before a rejection. It is not a
      // learned limit and must not change the configured planning ceiling.
      rememberEntry(current.key, { acceptedSamples, expiresAt: currentTime + ttlMs });
      return null;
    }
    const successes =
      accepted >= Math.floor(current.entry.safeBytes * 0.8)
        ? Math.min(successesToProbe, current.entry.successes + 1)
        : current.entry.successes;
    let safeBytes = Math.min(
      current.entry.probeCeiling,
      configured || Number.MAX_SAFE_INTEGER,
      Math.max(current.entry.safeBytes, accepted)
    );
    let nextSuccesses = successes;
    let nextProbeAt = current.entry.nextProbeAt;
    if (
      successes >= successesToProbe &&
      now() >= nextProbeAt &&
      accepted >= Math.floor(safeBytes * 0.8)
    ) {
      const probed = Math.max(safeBytes + 1024, Math.floor(safeBytes * CAPACITY_PROBE_RATIO));
      safeBytes = Math.min(
        current.entry.probeCeiling,
        configured || Number.MAX_SAFE_INTEGER,
        probed
      );
      nextSuccesses = 0;
      nextProbeAt = now() + probeCooldownMs;
    }
    // Success never renews the rejection TTL: small unrelated traffic cannot
    // preserve an overly conservative learned limit indefinitely.
    const entry = {
      ...current.entry,
      safeBytes,
      successes: nextSuccesses,
      nextProbeAt,
      acceptedSamples,
    };
    rememberEntry(current.key, entry);
    return { safeBytes: entry.safeBytes, successes: entry.successes };
  }

  function diagnostics(key) {
    const current = activeEntry(key).entry;
    if (!current?.safeBytes) return { learned: false, safeBytes: 0, successes: 0 };
    return { learned: true, safeBytes: current.safeBytes, successes: current.successes };
  }

  return { diagnostics, recordRejection, recordSuccess, targetBytes };
}

module.exports = {
  DEFAULT_CAPACITY_TTL_MS,
  DEFAULT_REJECTION_RATIO,
  DEFAULT_SUCCESSES_TO_PROBE,
  DEFAULT_PROBE_COOLDOWN_MS,
  createContextCapacityController,
};
