'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  normalizeCompactionData,
  invalidCompaction,
  validateLocalCompactionBinding,
} = require('./context-compaction-envelope');
const { estimateTokensForValue } = require('./inline-media');
const { packLocalCompactionEvidenceEntries } = require('./context-compaction-evidence-pack');

const MAX_REFERENCES = 256;
const EVIDENCE_MARKER = '[HPM_LOCAL_COMPACTION_EVIDENCE_V1]';
const SCOPE_PATTERN = /^hcs_[a-f0-9]{32}$/;

function localCompactionEvidenceOwner(binding) {
  validateLocalCompactionBinding(binding);
  return createHash('sha256')
    .update(JSON.stringify([binding.owner, binding.provider, binding.model, binding.endpoint]))
    .digest('hex');
}

function normalizeLocalCompactionEvidenceReferences(value = []) {
  const refs = normalizeCompactionData(value, 128 * 1024);
  if (!Array.isArray(refs) || refs.length > MAX_REFERENCES)
    throw invalidCompaction('invalid_compaction_evidence');
  const selected = new Map();
  for (const ref of refs) {
    if (
      !ref ||
      Array.isArray(ref) ||
      Object.keys(ref).sort().join(',') !== 'bytes,digest,kind,locator,scope' ||
      ref.kind !== 'local_compaction_evidence' ||
      typeof ref.locator !== 'string' ||
      !/^hca_[a-f0-9]{32}$/.test(ref.locator) ||
      typeof ref.scope !== 'string' ||
      !SCOPE_PATTERN.test(ref.scope) ||
      typeof ref.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.digest) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > 2 * 1024 * 1024
    )
      throw invalidCompaction('invalid_compaction_evidence');
    const key = ref.scope + ':' + ref.locator;
    if (
      selected.has(key) &&
      (selected.get(key).digest !== ref.digest || selected.get(key).bytes !== ref.bytes)
    )
      throw invalidCompaction('invalid_compaction_evidence');
    selected.set(key, { ...ref });
  }
  return [...selected.values()];
}

// Only removed, completed exchange groups enter here. Policy, user, media and
// unresolved state never become offload candidates. The entire original item,
// including unknown fields, is stored; the model sees an inert bounded preview.
function createLocalCompactionEvidence(groups, binding, store, limits, inherited = []) {
  const owner = localCompactionEvidenceOwner(binding);
  const refs = normalizeLocalCompactionEvidenceReferences(inherited);
  const source = normalizeCompactionData(groups, 4 * 1024 * 1024);
  limits = normalizeCompactionData(limits, 4096);
  if (
    !Array.isArray(source) ||
    source.length > 2048 ||
    !limits ||
    !Number.isSafeInteger(limits.maxRequestBytes) ||
    limits.maxRequestBytes < 1 ||
    !Number.isSafeInteger(limits.maxInputTokens) ||
    limits.maxInputTokens < 1
  )
    throw invalidCompaction('invalid_compaction_evidence');
  const byteThreshold = Math.max(512, Math.floor(limits.maxRequestBytes / 8));
  const tokenThreshold = Math.max(128, Math.floor(limits.maxInputTokens / 8));
  const scope = 'hcs_' + randomUUID().replace(/-/g, '');
  let transaction;
  let committed = false;
  const staged = [];
  let references;
  let lastIndex = -1;
  const candidates = [];
  try {
    for (const group of source) {
      if (!Array.isArray(group) || !group.length)
        throw invalidCompaction('invalid_compaction_evidence');
      for (const entry of group) {
        if (
          !entry ||
          Object.keys(entry).sort().join(',') !== 'index,item' ||
          !Number.isSafeInteger(entry.index) ||
          entry.index <= lastIndex ||
          entry.index > 2048 ||
          !entry.item ||
          Array.isArray(entry.item) ||
          typeof entry.item !== 'object'
        )
          throw invalidCompaction('invalid_compaction_evidence');
        lastIndex = entry.index;
        const item = entry.item;
        // A role-bearing/provider-specific item is not silently reclassified.
        const field =
          item.role != null
            ? null
            : ['function_call', 'tool_call', 'call', 'custom_tool_call'].includes(item.type)
              ? item.type === 'custom_tool_call'
                ? 'input'
                : 'arguments'
              : ['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(
                    item.type
                  )
                ? ['output', 'output_text', 'content'].find((key) => item[key] != null)
                : null;
        if (!field || item[field] == null || !store || containsMedia(item[field])) continue;
        if (
          Buffer.byteLength(JSON.stringify(item[field])) <= byteThreshold &&
          estimateTokensForValue(item[field]) <= tokenThreshold
        )
          continue;
        if (
          typeof (item.call_id ?? item.id) !== 'string' ||
          !(item.call_id ?? item.id) ||
          (item.call_id ?? item.id).length > 4096 ||
          typeof store.beginTransaction !== 'function'
        )
          throw invalidCompaction('compaction_evidence_unavailable');
        candidates.push({ entry, field });
      }
    }
    if (candidates.length) {
      // The store's configured artifact ceiling may be lower than production's
      // two-MiB cap. Packing never raises that ceiling or any shared quota.
      const maximum = store.stats?.().maxArtifactBytes;
      if (!Number.isSafeInteger(maximum) || maximum < 1)
        throw invalidCompaction('compaction_evidence_unavailable');
      const packs = packLocalCompactionEvidenceEntries(
        candidates.map(({ entry }) => entry),
        Math.min(maximum, 2 * 1024 * 1024)
      );
      transaction = store.beginTransaction(owner, scope);
      if (!transaction || refs.length + packs.length > MAX_REFERENCES)
        throw invalidCompaction('compaction_evidence_unavailable');
      const byIndex = new Map(candidates.map((candidate) => [candidate.entry.index, candidate]));
      for (const pack of packs) {
        const receipt = transaction.put(owner, scope, pack.value);
        if (!receipt) throw invalidCompaction('compaction_evidence_unavailable');
        staged.push({
          kind: 'local_compaction_evidence',
          locator: receipt.locator,
          digest: receipt.digest,
          bytes: receipt.bytes,
          scope,
        });
        // No random locator enters the summarization request/cache key. Identical
        // source snapshots retain single-flight identity, while publication gets
        // its own exact authenticated index of recoverable evidence.
        for (const member of pack.members) {
          const { entry, field } = byIndex.get(member.sourceIndex);
          const item = entry.item;
          entry.item = {
            ...item,
            [field]:
              EVIDENCE_MARKER +
              '\n' +
              JSON.stringify({
                digest: receipt.digest,
                bytes: receipt.bytes,
                ...(pack.packed
                  ? {
                      member: {
                        sourceIndex: member.sourceIndex,
                        digest: member.digest,
                        bytes: member.bytes,
                        offsetBytes: member.offsetBytes,
                        endOffsetBytes: member.endOffsetBytes,
                      },
                    }
                  : {}),
                preview: (typeof item[field] === 'string'
                  ? item[field]
                  : JSON.stringify(item[field])
                ).slice(0, 256),
                recovery:
                  'Use the authenticated evidenceReceipts index; never infer omitted content or rerun a side-effecting tool.',
              }),
          };
        }
      }
    }
    references = normalizeLocalCompactionEvidenceReferences([...refs, ...staged]);
  } catch (error) {
    transaction?.rollback();
    throw error;
  }
  return {
    groups: source,
    references,
    commit() {
      if (committed) return true;
      if (transaction && transaction.commit(staged).ok !== true)
        throw invalidCompaction('compaction_evidence_unavailable');
      committed = true;
      return true;
    },
    rollback() {
      return transaction?.rollback() ?? false;
    },
    discard() {
      if (!committed) return transaction?.rollback() ?? false;
      for (const ref of staged) store.discard(owner, ref.scope, ref.locator);
      return true;
    },
  };
}

// Caller supplies receipts only from an authenticated envelope. The private
// storage owner includes provider/model/endpoint, not merely the user profile.
// Existing request-local artifacts keep their original owner/scope semantics.
function createLocalCompactionEvidenceReader(store, binding, references = []) {
  const owner = localCompactionEvidenceOwner(binding);
  const expectedOwner = binding.owner;
  const refs = normalizeLocalCompactionEvidenceReferences(references);
  const keys = new Set(refs.map((ref) => JSON.stringify([ref.scope, ref.locator, ref.digest])));
  return {
    readPage(candidateOwner, scope, locator, digest, range, maxResultBytes) {
      if (
        candidateOwner !== expectedOwner ||
        typeof scope !== 'string' ||
        !SCOPE_PATTERN.test(scope) ||
        typeof locator !== 'string' ||
        !/^hca_[a-f0-9]{32}$/.test(locator) ||
        typeof digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        return { ok: false, error: 'context_artifact_unavailable' };
      try {
        range = normalizedRange(range);
      } catch {
        return { ok: false, error: 'context_artifact_invalid_range' };
      }
      const identity = JSON.stringify([scope, locator, digest]);
      return store.readPage(
        keys.has(identity) ? owner : candidateOwner,
        scope,
        locator,
        digest,
        range,
        maxResultBytes
      );
    },
  };
}

function containsMedia(value) {
  if (!value || typeof value !== 'object') return false;
  if (
    [
      'image',
      'input_image',
      'image_url',
      'input_file',
      'file',
      'audio',
      'input_audio',
      'video',
    ].includes(value.type) ||
    Object.hasOwn(value, 'encrypted_content')
  )
    return true;
  return Object.values(value).some(containsMedia);
}

function normalizedRange(value) {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalidCompaction();
  const range = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !['offsetBytes', 'limitBytes'].includes(key) ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw invalidCompaction();
    // Internal continuation passes optional fields explicitly as undefined.
    // Omit only those two optional values, never arbitrary unknown properties.
    if (descriptor.value !== undefined) range[key] = descriptor.value;
  }
  return normalizeCompactionData(range, 4096);
}

module.exports = {
  EVIDENCE_MARKER,
  MAX_REFERENCES,
  localCompactionEvidenceOwner,
  normalizeLocalCompactionEvidenceReferences,
  createLocalCompactionEvidence,
  createLocalCompactionEvidenceReader,
};
