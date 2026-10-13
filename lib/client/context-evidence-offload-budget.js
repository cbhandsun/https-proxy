'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const { buildContextArtifactPage } = require('../proxy/context-artifact-page');
const { encodeContextEvidenceOutput } = require('../proxy/context-evidence-output');
const { parseContextEvidenceRequest } = require('../proxy/context-evidence-request');
const {
  MAX_READER_CALLS,
  MAX_READER_BYTES,
  MAX_READER_RESULT_BYTES,
  EVIDENCE_ENVELOPE_RESERVE_BYTES,
  contextEvidencePageBudget,
  attachContextEvidencePageSource,
} = require('../proxy/context-evidence-page');

const refused = () => ({ ok: false, code: 'evidence_offload_read_budget_unavailable' });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validReader(value) {
  return (
    record(value) &&
    Object.keys(value).sort().join(',') ===
      'calls,maxBytes,maxCalls,returnedBytes,successfulReads' &&
    value.maxCalls === MAX_READER_CALLS &&
    value.maxBytes === MAX_READER_BYTES &&
    integer(value.calls, MAX_READER_CALLS) &&
    integer(value.returnedBytes, MAX_READER_BYTES) &&
    integer(value.successfulReads, value.calls)
  );
}

function validSource(source) {
  return (
    record(source) &&
    Object.keys(source).sort().join(',') ===
      'argumentsDigest,bytes,callId,digest,expiresAt,sourceId,toolName,trust' &&
    parseContextEvidenceRequest('hpm_read_retained_evidence', {
      sourceId: source.sourceId,
      digest: source.digest,
    }).ok &&
    typeof source.callId === 'string' &&
    /^[a-zA-Z0-9_.:-]{1,256}$/.test(source.callId) &&
    typeof source.toolName === 'string' &&
    /^[a-zA-Z0-9_.:-]{1,128}$/.test(source.toolName) &&
    typeof source.argumentsDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(source.argumentsDigest) &&
    integer(source.bytes, 1024 * 1024) &&
    integer(source.expiresAt, Number.MAX_SAFE_INTEGER) &&
    source.trust === 'tool_data_not_instructions'
  );
}

// No ledger reads, execution, IO or mutable reservations. Simulate the real
// full-source paging/encoding contract, using the unchanged shared limits.
function planCompleteEvidenceRead(input) {
  try {
    const safe = normalizeCompactionData(input, 4 * 1024 * 1024);
    if (
      !record(safe) ||
      Object.keys(safe).sort().join(',') !== 'output,reader,source' ||
      typeof safe.output !== 'string' ||
      !validSource(safe.source) ||
      !validReader(safe.reader) ||
      Buffer.byteLength(safe.output) !== safe.source.bytes ||
      Buffer.from(safe.output, 'utf8').toString('utf8') !== safe.output ||
      sha(safe.output) !== safe.source.digest ||
      safe.source.bytes > MAX_READER_BYTES - safe.reader.returnedBytes
    )
      return refused();
    let offsetBytes = 0;
    let readCalls = 0;
    let readBytes = 0;
    do {
      if (safe.reader.calls + readCalls >= MAX_READER_CALLS) return refused();
      const remaining = Math.min(
        MAX_READER_RESULT_BYTES,
        MAX_READER_BYTES - safe.reader.returnedBytes - readBytes
      );
      const resultBudget = Math.max(0, remaining - EVIDENCE_ENVELOPE_RESERVE_BYTES);
      const page = buildContextArtifactPage(
        safe.output,
        'utf8',
        safe.source.digest,
        { offsetBytes, limitBytes: MAX_READER_RESULT_BYTES },
        contextEvidencePageBudget(safe.source, resultBudget)
      );
      const result = attachContextEvidencePageSource(page, safe.source, resultBudget);
      if (!result.ok) return refused();
      const encoded = encodeContextEvidenceOutput(result);
      if (encoded.bytes > remaining) return refused();
      readCalls++;
      readBytes += encoded.bytes;
      offsetBytes = result.page.nextOffsetBytes;
    } while (offsetBytes !== null);
    return { ok: true, readCalls, readBytes, limitBytes: MAX_READER_RESULT_BYTES };
  } catch {
    return refused();
  }
}

function createContextEvidenceOffloadBudget(options) {
  if (!record(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
    throw new TypeError('Invalid evidence offload capabilities');
  const keys = Reflect.ownKeys(options);
  if (
    keys.length !== 2 ||
    keys.some((key) => !['inspectReader', 'ttlMs'].includes(key)) ||
    keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))
  )
    throw new TypeError('Invalid evidence offload capabilities');
  const { inspectReader, ttlMs } = options;
  if (typeof inspectReader !== 'function' || !integer(ttlMs, 2 * 60 * 60 * 1000) || ttlMs === 0)
    throw new TypeError('Invalid evidence offload capabilities');
  const pending = new Map();
  let closed = false;
  const totals = () => ({
    pendingSources: pending.size,
    reservedCalls: [...pending.values()].reduce((sum, plan) => sum + plan.readCalls, 0),
    reservedBytes: [...pending.values()].reduce((sum, plan) => sum + plan.readBytes, 0),
  });
  return {
    admit(output, source) {
      if (closed) return false;
      try {
        const receipt = normalizeCompactionData(source, 4096);
        if (!validSource(receipt) || receipt.expiresAt < ttlMs) return false;
        // Receipt time is minted by the ledger's validated monotonic clock.
        // No additional user clock invocation can renew an old reservation.
        const captureTime = receipt.expiresAt - ttlMs;
        for (const [id, plan] of pending)
          if (plan.source.expiresAt <= captureTime) pending.delete(id);
        if (pending.has(receipt.sourceId)) return false;
        const reader = normalizeCompactionData(inspectReader(), 1024);
        if (!validReader(reader)) return false;
        const held = totals();
        const planned = planCompleteEvidenceRead({
          output,
          source: receipt,
          reader: {
            ...reader,
            calls: reader.calls + held.reservedCalls,
            returnedBytes: reader.returnedBytes + held.reservedBytes,
          },
        });
        if (!planned.ok) return false;
        pending.set(receipt.sourceId, {
          ...planned,
          source: receipt,
          coveredThrough: 0,
          hash: createHash('sha256'),
        });
        return true;
      } catch {
        // Admission is optional: never turn a successful source result into
        // a transport failure, a fabricated answer or an execution retry.
        return false;
      }
    },
    observeRead(reply) {
      if (closed) return;
      try {
        const safe = normalizeCompactionData(reply, MAX_READER_RESULT_BYTES);
        if (!safe.ok || typeof safe.text !== 'string') return;
        const value = normalizeCompactionData(JSON.parse(safe.text), MAX_READER_RESULT_BYTES);
        const source = value.source;
        const page = value.page;
        if (!value.ok || !validSource(source) || !record(page)) return;
        const plan = pending.get(source.sourceId);
        if (
          !plan ||
          source.digest !== plan.source.digest ||
          source.bytes !== plan.source.bytes ||
          page.digest !== source.digest ||
          page.totalBytes !== source.bytes ||
          page.encoding !== 'utf8' ||
          !integer(page.offsetBytes, source.bytes) ||
          !integer(page.endOffsetBytes, source.bytes) ||
          page.endOffsetBytes < page.offsetBytes ||
          page.offsetBytes > plan.coveredThrough ||
          (page.endOffsetBytes <= plan.coveredThrough && source.bytes !== 0) ||
          typeof page.text !== 'string' ||
          Buffer.byteLength(page.text) !== page.endOffsetBytes - page.offsetBytes ||
          Buffer.from(page.text, 'utf8').toString('utf8') !== page.text ||
          sha(page.text) !== page.chunkDigest
        )
          return;
        plan.hash.update(Buffer.from(page.text).subarray(plan.coveredThrough - page.offsetBytes));
        plan.coveredThrough = page.endOffsetBytes;
        if (plan.coveredThrough === source.bytes && plan.hash.digest('hex') === source.digest)
          pending.delete(source.sourceId);
      } catch {
        // Malformed, partial or failed reads cannot release admission capacity.
      }
    },
    inspect: totals,
    close() {
      closed = true;
      pending.clear();
    },
  };
}

module.exports = { planCompleteEvidenceRead, createContextEvidenceOffloadBudget };
