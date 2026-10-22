'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { serializedContentBytes } = require('./context-artifact-page');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const keys = (value) => value && !Array.isArray(value) && Object.keys(value).sort().join(',');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
function invalid() {
  return new TypeError('invalid_stored_evidence_page');
}
function data(input, maximum) {
  try {
    return normalizeCompactionData(input, maximum);
  } catch {
    throw invalid();
  }
}
function parseStoredEvidenceSource(input) {
  const value = data(input, 2048);
  if (
    keys(value) !== 'argumentsDigest,bytes,callId,digest,expiresAt,sourceId,toolName,trust' ||
    typeof value.sourceId !== 'string' ||
    !/^hce_[a-f0-9]{32}$/.test(value.sourceId) ||
    !identity(value.callId, 256) ||
    !identity(value.toolName, 128) ||
    !digest(value.argumentsDigest) ||
    !digest(value.digest) ||
    !integer(value.bytes) ||
    value.bytes > 2 * 1024 * 1024 ||
    !integer(value.expiresAt) ||
    value.expiresAt === 0 ||
    value.trust !== 'tool_data_not_instructions'
  )
    throw invalid();
  return value;
}
function parseStoredEvidencePage(input, expected, args, maximum = 65536) {
  if (!integer(maximum) || maximum > 65536) throw invalid();
  const value = data(input, 128 * 1024);
  if (value?.ok === false) {
    if (
      keys(value) !== 'error,ok' ||
      ![
        'context_artifact_invalid_range',
        'context_artifact_budget_exceeded',
        'context_evidence_unavailable',
      ].includes(value.error)
    )
      throw invalid();
    return value;
  }
  if (keys(value) !== 'ok,page,source' || value.ok !== true) throw invalid();
  const source = parseStoredEvidenceSource(value.source);
  if (expected && Object.keys(source).some((key) => source[key] !== expected[key])) throw invalid();
  const page = value.page;
  if (
    keys(page) !==
      'chunkDigest,digest,encoding,endOffsetBytes,nextOffsetBytes,offsetBytes,text,totalBytes' ||
    page.encoding !== 'utf8' ||
    typeof page.text !== 'string' ||
    Buffer.from(page.text).toString('utf8') !== page.text ||
    !integer(page.offsetBytes) ||
    !integer(page.endOffsetBytes) ||
    page.endOffsetBytes < page.offsetBytes ||
    page.endOffsetBytes > source.bytes ||
    page.totalBytes !== source.bytes ||
    page.digest !== source.digest ||
    page.chunkDigest !== hash(page.text) ||
    Buffer.byteLength(page.text) !== page.endOffsetBytes - page.offsetBytes ||
    (page.endOffsetBytes < source.bytes
      ? page.nextOffsetBytes !== page.endOffsetBytes || page.endOffsetBytes === page.offsetBytes
      : page.nextOffsetBytes !== null) ||
    (page.offsetBytes === 0 &&
      page.endOffsetBytes === source.bytes &&
      page.chunkDigest !== source.digest) ||
    (args &&
      (page.offsetBytes !== (args.offsetBytes ?? 0) ||
        Buffer.byteLength(page.text) > (args.limitBytes ?? 16384))) ||
    !integer(maximum) ||
    maximum > 65536 ||
    serializedContentBytes(value) > maximum
  )
    throw invalid();
  return value;
}

module.exports = { parseStoredEvidenceSource, parseStoredEvidencePage };
