'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { createContextArtifactStore } = require('./context-artifact-store');
const { MAX_ARTIFACT_PAGE_BYTES, buildContextArtifactPage } = require('./context-artifact-page');
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
    ttlMs: integer(safe.ttlMs, 30 * 60 * 1000, 2 * 60 * 60 * 1000),
    maxEntries: integer(safe.maxEntries, 64, 256),
    maxOutputBytes: integer(safe.maxOutputBytes, 1024 * 1024, 2 * 1024 * 1024),
    maxBytes: integer(safe.maxBytes, 4 * 1024 * 1024, 8 * 1024 * 1024),
  };
}

// Client-owned tool data, not a native checkpoint or a policy/summary. The
// capability stays with one caller/thread and must never be shared across
// clients. Only the caller can capture a completed result; model-facing tools
// can only list/read. No executor, filesystem, transport or credential access.
function createContextEvidenceLedger(options) {
  const limits = settings(options);
  if (limits.maxBytes < limits.maxOutputBytes) throw refusal();
  const owner = sha(JSON.stringify([limits.owner, limits.threadId]));
  const scope = 'hcs_' + randomUUID().replace(/-/g, '');
  const sources = new Map();
  const calls = new Map();
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

  return {
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
      // Empty output is valid evidence. It needs no artifact reservation and
      // still consumes one index slot; no invented replacement text is stored.
      if (sources.size >= limits.maxEntries) throw refusal('evidence_ledger_quota');
      const receipt = source.output.length ? store.put(owner, scope, source.output) : null;
      if (source.output.length && !receipt) throw refusal('evidence_ledger_quota');
      const entry = {
        sourceId: 'hce_' + randomUUID().replace(/-/g, ''),
        callId: source.callId,
        toolName: source.toolName,
        argumentsDigest,
        digest,
        bytes: Buffer.byteLength(source.output),
        expiresAt: currentTime + limits.ttlMs,
        locator: receipt?.locator ?? null,
        coveredThrough: 0,
        readComplete: false,
      };
      sources.set(entry.sourceId, entry);
      calls.set(entry.callId, entry);
      capturedCount++;
      return descriptor(entry);
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
}

module.exports = { createContextEvidenceLedger };
