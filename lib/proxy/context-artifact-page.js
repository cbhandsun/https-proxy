'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_ARTIFACT_PAGE_BYTES = 16 * 1024;
const MAX_ARTIFACT_PAGE_BYTES = 64 * 1024;

function validRange(range) {
  return (
    range &&
    typeof range === 'object' &&
    !Array.isArray(range) &&
    Object.keys(range).every((key) => ['offsetBytes', 'limitBytes'].includes(key)) &&
    (range.offsetBytes === undefined ||
      (Number.isSafeInteger(range.offsetBytes) && range.offsetBytes >= 0)) &&
    (range.limitBytes === undefined ||
      (Number.isSafeInteger(range.limitBytes) &&
        range.limitBytes > 0 &&
        range.limitBytes <= MAX_ARTIFACT_PAGE_BYTES))
  );
}

function serializedContentBytes(value) {
  // Tool content is JSON encoded twice: envelope -> string -> request value.
  return Buffer.byteLength(JSON.stringify(JSON.stringify(value)));
}

function utf8Boundary(bytes, offset) {
  return offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function buildContextArtifactPage(
  payload,
  encoding,
  digest,
  range = {},
  maxResultBytes = MAX_ARTIFACT_PAGE_BYTES
) {
  if (
    typeof payload !== 'string' ||
    !['utf8', 'json'].includes(encoding) ||
    typeof digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    !validRange(range) ||
    !Number.isSafeInteger(maxResultBytes) ||
    maxResultBytes < 0 ||
    maxResultBytes > MAX_ARTIFACT_PAGE_BYTES
  ) {
    return { ok: false, error: 'context_artifact_invalid_range' };
  }
  const bytes = Buffer.from(payload, 'utf8');
  const start = range.offsetBytes ?? 0;
  if (start > bytes.length || !utf8Boundary(bytes, start)) {
    return { ok: false, error: 'context_artifact_invalid_range' };
  }
  const envelope = (end) => {
    const chunk = bytes.subarray(start, end);
    return {
      ok: true,
      page: {
        encoding,
        text: chunk.toString('utf8'),
        offsetBytes: start,
        endOffsetBytes: end,
        totalBytes: bytes.length,
        nextOffsetBytes: end < bytes.length ? end : null,
        digest,
        chunkDigest: createHash('sha256').update(chunk).digest('hex'),
      },
    };
  };
  let low = start;
  let high = Math.min(bytes.length, start + (range.limitBytes ?? DEFAULT_ARTIFACT_PAGE_BYTES));
  let selected = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let end = middle;
    while (end > start && !utf8Boundary(bytes, end)) end -= 1;
    const candidate = envelope(end);
    if (serializedContentBytes(candidate) <= maxResultBytes) {
      selected = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!selected || (start < bytes.length && selected.page.endOffsetBytes === start)) {
    return { ok: false, error: 'context_artifact_budget_exceeded' };
  }
  return selected;
}

module.exports = {
  DEFAULT_ARTIFACT_PAGE_BYTES,
  MAX_ARTIFACT_PAGE_BYTES,
  buildContextArtifactPage,
  serializedContentBytes,
  validRange,
};
