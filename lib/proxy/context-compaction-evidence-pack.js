'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData, invalidCompaction } = require('./context-compaction-envelope');

const EVIDENCE_PACK_KIND = 'hpm.local_compaction_evidence_pack';
const MAX_EVIDENCE_ITEM_BYTES = 2 * 1024 * 1024;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Fixed-width JSON whitespace around numeric offsets keeps the header's exact
// byte length independent of the offsets it describes. No recursive offset
// estimation, content slicing, special-case samples or extra storage is needed.
function packPrefix(members, width) {
  const index = members.map(
    (member) =>
      '{"sourceIndex":' +
      member.sourceIndex +
      (member.type ? ',"type":' + JSON.stringify(member.type) : '') +
      (member.callId ? ',"callId":' + JSON.stringify(member.callId) : '') +
      ',"digest":' +
      JSON.stringify(member.digest) +
      ',"bytes":' +
      member.bytes +
      ',"offsetBytes":' +
      String(member.offsetBytes).padStart(width, ' ') +
      ',"endOffsetBytes":' +
      String(member.endOffsetBytes).padStart(width, ' ') +
      '}'
  );
  return (
    '{"kind":' +
    JSON.stringify(EVIDENCE_PACK_KIND) +
    ',"version":1,"index":[' +
    index.join(',') +
    '],"items":['
  );
}

function materialize(entries, width) {
  if (entries.length === 1) {
    const entry = entries[0];
    return {
      value: entry.item,
      members: [{ ...entry.member, offsetBytes: 0, endOffsetBytes: entry.member.bytes }],
      bytes: entry.member.bytes,
      packed: false,
    };
  }
  const members = entries.map((entry) => ({ ...entry.member, offsetBytes: 0, endOffsetBytes: 0 }));
  let offset = Buffer.byteLength(packPrefix(members, width));
  for (const member of members) {
    member.offsetBytes = offset;
    offset += member.bytes;
    member.endOffsetBytes = offset;
    offset += 1; // Comma between items, or the closing array delimiter.
  }
  const value = packPrefix(members, width) + entries.map((entry) => entry.text).join(',') + ']}';
  return { value, members, bytes: Buffer.byteLength(value), packed: true };
}

function packLocalCompactionEvidenceEntries(entries, maxArtifactBytes) {
  if (
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1 ||
    maxArtifactBytes > MAX_EVIDENCE_ITEM_BYTES
  )
    throw invalidCompaction('invalid_compaction_evidence');
  const source = normalizeCompactionData(entries, 4 * 1024 * 1024);
  if (!Array.isArray(source) || source.length > 2048)
    throw invalidCompaction('invalid_compaction_evidence');
  const width = String(maxArtifactBytes).length;
  const packs = [];
  let pending = [];
  let itemBytes = 0;
  let indexBytes = 0;
  let lastIndex = -1;
  for (const entry of source) {
    if (
      !entry ||
      Object.keys(entry).sort().join(',') !== 'index,item' ||
      !Number.isSafeInteger(entry.index) ||
      entry.index <= lastIndex ||
      entry.index > 2048 ||
      !entry.item ||
      typeof entry.item !== 'object' ||
      Array.isArray(entry.item)
    )
      throw invalidCompaction('invalid_compaction_evidence');
    lastIndex = entry.index;
    const text = JSON.stringify(entry.item);
    const bytes = Buffer.byteLength(text);
    if (bytes > maxArtifactBytes) throw invalidCompaction('compaction_evidence_unavailable');
    const callId = entry.item.call_id ?? entry.item.id;
    const member = {
      sourceIndex: entry.index,
      ...(typeof entry.item.type === 'string' && entry.item.type.length <= 128
        ? { type: entry.item.type }
        : {}),
      ...(typeof callId === 'string' && callId.length > 0 && callId.length <= 4096
        ? { callId }
        : {}),
      digest: digest(text),
      bytes,
    };
    const candidate = { item: entry.item, text, member };
    // The empty prefix plus each independent index entry accounts for every
    // delimiter. Exact serialized bytes, including escaped Unicode, govern
    // admission; the existing artifact/owner/session/global quotas still apply.
    const memberIndexBytes =
      Buffer.byteLength(packPrefix([{ ...member, offsetBytes: 0, endOffsetBytes: 0 }], width)) -
      Buffer.byteLength(packPrefix([], width));
    const count = pending.length + 1;
    const projected =
      Buffer.byteLength(packPrefix([], width)) +
      indexBytes +
      memberIndexBytes +
      itemBytes +
      bytes +
      2 * (count - 1) +
      2;
    if (pending.length && projected > maxArtifactBytes) {
      packs.push(materialize(pending, width));
      pending = [];
      itemBytes = 0;
      indexBytes = 0;
    }
    pending.push(candidate);
    itemBytes += bytes;
    indexBytes += memberIndexBytes;
  }
  if (pending.length) packs.push(materialize(pending, width));
  return packs;
}

module.exports = {
  EVIDENCE_PACK_KIND,
  MAX_EVIDENCE_ITEM_BYTES,
  packLocalCompactionEvidenceEntries,
};
