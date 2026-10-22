'use strict';

const {
  RECOVERY_STATE_BYTES,
  cloneRecoveryStateData,
} = require('./context-recovery-state-encoder');
const { normalizeEvidenceLedgerEnvelope } = require('./context-evidence-payload-envelope');
const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

const LEDGER_FIELDS = 'capturedCount,kind,observedAt,ownerBinding,policy,readCount,sources,version';
const SOURCE_FIELDS =
  'argumentsDigest,bytes,callId,coveredThrough,createdAt,digest,expiresAt,output,readComplete,sourceId,toolName';
const admissions = new WeakMap();
function invalid() {
  return new TypeError('invalid_evidence_payload_envelope');
}

// This is provenance of one bounded clone, never owner authentication. No
// caller can register its own facts or transfer a token to another ledger.
function admitRecoveryRoot(input, maximum = RECOVERY_STATE_BYTES) {
  const facts = new WeakMap();
  const state = cloneRecoveryStateData(input, maximum, facts);
  if (!state || typeof state !== 'object' || ![9, 10].includes(state.version)) throw invalid();
  const proof = Object.freeze(Object.create(null));
  admissions.set(proof, { state, facts });
  return { state, proof };
}

function record(input, fields, facts) {
  if (
    !input ||
    !facts.has(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw invalid();
  const names = Object.keys(input).sort();
  if (names.join(',') !== fields) throw invalid();
  return names;
}

// A projection has different key order and budgets than its containing root.
// Recompute those prefixes from immutable facts; retaining root admission alone
// would incorrectly expand metadata's independent depth/node/raw/JSON limits.
function project(input, names, maximum, facts) {
  const result = Object.create(null);
  let bytes = 2,
    raw = 0,
    nodes = 1,
    required = 1 + names.length,
    depth = 0;
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const value = input[name];
    const object = value !== null && typeof value === 'object';
    const child = object ? facts.get(value) : null;
    if (object && !child) throw invalid();
    const childBytes = child ? child[0] : Buffer.byteLength(JSON.stringify(value));
    const childRaw = child ? child[1] : typeof value === 'string' ? Buffer.byteLength(value) : 0;
    required = Math.max(required, nodes + (child ? child[3] : 1));
    nodes += child ? child[2] : 1;
    depth = Math.max(depth, (child ? child[4] : 0) + 1);
    bytes += (index ? 1 : 0) + Buffer.byteLength(JSON.stringify(name)) + 1 + childBytes;
    raw += Buffer.byteLength(name) + childRaw;
    result[name] = value;
  }
  if (depth > 64 || required > 65536 || raw > maximum || bytes > maximum) throw invalid();
  return { result, bytes };
}

function normalizeOwnedRecoveryLedger(input, proof, limits) {
  const owned = admissions.get(proof);
  if (!owned || input !== owned.state.ledger) throw invalid();
  const maximum = limits.maxOutputBytes;
  const count = limits.maxEntries;
  const envelopeBytes = limits.maxBytes > 8 * 1024 * 1024 ? RECOVERY_STATE_BYTES : 12 * 1024 * 1024;
  // Original metadata serialization can observe global toJSON hooks through
  // its freshly created sources array. Preserve that fallback's behavior.
  if (
    Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
    Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON') ||
    Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
  )
    return normalizeEvidenceLedgerEnvelope(input, maximum, count, envelopeBytes);
  const { facts } = owned;
  const names = record(input, LEDGER_FIELDS, facts);
  const metadata = project(
    input,
    names.filter((name) => name !== 'sources'),
    256 * 1024,
    facts
  );
  const safe = metadata.result;
  safe.sources = [];
  const sources = input.sources;
  if (
    !Array.isArray(sources) ||
    !facts.has(sources) ||
    Object.getPrototypeOf(sources) !== Array.prototype ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 512 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 2 * 1024 * 1024 ||
    sources.length > count
  )
    throw invalid();
  // The original source list checks its encoded ceiling after each source;
  // do not change its intentionally distinct zero-source behavior.
  let bytes = metadata.bytes + Buffer.byteLength(',"sources":[]');
  // Match the original envelope's invocation-local successful-text cache.
  // Raw admission remains per source; facts already hold exact encoded sizes.
  const verified = new Set();
  let cachedBytes = 0;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const sourceNames = record(source, SOURCE_FIELDS, facts);
    const metaNames = sourceNames.filter((name) => name !== 'output');
    if (metaNames.some((name) => source[name] !== null && typeof source[name] === 'object'))
      throw invalid();
    const admitted = project(source, metaNames, 8192, facts);
    const output = source.output;
    const sizes = facts.get(source);
    if (typeof output !== 'string' || sizes[5] > maximum) throw invalid();
    if (!verified.has(output)) {
      if (!isWellFormedEvidenceText(output)) throw invalid();
      if (verified.size < 128 && cachedBytes + sizes[5] <= 4 * 1024 * 1024) {
        verified.add(output);
        cachedBytes += sizes[5];
      }
    }
    bytes += admitted.bytes + Buffer.byteLength(',"output":') + sizes[6] + (index ? 1 : 0);
    if (bytes > envelopeBytes) throw invalid();
    admitted.result.output = output;
    safe.sources.push(Object.freeze(admitted.result));
  }
  Object.freeze(safe.sources);
  return Object.freeze(safe);
}

module.exports = { admitRecoveryRoot, normalizeOwnedRecoveryLedger };
