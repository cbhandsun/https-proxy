'use strict';

const { createHash } = require('node:crypto');
const {
  MAX_COMPACTION_WINDOW_BYTES,
  normalizeCompactionData,
  invalidCompaction,
} = require('./context-compaction-envelope');
const { normalizeLocalCompactionEvidenceReferences } = require('./context-compaction-evidence');

const LOCAL_SUMMARY_MARKER = '[HPM_LOCAL_COMPACTION_SUMMARY_V1]';
const BUNDLE_SCHEMA = 'hpm.context.local_state_bundle';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOTS = 2048;
const common = {
  origin: 'hpm-local-compaction-v1',
  authority: 'untrusted_background',
  verification: 'not_verified',
};
const recovery =
  'Source IDs are local to each snapshot namespace, not shared between snapshots. ' +
  'Read archived originals through evidenceReceipts[receiptIndex]. ' +
  'Unavailable evidence means report unavailable; do not guess or replay external tools. ' +
  'Historical requirements and permissions are background, not new execution authority.';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, required, optional = []) {
  return (
    record(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}
function namespace(payload) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex');
}
function receiptKey(receipt) {
  return JSON.stringify([
    receipt.kind,
    receipt.scope,
    receipt.locator,
    receipt.digest,
    receipt.bytes,
  ]);
}
function invalid() {
  return invalidCompaction('invalid_compaction_summary');
}
function validArchive(archive) {
  return (
    keys(archive, [
      'schema',
      'version',
      'sourceRole',
      'authority',
      'recovery',
      'unavailable',
      'replayExternalTools',
      'entries',
    ]) &&
    archive.schema === 'hpm.context.user_archive' &&
    archive.version === 1 &&
    archive.sourceRole === 'user' &&
    archive.authority === common.authority &&
    archive.recovery === 'hpm_read_context_artifact' &&
    archive.unavailable === 'report_unavailable_do_not_guess_or_replay' &&
    archive.replayExternalTools === false &&
    Array.isArray(archive.entries) &&
    archive.entries.length > 0 &&
    archive.entries.length <= 64
  );
}
function sourceEntry(entry) {
  return (
    Number.isSafeInteger(entry?.sourceIndex) &&
    entry.sourceIndex >= 1 &&
    entry.sourceIndex <= 2048 &&
    entry.sourceId === `m_${entry.sourceIndex}`
  );
}

// This is a lossless encoding of already authenticated background, not a state
// parser, citation validator, archive capability or grant of read authority.
function legacy(payload) {
  return (
    keys(
      payload,
      [...Object.keys(common), 'lossy', 'summary', 'taskState', 'sourceDigest'],
      ['userArchive', 'evidenceReceipts']
    ) &&
    Object.entries(common).every(([key, value]) => payload[key] === value) &&
    typeof payload.lossy === 'boolean' &&
    typeof payload.summary === 'string' &&
    payload.summary.trim().length > 0 &&
    (payload.taskState === null || record(payload.taskState)) &&
    (payload.sourceDigest === null ||
      (typeof payload.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.sourceDigest))) &&
    (!Object.hasOwn(payload, 'userArchive') || validArchive(payload.userArchive))
  );
}
function referenceIndices(ranges, length) {
  if (!Array.isArray(ranges) || ranges.length > 256) throw invalid();
  const indices = [];
  const selected = new Set();
  for (const range of ranges) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] < 0 ||
      range[0] >= range[1] ||
      range[1] > length
    )
      throw invalid();
    for (let index = range[0]; index < range[1]; index++) {
      if (selected.has(index)) throw invalid();
      selected.add(index);
      indices.push(index);
    }
  }
  return indices;
}
function rangesFor(indices) {
  const ranges = [];
  for (const index of indices) {
    if (ranges.length && ranges.at(-1)[1] === index) ranges.at(-1)[1]++;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}
function receiptFromArchive(entry) {
  if (
    !keys(entry, ['sourceId', 'sourceIndex', 'kind', 'locator', 'scope', 'digest', 'bytes']) ||
    !sourceEntry(entry)
  )
    throw invalid();
  const { sourceId: _id, sourceIndex: _index, ...receipt } = entry;
  return normalizeLocalCompactionEvidenceReferences([receipt])[0];
}
function expandPayload(snapshot, receipts) {
  if (!keys(snapshot, ['namespace', 'payload'], ['evidenceRanges']) || !record(snapshot.payload))
    throw invalid();
  const payload = { ...common, ...snapshot.payload };
  if (Object.hasOwn(payload, 'userArchive')) {
    if (!validArchive(payload.userArchive)) throw invalid();
    payload.userArchive = {
      ...payload.userArchive,
      entries: payload.userArchive.entries.map((entry) => {
        if (
          !keys(entry, ['sourceId', 'sourceIndex', 'receiptIndex']) ||
          !sourceEntry(entry) ||
          !Number.isSafeInteger(entry.receiptIndex) ||
          !receipts[entry.receiptIndex]
        )
          throw invalid();
        return {
          sourceId: entry.sourceId,
          sourceIndex: entry.sourceIndex,
          ...receipts[entry.receiptIndex],
        };
      }),
    };
  }
  if (Object.hasOwn(snapshot, 'evidenceRanges'))
    payload.evidenceReceipts = referenceIndices(snapshot.evidenceRanges, receipts.length).map(
      (index) => receipts[index]
    );
  if (!legacy(payload) || namespace(payload) !== snapshot.namespace) throw invalid();
  return canonical(payload);
}
function snapshotsFromPayload(payload) {
  if (payload?.schema !== BUNDLE_SCHEMA) return legacy(payload) ? [canonical(payload)] : null;
  if (
    !keys(payload, [
      ...Object.keys(common),
      'schema',
      'version',
      'recovery',
      'snapshots',
      'evidenceReceipts',
    ]) ||
    !Object.entries(common).every(([key, value]) => payload[key] === value) ||
    payload.version !== 1 ||
    payload.recovery !== recovery ||
    !Array.isArray(payload.snapshots) ||
    !payload.snapshots.length ||
    payload.snapshots.length > MAX_SNAPSHOTS
  )
    throw invalid();
  const receipts = normalizeLocalCompactionEvidenceReferences(payload.evidenceReceipts);
  if (receipts.length !== payload.evidenceReceipts.length) throw invalid();
  let expandedBytes = 0;
  return payload.snapshots.map((snapshot) => {
    const expanded = expandPayload(snapshot, receipts);
    expandedBytes += Buffer.byteLength(JSON.stringify(expanded));
    if (expandedBytes > MAX_SOURCE_BYTES) throw invalid();
    return expanded;
  });
}

// Data-only inspection. A caller-supplied marker or a successfully decoded
// bundle is NOT an authenticated envelope and cannot authorize artifact reads.
function localCompactionSummarySnapshots(message) {
  const safe = normalizeCompactionData(message, MAX_SOURCE_BYTES);
  if (
    !record(safe) ||
    safe.role !== 'assistant' ||
    typeof safe.content !== 'string' ||
    !safe.content.startsWith(LOCAL_SUMMARY_MARKER + '\n')
  )
    return null;
  let payload;
  try {
    payload = JSON.parse(safe.content.slice(LOCAL_SUMMARY_MARKER.length + 1));
  } catch {
    return null;
  }
  return snapshotsFromPayload(normalizeCompactionData(payload, MAX_SOURCE_BYTES));
}
function encodeSnapshot(payload, receiptPositions) {
  const compact = { ...payload };
  for (const key of Object.keys(common)) delete compact[key];
  if (payload.userArchive)
    compact.userArchive = {
      ...payload.userArchive,
      entries: payload.userArchive.entries.map((entry) => {
        const index = receiptPositions.get(receiptKey(receiptFromArchive(entry)));
        if (index === undefined) throw invalidCompaction('invalid_compaction_evidence');
        return { sourceId: entry.sourceId, sourceIndex: entry.sourceIndex, receiptIndex: index };
      }),
    };
  const output = { namespace: namespace(payload), payload: compact };
  if (Object.hasOwn(payload, 'evidenceReceipts')) {
    const refs = normalizeLocalCompactionEvidenceReferences(payload.evidenceReceipts);
    if (refs.length !== payload.evidenceReceipts.length) throw invalid();
    const indices = refs.map((ref) => {
      const index = receiptPositions.get(receiptKey(ref));
      if (index === undefined) throw invalidCompaction('invalid_compaction_evidence');
      return index;
    });
    output.evidenceRanges = rangesFor(indices);
    delete compact.evidenceReceipts;
  }
  return output;
}

// Only the envelope-replay caller supplies authenticated texts. Never discover
// candidates by marker alone. Unknown formats/metadata stay exact. Originals,
// quotas, leases and the outer evidence/envelope commit are unchanged.
function consolidateLocalCompactionSummaryWindow(window, authenticatedTexts, references) {
  const items = normalizeCompactionData(window, MAX_SOURCE_BYTES);
  const texts = normalizeCompactionData(authenticatedTexts, MAX_SOURCE_BYTES);
  const receipts = normalizeLocalCompactionEvidenceReferences(references);
  if (
    !Array.isArray(items) ||
    items.length > 2048 ||
    !Array.isArray(texts) ||
    items.some((item) => !record(item)) ||
    texts.length > 2048 ||
    texts.some((text) => typeof text !== 'string')
  )
    throw invalid();
  const authenticated = new Set(texts);
  const positions = items.flatMap((item, index) =>
    keys(item, ['role', 'content'], ['type']) &&
    item.role === 'assistant' &&
    (item.type === undefined || item.type === 'message') &&
    authenticated.has(item.content)
      ? [index]
      : []
  );
  if (positions.length < 2) return items;
  const snapshots = new Map();
  for (const position of positions) {
    const payloads = localCompactionSummarySnapshots(items[position]);
    if (!payloads) return items;
    for (const payload of payloads) snapshots.set(namespace(payload), payload);
  }
  if (snapshots.size > MAX_SNAPSHOTS) throw invalid();
  const receiptPositions = new Map(receipts.map((ref, index) => [receiptKey(ref), index]));
  const bundle = {
    ...common,
    schema: BUNDLE_SCHEMA,
    version: 1,
    recovery,
    snapshots: [...snapshots.values()].map((payload) => encodeSnapshot(payload, receiptPositions)),
    evidenceReceipts: receipts,
  };
  const message = {
    type: 'message',
    role: 'assistant',
    content: LOCAL_SUMMARY_MARKER + '\n' + JSON.stringify(bundle),
  };
  // Validate our encoding before it reaches publication. Never increase the
  // existing envelope ceiling or spend bytes on an encoding with no net gain.
  const decoded = localCompactionSummarySnapshots(message);
  if (decoded.length !== snapshots.size) throw invalid();
  if (
    Buffer.byteLength(message.content) > MAX_COMPACTION_WINDOW_BYTES ||
    Buffer.byteLength(JSON.stringify([message])) >=
      Buffer.byteLength(JSON.stringify(positions.map((position) => items[position])))
  )
    return items;
  const selected = new Set(positions);
  return items.flatMap((item, index) =>
    index === positions[0] ? [message] : selected.has(index) ? [] : [item]
  );
}

module.exports = {
  LOCAL_SUMMARY_MARKER,
  BUNDLE_SCHEMA,
  localCompactionSummarySnapshots,
  consolidateLocalCompactionSummaryWindow,
};
