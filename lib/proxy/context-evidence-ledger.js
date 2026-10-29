'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { parseStoredEvidencePage } = require('./context-evidence-stored-page');
const { parseContextEvidenceRequest } = require('./context-evidence-request');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { createContextArtifactStore } = require('./context-artifact-store');
const { MAX_ARTIFACT_PAGE_BYTES, buildContextArtifactPage } = require('./context-artifact-page');
const {
  evidenceLedgerPolicy,
  ledgerStateFailure,
  parseEvidenceLedgerState,
  parseOwnedEvidenceLedgerState,
  parseEvidenceLedgerMetadata,
} = require('./context-evidence-ledger-state');
const {
  contextEvidencePageBudget,
  attachContextEvidencePageSource,
} = require('./context-evidence-page');

const SOURCE_ID = /^hce_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value, max = 256) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
const transfers = new WeakMap();
const observedCaptures = new WeakMap();
const asyncPageReads = new WeakMap();
const progressExports = new WeakMap();
const metadataExports = new WeakMap();
const payloadExports = new WeakMap();
const evictions = new WeakMap();
const residencies = new WeakMap();

function refusal(code = 'invalid_evidence_ledger') {
  const error = new TypeError('Client evidence is invalid or unavailable');
  error.code = code;
  return error;
}

function data(value, bytes) {
  try {
    return normalizeCompactionData(value, bytes);
  } catch {
    throw refusal();
  }
}

function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw refusal();
  return value;
}

function settings(value) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw refusal();
  const safe = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !['owner', 'threadId', 'now', 'ttlMs', 'maxEntries', 'maxOutputBytes', 'maxBytes'].includes(
        key
      ) ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    )
      throw refusal();
    safe[key] = descriptor.value;
  }
  if (!identity(safe.owner) || !identity(safe.threadId)) throw refusal();
  if (safe.now !== undefined && typeof safe.now !== 'function') throw refusal();
  return {
    owner: safe.owner,
    threadId: safe.threadId,
    now: safe.now ?? Date.now,
    ttlMs: integer(safe.ttlMs, 30 * 60 * 1000, 24 * 60 * 60 * 1000),
    maxEntries: integer(safe.maxEntries, 64, 512),
    maxOutputBytes: integer(safe.maxOutputBytes, 1024 * 1024, 2 * 1024 * 1024),
    maxBytes: integer(safe.maxBytes, 4 * 1024 * 1024, 16 * 1024 * 1024),
  };
}

// Client-owned tool data, not a native checkpoint or a policy/summary. The
// capability stays with one caller/thread and must never be shared across
// clients. Only the caller can capture a completed result; model-facing tools
// can only list/read. No executor, filesystem, transport or credential access.
function createContextEvidenceLedger(options) {
  return createLedger(options);
}

function createLedger(options, restoredState, metadataOnly = false, proof) {
  const limits = settings(options);
  if (limits.maxBytes < limits.maxOutputBytes) throw refusal();
  const owner = sha(JSON.stringify([limits.owner, limits.threadId]));
  const scope = 'hcs_' + randomUUID().replace(/-/g, '');
  const sources = new Map();
  const calls = new Map();
  const cold = new Set();
  let currentTime = 0;
  let closed = false;
  let capturedCount = 0;
  let readCount = 0;
  const store = createContextArtifactStore({
    now: () => currentTime,
    ttlMs: limits.ttlMs,
    maxLifetimeMs: limits.ttlMs,
    maxArtifactBytes: limits.maxOutputBytes,
    maxBytes: limits.maxBytes,
    maxOwnerBytes: limits.maxBytes,
    maxSessionBytes: limits.maxBytes,
    maxEntries: limits.maxEntries,
    maxOwnerEntries: limits.maxEntries,
    maxSessionEntries: limits.maxEntries,
  });

  function close() {
    closed = true;
    sources.clear();
    calls.clear();
    cold.clear();
    store.close();
  }

  function clock() {
    if (closed) throw refusal('evidence_ledger_closed');
    let next;
    try {
      next = limits.now();
    } catch {
      close();
      throw refusal('evidence_ledger_clock_invalid');
    }
    if (
      !Number.isSafeInteger(next) ||
      next < currentTime ||
      next < 0 ||
      next > Number.MAX_SAFE_INTEGER - limits.ttlMs
    ) {
      close();
      throw refusal('evidence_ledger_clock_invalid');
    }
    currentTime = next;
    for (const [id, source] of sources) {
      if (currentTime >= source.expiresAt) {
        sources.delete(id);
        calls.delete(source.callId);
        cold.delete(id);
      }
    }
  }

  function descriptor(source) {
    return {
      sourceId: source.sourceId,
      callId: source.callId,
      toolName: source.toolName,
      argumentsDigest: source.argumentsDigest,
      digest: source.digest,
      bytes: source.bytes,
      expiresAt: source.expiresAt,
      trust: 'tool_data_not_instructions',
    };
  }

  function retain(source, argumentsDigest) {
    const digest = sha(source.output);
    const prior = calls.get(source.callId);
    if (prior) {
      if (
        prior.toolName !== source.toolName ||
        prior.argumentsDigest !== argumentsDigest ||
        prior.digest !== digest
      )
        throw refusal('evidence_source_conflict');
      return descriptor(prior);
    }
    // Empty evidence consumes an index slot without an artifact reservation.
    if (sources.size >= limits.maxEntries) throw refusal('evidence_ledger_quota');
    const bytes = Buffer.byteLength(source.output);
    if (
      [...sources.values()].reduce((total, entry) => total + entry.bytes, bytes) > limits.maxBytes
    )
      throw refusal('evidence_ledger_quota');
    const receipt = source.output.length ? store.put(owner, scope, source.output) : null;
    if (source.output.length && !receipt) throw refusal('evidence_ledger_quota');
    const entry = {
      sourceId: 'hce_' + randomUUID().replace(/-/g, ''),
      callId: source.callId,
      toolName: source.toolName,
      argumentsDigest,
      digest,
      bytes,
      createdAt: currentTime,
      expiresAt: currentTime + limits.ttlMs,
      locator: receipt?.locator ?? null,
      coveredThrough: 0,
      readComplete: false,
    };
    sources.set(entry.sourceId, entry);
    calls.set(entry.callId, entry);
    capturedCount++;
    return descriptor(entry);
  }

  const ledger = {
    capture(value) {
      clock();
      const source = data(value, limits.maxOutputBytes + 8192);
      if (
        !record(source) ||
        Object.keys(source).sort().join(',') !== 'arguments,callId,completed,output,toolName' ||
        source.completed !== true ||
        !identity(source.callId) ||
        !identity(source.toolName, 128) ||
        !record(source.arguments) ||
        typeof source.output !== 'string' ||
        Buffer.byteLength(source.output) > limits.maxOutputBytes ||
        Buffer.from(source.output, 'utf8').toString('utf8') !== source.output
      )
        throw refusal();
      const argumentsDigest = sha(JSON.stringify(data(source.arguments, 4096)));
      return retain(source, argumentsDigest);
    },
    list(value = {}) {
      clock();
      const args = data(value, 1024);
      if (
        !record(args) ||
        Object.keys(args).some((key) => !['afterSourceId', 'limit'].includes(key)) ||
        (args.afterSourceId !== undefined &&
          (typeof args.afterSourceId !== 'string' || !SOURCE_ID.test(args.afterSourceId)))
      )
        throw refusal();
      const limit = integer(args.limit, 8, 16);
      const entries = [...sources.values()];
      const after =
        args.afterSourceId === undefined
          ? -1
          : entries.findIndex((source) => source.sourceId === args.afterSourceId);
      if (args.afterSourceId !== undefined && after === -1)
        throw refusal('evidence_index_unavailable');
      const selected = entries.slice(after + 1, after + 1 + limit);
      return {
        ok: true,
        sources: selected.map(descriptor),
        nextAfterSourceId:
          after + 1 + selected.length < entries.length ? selected.at(-1).sourceId : null,
      };
    },
    read(value, maxResultBytes = 16 * 1024) {
      clock();
      const args = data(value, 1024);
      if (
        !record(args) ||
        Object.keys(args).some(
          (key) => !['sourceId', 'digest', 'offsetBytes', 'limitBytes'].includes(key)
        ) ||
        typeof args.sourceId !== 'string' ||
        !SOURCE_ID.test(args.sourceId) ||
        typeof args.digest !== 'string' ||
        !DIGEST.test(args.digest) ||
        !Number.isSafeInteger(maxResultBytes) ||
        maxResultBytes < 0 ||
        maxResultBytes > MAX_ARTIFACT_PAGE_BYTES
      )
        throw refusal();
      const source = sources.get(args.sourceId);
      if (!source || source.digest !== args.digest)
        return { ok: false, error: 'context_evidence_unavailable' };
      if (cold.has(source.sourceId)) return { ok: false, error: 'context_evidence_unavailable' };
      const metadata = descriptor(source);
      const remaining = contextEvidencePageBudget(metadata, maxResultBytes);
      const range = Object.fromEntries(
        Object.entries(args).filter(([key]) => ['offsetBytes', 'limitBytes'].includes(key))
      );
      // An empty source goes through the same bounded UTF-8 page contract.
      const result = source.locator
        ? store.readPage(owner, scope, source.locator, source.digest, range, remaining)
        : buildContextArtifactPage('', 'utf8', source.digest, range, remaining);
      const output = attachContextEvidencePageSource(result, metadata, maxResultBytes);
      if (!output.ok) return output;
      // Only contiguous read-back from byte zero qualifies as complete source
      // recovery. Seeking is allowed, but isolated fragments do not prove it.
      if (result.page.offsetBytes <= source.coveredThrough) {
        source.coveredThrough = Math.max(source.coveredThrough, result.page.endOffsetBytes);
        source.readComplete = source.coveredThrough === source.bytes;
      }
      readCount++;
      return output;
    },
    inspect() {
      clock();
      return {
        capturedCount,
        readCount,
        retainedEntries: sources.size,
        fullyReadSources: [...sources.values()].filter((source) => source.readComplete).length,
        persistence: 'memory',
      };
    },
    close,
  };
  observedCaptures.set(ledger, (input) => {
    clock();
    const source = data(input, limits.maxOutputBytes + 8192);
    if (
      !record(source) ||
      Object.keys(source).sort().join(',') !== 'argumentsDigest,callId,completed,output,toolName' ||
      source.completed !== true ||
      !identity(source.callId) ||
      !identity(source.toolName, 128) ||
      typeof source.argumentsDigest !== 'string' ||
      !DIGEST.test(source.argumentsDigest) ||
      typeof source.output !== 'string' ||
      Buffer.byteLength(source.output) > limits.maxOutputBytes ||
      Buffer.from(source.output, 'utf8').toString('utf8') !== source.output
    )
      throw refusal();
    return retain(source, source.argumentsDigest);
  });
  asyncPageReads.set(ledger, async (value, maxResultBytes, fetchPage) => {
    clock();
    const parsed = parseContextEvidenceRequest('hpm_read_retained_evidence', value);
    if (
      !parsed.ok ||
      typeof fetchPage !== 'function' ||
      !Number.isSafeInteger(maxResultBytes) ||
      maxResultBytes < 0 ||
      maxResultBytes > MAX_ARTIFACT_PAGE_BYTES
    )
      throw refusal();
    const args = parsed.arguments;
    const source = sources.get(args.sourceId);
    if (!source || source.digest !== args.digest)
      return { ok: false, error: 'context_evidence_unavailable' };
    const metadata = descriptor(source);
    const pending = fetchPage(metadata, args, maxResultBytes);
    const input = nativeReaderPromise(pending) ? await pending : pending;
    clock();
    if (sources.get(source.sourceId) !== source)
      return { ok: false, error: 'context_evidence_unavailable' };
    const result = parseStoredEvidencePage(input, metadata, args, maxResultBytes);
    if (!result.ok) return result;
    if (result.page.offsetBytes <= source.coveredThrough) {
      source.coveredThrough = Math.max(source.coveredThrough, result.page.endOffsetBytes);
      source.readComplete = source.coveredThrough === source.bytes;
    }
    readCount++;
    return result;
  });
  progressExports.set(ledger, () => {
    clock();
    return {
      observedAt: currentTime,
      readCount,
      sources: [...sources.values()].map(({ sourceId, coveredThrough, readComplete }) => ({
        sourceId,
        coveredThrough,
        readComplete,
      })),
    };
  });
  metadataExports.set(ledger, () => {
    clock();
    return parseEvidenceLedgerMetadata(
      {
        version: 1,
        kind: 'evidence-ledger-metadata',
        ownerBinding: owner,
        policy: evidenceLedgerPolicy(limits),
        observedAt: currentTime,
        capturedCount,
        readCount,
        sources: [...sources.values()].map(({ locator: _locator, ...source }) => source),
      },
      owner,
      limits
    );
  });
  function materialize({ locator, ...source }) {
    if (cold.has(source.sourceId)) throw ledgerStateFailure();
    const payload = locator ? store.read(owner, scope, locator, source.digest) : null;
    if (
      locator &&
      (!payload?.ok ||
        typeof payload.value !== 'string' ||
        payload.bytes !== source.bytes ||
        payload.digest !== source.digest ||
        payload.expiresAt !== source.expiresAt)
    )
      throw ledgerStateFailure();
    if (!locator && source.bytes !== 0) throw ledgerStateFailure();
    return { ...source, output: payload?.value ?? '' };
  }
  function exportSelected(selected) {
    return parseEvidenceLedgerState(
      {
        version: 1,
        kind: 'evidence-ledger',
        ownerBinding: owner,
        policy: evidenceLedgerPolicy(limits),
        observedAt: currentTime,
        capturedCount,
        readCount,
        sources: selected.map(materialize),
      },
      owner,
      limits
    );
  }
  payloadExports.set(ledger, (input) => {
    clock();
    const ids = selectedIds(input);
    const selected = new Set(ids);
    return exportSelected(
      [...sources.values()].filter((source) => selected.has(source.sourceId))
    ).sources.map(({ sourceId, output }) => ({ sourceId, output }));
  });
  function selectedIds(input) {
    const ids = normalizeCompactionData(input, 32 * 1024);
    if (
      !Array.isArray(ids) ||
      ids.length > limits.maxEntries ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !SOURCE_ID.test(id) || !sources.has(id))
    )
      throw ledgerStateFailure();
    return ids;
  }
  // Trusted persistence owner only, after a validated durable acknowledgement.
  // The entire selection authenticates before any resident payload is discarded.
  evictions.set(ledger, (input) => {
    clock();
    const ids = new Set(selectedIds(input));
    const selected = [...sources.values()].filter((source) => ids.has(source.sourceId));
    exportSelected(selected.filter((source) => !cold.has(source.sourceId)));
    for (const source of selected) {
      if (cold.has(source.sourceId) || source.bytes === 0) continue;
      if (!store.discard(owner, scope, source.locator)) throw ledgerStateFailure();
      source.locator = null;
      cold.add(source.sourceId);
    }
  });
  residencies.set(ledger, () => {
    clock();
    const stats = store.stats();
    return {
      residentBytes: stats.retainedBytes,
      residentEntries: stats.entries,
      coldEntries: cold.size,
    };
  });
  transfers.set(ledger, () => {
    clock();
    return exportSelected([...sources.values()]);
  });
  if (restoredState !== undefined) {
    try {
      const state = metadataOnly
        ? parseEvidenceLedgerMetadata(restoredState, owner, limits)
        : proof !== undefined
          ? parseOwnedEvidenceLedgerState(restoredState, owner, limits, proof)
          : parseEvidenceLedgerState(restoredState, owner, limits);
      currentTime = state.observedAt;
      clock();
      const restoredAt = currentTime;
      for (const source of state.sources) {
        if (source.expiresAt <= restoredAt) continue;
        // Recreate private artifact handles at their original creation time;
        // neither source TTL nor artifact hard expiry starts again on restore.
        currentTime = source.createdAt;
        const receipt =
          !metadataOnly && source.output.length ? store.put(owner, scope, source.output) : null;
        if (
          !metadataOnly &&
          source.output.length &&
          (!receipt || receipt.expiresAt !== source.expiresAt)
        )
          throw ledgerStateFailure();
        const { output: _output, ...metadata } = source;
        const entry = { ...metadata, locator: receipt?.locator ?? null };
        sources.set(entry.sourceId, entry);
        calls.set(entry.callId, entry);
        if (metadataOnly && source.bytes > 0) cold.add(entry.sourceId);
      }
      currentTime = restoredAt;
      capturedCount = state.capturedCount;
      readCount = state.readCount;
    } catch {
      close();
      throw ledgerStateFailure();
    }
  }
  return ledger;
}

function exportContextEvidenceLedger(ledger) {
  const transfer = transfers.get(ledger);
  if (!transfer) throw ledgerStateFailure();
  try {
    return transfer();
  } catch {
    throw ledgerStateFailure();
  }
}

// This is an owner-side persistence primitive, never a model-facing import.
// The caller must supply current trusted owner/thread and authenticate state.
function restoreContextEvidenceLedger(options, state) {
  if (state === undefined) throw ledgerStateFailure();
  try {
    return createLedger(options, state);
  } catch {
    throw ledgerStateFailure();
  }
}

// Same settings, semantics, clock and artifact reconstruction as the public
// restore; only privately owned full-root clones can reuse structural facts.
function restoreOwnedContextEvidenceLedger(options, state, proof) {
  if (state === undefined || proof === undefined) throw ledgerStateFailure();
  try {
    return createLedger(options, state, false, proof);
  } catch {
    throw ledgerStateFailure();
  }
}

// Owner-only observation import: arguments were validated when their call was
// observed. Persist their digest instead of retaining raw arguments to replay.
function captureObservedContextEvidence(ledger, input) {
  const capture = observedCaptures.get(ledger);
  if (!capture) throw refusal();
  return capture(input);
}

function readContextEvidenceStoredPage(ledger, args, maxResultBytes, fetchPage) {
  const read = asyncPageReads.get(ledger);
  if (!read) throw refusal();
  return read(args, maxResultBytes, fetchPage);
}

function exportContextEvidenceProgress(ledger) {
  const read = progressExports.get(ledger);
  if (!read) throw refusal();
  return read();
}

function exportContextEvidenceMetadata(ledger) {
  const read = metadataExports.get(ledger);
  if (!read) throw ledgerStateFailure();
  try {
    return read();
  } catch {
    throw ledgerStateFailure();
  }
}

function exportContextEvidencePayloads(ledger, sourceIds) {
  const read = payloadExports.get(ledger);
  if (!read) throw ledgerStateFailure();
  try {
    return read(sourceIds);
  } catch {
    throw ledgerStateFailure();
  }
}

function restoreContextEvidenceMetadata(options, state) {
  if (state === undefined) throw ledgerStateFailure();
  try {
    return createLedger(options, state, true);
  } catch {
    throw ledgerStateFailure();
  }
}
function evictContextEvidencePayloads(ledger, sourceIds) {
  const evict = evictions.get(ledger);
  if (!evict) throw ledgerStateFailure();
  try {
    return evict(sourceIds);
  } catch {
    throw ledgerStateFailure();
  }
}
function contextEvidenceResidency(ledger) {
  const inspect = residencies.get(ledger);
  if (!inspect) throw ledgerStateFailure();
  try {
    return inspect();
  } catch {
    throw ledgerStateFailure();
  }
}

module.exports = {
  createContextEvidenceLedger,
  exportContextEvidenceLedger,
  restoreContextEvidenceLedger,
  restoreOwnedContextEvidenceLedger,
  captureObservedContextEvidence,
  readContextEvidenceStoredPage,
  exportContextEvidenceProgress,
  exportContextEvidenceMetadata,
  exportContextEvidencePayloads,
  restoreContextEvidenceMetadata,
  evictContextEvidencePayloads,
  contextEvidenceResidency,
};
