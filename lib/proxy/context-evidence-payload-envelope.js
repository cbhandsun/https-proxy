'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024;
const LEDGER_FIELDS = 'capturedCount,kind,observedAt,ownerBinding,policy,readCount,sources,version';
const SOURCE_FIELDS =
  'argumentsDigest,bytes,callId,coveredThrough,createdAt,digest,expiresAt,output,readComplete,sourceId,toolName';

function invalid() {
  return new TypeError('invalid_evidence_payload_envelope');
}

function record(input, fields) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const slots = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(slots);
  if (names.some((name) => typeof name !== 'string') || names.sort().join(',') !== fields)
    throw invalid();
  const result = Object.create(null);
  for (const name of names) {
    const slot = slots[name];
    if (!slot.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
    result[name] = slot.value;
  }
  return result;
}

// Count JSON escaping without constructing another copy of the original. A
// round trip also rejects lone surrogates, as the retained UTF-8 contract does.
function outputBytes(output, maximum) {
  if (typeof output !== 'string') throw invalid();
  const raw = Buffer.byteLength(output);
  if (raw > maximum || !isWellFormedEvidenceText(output)) throw invalid();
  let encoded = raw + 2;
  // UTF-8 validity was checked above. Native scanning avoids walking ordinary
  // text one JavaScript character at a time just to find no escaping at all.
  if (/["\\\p{Cc}]/u.test(output))
    for (let index = 0; index < output.length; index++) {
      const unit = output.charCodeAt(index);
      if (unit === 34 || unit === 92) encoded++;
      else if (unit < 32) encoded += [8, 9, 10, 12, 13].includes(unit) ? 1 : 5;
    }
  return encoded;
}

function sourceList(
  input,
  fields,
  maximum,
  count,
  initialBytes,
  envelopeBytes = MAX_ENVELOPE_BYTES
) {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 512 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 2 * 1024 * 1024 ||
    ![MAX_ENVELOPE_BYTES, 112 * 1024 * 1024].includes(envelopeBytes)
  )
    throw invalid();
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length > count ||
    Reflect.ownKeys(input).length !== length + 1
  )
    throw invalid();
  let bytes = initialBytes;
  const sizes = new Map();
  let cachedBytes = 0;
  const result = [];
  for (let index = 0; index < length; index++) {
    const slot = Object.getOwnPropertyDescriptor(input, String(index));
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
    const { output, ...metadata } = record(slot.value, fields);
    // Source metadata has only scalar fields. Reject nesting before calling a
    // general normalizer, keeping the whole envelope below its node/depth caps.
    if (Object.values(metadata).some((value) => value !== null && typeof value === 'object'))
      throw invalid();
    const safe = normalizeCompactionData(metadata, 8192);
    let encoded = sizes.get(output);
    if (encoded === undefined) {
      encoded = outputBytes(output, maximum);
      const raw = Buffer.byteLength(output);
      if (sizes.size < 128 && cachedBytes + raw <= 4 * 1024 * 1024) {
        sizes.set(output, encoded);
        cachedBytes += raw;
      }
    }
    bytes +=
      Buffer.byteLength(JSON.stringify(safe)) +
      Buffer.byteLength(',"output":') +
      encoded +
      (index ? 1 : 0);
    if (bytes > envelopeBytes) throw invalid();
    safe.output = output;
    result.push(safe);
  }
  return result;
}

// Only the byte/shape boundary lives here. Owner, hashes, timestamps, policy,
// duplicate identities and contiguous read progress remain checked by callers.
// Preserve the existing 12 MiB ceiling; larger budgets need a versioned policy.
function normalizeEvidenceLedgerEnvelope(
  input,
  maximum,
  count,
  envelopeBytes = MAX_ENVELOPE_BYTES
) {
  const { sources, ...metadata } = record(input, LEDGER_FIELDS);
  const safe = normalizeCompactionData(metadata, 256 * 1024);
  safe.sources = [];
  safe.sources = sourceList(
    sources,
    SOURCE_FIELDS,
    maximum,
    count,
    Buffer.byteLength(JSON.stringify(safe)),
    envelopeBytes
  );
  return safe;
}

function normalizeEvidencePayloadEnvelope(input, envelopeBytes = MAX_ENVELOPE_BYTES) {
  return sourceList(input, 'output,sourceId', 2 * 1024 * 1024, 512, 2, envelopeBytes);
}

module.exports = { normalizeEvidenceLedgerEnvelope, normalizeEvidencePayloadEnvelope };
