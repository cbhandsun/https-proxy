'use strict';

const { createHash } = require('node:crypto');
const {
  normalizeCompactionData,
  validateLocalCompactionBinding,
} = require('./context-compaction-envelope');
const { isContextHistoryBranch, contextHistoryControlDigest } = require('./context-history-branch');
const { createSummaryFrontier } = require('./context-summary-frontier');

const MAX_VALUE_BYTES = 32 * 1024;
const MAX_CHUNKS = 16;
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
function positive(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Content-addressed semantic data only: no history replacement, archive receipt,
// locator, scope transfer or execution capability is stored here. A fresh caller
// must parse every hit against its own source and publish its own evidence.
// Normal writes require the outer history/evidence commit. On a coordinator
// timeout, explicitly marked, validated semantic progress can be saved without
// publishing history/evidence. Reuse still reparses against fresh exact sources.
function createContextSummaryCheckpoints(options = {}) {
  if (!fields(options, ['now', 'ttlMs', 'maxEntries', 'maxBytes', 'maxActive']))
    throw new TypeError('Invalid summary checkpoint options');
  const {
    now = Date.now,
    ttlMs = 30 * 60 * 1000,
    maxEntries = 64,
    maxBytes = 2 * 1024 * 1024,
    maxActive = 4,
  } = options;
  if (
    typeof now !== 'function' ||
    !positive(ttlMs, 30 * 60 * 1000) ||
    !positive(maxEntries, 256) ||
    !positive(maxBytes, 8 * 1024 * 1024) ||
    !positive(maxActive, 16)
  )
    throw new TypeError('Invalid summary checkpoint limits');
  const entries = new Map();
  const active = new Set();
  let retainedBytes = 0,
    reservedBytes = 0,
    lastTime = 0,
    closed = false;
  function prune() {
    const time = now();
    if (
      !Number.isSafeInteger(time) ||
      time < 0 ||
      time < lastTime ||
      time > Number.MAX_SAFE_INTEGER - ttlMs
    ) {
      entries.clear();
      retainedBytes = 0;
      for (const operation of [...active]) operation.rollback();
      return null;
    }
    lastTime = time;
    for (const [key, entry] of entries) {
      if (time < entry.expiresAt) continue;
      entries.delete(key);
      retainedBytes -= entry.bytes;
    }
    return time;
  }
  return Object.freeze({
    begin(input) {
      if (
        !fields(input, ['history', 'snapshot', 'binding', 'protectedIndices', 'signal']) ||
        !isContextHistoryBranch(input.history) ||
        !input.history.inspect(input.snapshot).ok ||
        (input.signal != null && !(input.signal instanceof globalThis.AbortSignal))
      )
        throw new TypeError('Invalid summary checkpoint source');
      const binding = normalizeCompactionData(input.binding, 4096);
      const route = validateLocalCompactionBinding(binding);
      if (binding.owner !== input.history.identity.owner)
        throw new TypeError('Summary checkpoint owner mismatch');
      const pins = normalizeCompactionData(input.protectedIndices ?? [], 128 * 1024);
      const body = input.snapshot.body;
      if (
        !Array.isArray(pins) ||
        pins.length > body.messages.length ||
        pins.some(
          (index) => !Number.isSafeInteger(index) || index < 0 || index >= body.messages.length
        )
      )
        throw new TypeError('Invalid summary checkpoint protection');
      if (input.signal?.aborted || closed || prune() === null || active.size >= maxActive)
        return null;
      const controls = contextHistoryControlDigest(body);
      const policy = hash(
        JSON.stringify(
          body.messages.filter((message) => ['system', 'developer'].includes(message.role))
        )
      );
      const prefix = createHash('sha256').update('hpm.summary.source-prefix.v1\n');
      const prefixes = [];
      const keys = new WeakMap();
      const staged = new Map();
      const reusedKeys = new Set();
      let frontier = null;
      let frontierReused = false;
      let frontierProgressReused = false;
      let frontierSourceMessages = 0;
      let progressSavedEntries = 0;
      let bytes = 0,
        keyCount = 0,
        hits = 0,
        misses = 0,
        settled = false,
        committed = false;
      function finish() {
        settled = true;
        reservedBytes -= bytes;
        bytes = 0;
        staged.clear();
        reusedKeys.clear();
        prefixes.length = 0;
        active.delete(operation);
        input.signal?.removeEventListener('abort', cancel);
      }
      function cancel() {
        operation.rollback();
      }
      function keyFor(token) {
        const key = token && keys.get(token);
        if (!key) throw new TypeError('Invalid summary checkpoint chunk');
        return key;
      }
      function prefixIdentity(sourceIndex, limits) {
        while (prefixes.length <= sourceIndex) {
          prefix.update(JSON.stringify(body.messages[prefixes.length])).update('\n');
          prefixes.push(prefix.copy().digest('hex'));
        }
        return [
          route,
          controls,
          policy,
          prefixes[sourceIndex],
          [...new Set(pins.filter((index) => index <= sourceIndex))].sort((a, b) => a - b),
          limits.maxBytes,
          limits.maxTokens,
        ];
      }
      function matchesFrontier(candidate) {
        if (!frontier || !candidate || candidate.sourceIndex >= body.messages.length) return false;
        const key = frontier.key(
          candidate.sourceIndex,
          prefixIdentity(candidate.sourceIndex, frontier.limits)
        );
        return key !== null && key === candidate.key;
      }
      function obsoleteProgress(sourceIndex) {
        const obsolete = [];
        for (const [key, entry] of entries) {
          if (entry.progress !== true || !matchesFrontier(entry.frontier)) continue;
          // A slower concurrent operation must not overwrite or accumulate
          // beneath an already saved, equally/further advanced frontier.
          if (entry.frontier.sourceIndex >= sourceIndex) return null;
          obsolete.push([key, entry]);
        }
        return obsolete;
      }
      function stage(token, value, resumable) {
        if (settled) return false;
        const record = keyFor(token);
        const { key } = record;
        if (
          typeof value !== 'string' ||
          !value.trim() ||
          Buffer.byteLength(value) > MAX_VALUE_BYTES
        )
          throw new TypeError('Invalid summary checkpoint value');
        const time = prune();
        if (settled || time === null) return false;
        if (resumable && !record.frontier) return false;
        if (entries.has(key) || staged.has(key)) return true;
        const size = Buffer.byteLength(value) + (record.frontier ? 256 : 128);
        if (retainedBytes + reservedBytes + size > maxBytes) return false;
        staged.set(key, {
          value,
          bytes: size,
          resumable,
          expiresAt: time + ttlMs,
          ...(record.frontier ? { frontier: record.frontier } : {}),
        });
        bytes += size;
        reservedBytes += size;
        return true;
      }
      const operation = Object.freeze({
        prepareFrontier(sourcePrefixes, limits, contract) {
          if (settled) return null;
          if (frontier) throw new TypeError('Summary frontier already prepared');
          frontier = createSummaryFrontier(sourcePrefixes, limits, contract, body.messages.length);
          if (prune() === null || settled) return null;
          let selected = null;
          let selectedProgress = false;
          let selectedKey;
          for (const [entryKey, entry] of entries) {
            const candidate = entry.frontier;
            if (
              !candidate ||
              candidate.sourceIndex >= body.messages.length ||
              (selected && candidate.sourceIndex <= selected.sourceIndex)
            )
              continue;
            if (!matchesFrontier(candidate)) continue;
            selected = Object.freeze({ sourceIndex: candidate.sourceIndex, text: entry.value });
            selectedProgress = entry.progress === true;
            selectedKey = entryKey;
          }
          if (selected) {
            hits++;
            frontierReused = true;
            frontierProgressReused = selectedProgress;
            frontierSourceMessages = selected.sourceIndex + 1;
            reusedKeys.add(selectedKey);
          }
          return selected;
        },
        key(sourceIndex, request, limits) {
          if (settled) return null;
          if (
            !Number.isSafeInteger(sourceIndex) ||
            sourceIndex < 0 ||
            sourceIndex >= body.messages.length ||
            !fields(limits, ['maxBytes', 'maxTokens']) ||
            !positive(limits.maxBytes, 16 * 1024 * 1024) ||
            !positive(limits.maxTokens, 16 * 1024 * 1024) ||
            keyCount >= MAX_CHUNKS
          )
            throw new TypeError('Invalid summary checkpoint chunk');
          // Revalidate request data descriptors before hashing. Caller hooks,
          // sparse arrays and provider-specific executable values are rejected.
          const safeRequest = normalizeCompactionData(request, 2 * 1024 * 1024);
          const identity = prefixIdentity(sourceIndex, limits);
          const key = hash(
            JSON.stringify(['hpm.summary.committed-chunk.v1', ...identity, safeRequest])
          );
          const token = Object.freeze({});
          const frontierKey = frontier?.key(sourceIndex, identity);
          keys.set(token, {
            key,
            ...(frontierKey ? { frontier: { key: frontierKey, sourceIndex } } : {}),
          });
          keyCount++;
          return token;
        },
        read(token) {
          if (settled) return null;
          const { key } = keyFor(token);
          if (settled || prune() === null) return null;
          const entry = entries.get(key);
          if (entry) {
            hits++;
            reusedKeys.add(key);
            return entry.value;
          }
          misses++;
          return null;
        },
        stage(token, value) {
          return stage(token, value, false);
        },
        stageProgress(token, value) {
          return stage(token, value, true);
        },
        saveProgress() {
          if (settled) return false;
          const time = prune();
          const current = input.history.inspect(input.snapshot);
          if (
            time === null ||
            settled ||
            input.signal?.aborted ||
            !current.ok ||
            contextHistoryControlDigest(current.body) !== controls ||
            hash(
              JSON.stringify(
                current.body.messages.filter((message) =>
                  ['system', 'developer'].includes(message.role)
                )
              )
            ) !== policy
          ) {
            if (!settled) finish();
            return false;
          }
          // Only the furthest eligible cumulative state is needed. It has no
          // authority to publish the unfinished branch and keeps its stage-time
          // expiry; repeated timeouts/reads must not renew retention.
          const candidate = [...staged]
            .filter(([, entry]) => entry.resumable && time < entry.expiresAt)
            .sort((a, b) => b[1].frontier.sourceIndex - a[1].frontier.sourceIndex)[0];
          if (!candidate) {
            finish();
            return false;
          }
          const [key, entry] = candidate;
          const obsolete = obsoleteProgress(entry.frontier.sourceIndex);
          if (
            entries.has(key) ||
            obsolete === null ||
            entries.size - obsolete.length + 1 > maxEntries
          ) {
            finish();
            return false;
          }
          // Replace only source-matched uncommitted computation, atomically at
          // timeout. Committed/foreign entries survive, and the new state was
          // already reserved under the unchanged aggregate byte ceiling.
          for (const [oldKey, oldEntry] of obsolete) {
            entries.delete(oldKey);
            retainedBytes -= oldEntry.bytes;
          }
          entries.set(key, { ...entry, progress: true });
          retainedBytes += entry.bytes;
          progressSavedEntries = 1;
          finish();
          return progressSavedEntries > 0;
        },
        commit() {
          if (settled) return committed;
          const time = prune();
          if (time === null || settled || input.signal?.aborted) return false;
          const fresh = [...staged].filter(([key]) => !entries.has(key));
          if (entries.size + fresh.length > maxEntries) {
            finish();
            return false;
          }
          for (const [key, entry] of fresh) {
            entries.set(key, { ...entry, expiresAt: time + ttlMs });
            retainedBytes += entry.bytes;
          }
          // A successful outer publication promotes reused progress without
          // renewing its expiry. It is no longer an evictable partial result.
          for (const key of reusedKeys) {
            const entry = entries.get(key);
            if (entry?.progress === true) entries.set(key, { ...entry, progress: false });
          }
          committed = true;
          finish();
          return true;
        },
        rollback() {
          if (settled) return false;
          finish();
          return true;
        },
        stats() {
          return {
            hits,
            misses,
            stagedEntries: staged.size,
            committed,
            ...(frontier
              ? {
                  frontierReused,
                  frontierProgressReused,
                  frontierSourceMessages,
                  progressSavedEntries,
                }
              : {}),
          };
        },
      });
      active.add(operation);
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();
      return operation;
    },
    stats() {
      prune();
      return { entries: entries.size, retainedBytes, reservedBytes, active: active.size, closed };
    },
    close() {
      closed = true;
      for (const operation of [...active]) operation.rollback();
      entries.clear();
      retainedBytes = 0;
    },
  });
}

module.exports = { createContextSummaryCheckpoints };
