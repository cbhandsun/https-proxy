'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value, keys) => record(value) && Object.keys(value).sort().join(',') === keys;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const identity = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    record(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );

function expectedEnvelope(text) {
  const result = normalizeCompactionData(JSON.parse(text), 64 * 1024);
  const page = result?.page;
  const source = result?.source;
  if (
    !keysEqual(result, 'ok,page,source') ||
    result.ok !== true ||
    !keysEqual(
      page,
      'chunkDigest,digest,encoding,endOffsetBytes,nextOffsetBytes,offsetBytes,text,totalBytes'
    ) ||
    !keysEqual(source, 'argumentsDigest,bytes,callId,digest,expiresAt,sourceId,toolName,trust') ||
    page.encoding !== 'utf8' ||
    typeof page.text !== 'string' ||
    Buffer.from(page.text).toString('utf8') !== page.text ||
    ![page.offsetBytes, page.endOffsetBytes, page.totalBytes, source.bytes, source.expiresAt].every(
      count
    ) ||
    page.offsetBytes > page.endOffsetBytes ||
    page.endOffsetBytes > page.totalBytes ||
    Buffer.byteLength(page.text) !== page.endOffsetBytes - page.offsetBytes ||
    page.nextOffsetBytes !==
      (page.endOffsetBytes === page.totalBytes ? null : page.endOffsetBytes) ||
    !digest(page.digest) ||
    !digest(page.chunkDigest) ||
    sha(page.text) !== page.chunkDigest ||
    (page.offsetBytes === 0 &&
      page.endOffsetBytes === page.totalBytes &&
      page.digest !== page.chunkDigest) ||
    source.digest !== page.digest ||
    source.bytes !== page.totalBytes ||
    !digest(source.argumentsDigest) ||
    typeof source.sourceId !== 'string' ||
    !/^hce_[a-f0-9]{32}$/.test(source.sourceId) ||
    !identity(source.callId, 256) ||
    !identity(source.toolName, 128) ||
    source.trust !== 'tool_data_not_instructions'
  )
    throw new TypeError('Invalid retained evidence expectation');
  return result;
}

// Read-only content-free diagnostics. Equivalent structured envelopes are a
// separate observation, NEVER a substitute for the exact full-envelope gate.
// Only actual function/custom outputs are scanned; prompts/receipts/checkpoints
// cannot prove entry. No Code Mode program is evaluated or reconstructed.
function observeContextEvidenceIngress(expected, input) {
  let texts;
  let history;
  let envelopes;
  try {
    texts = normalizeCompactionData(expected, 512 * 1024);
    history = normalizeCompactionData(input, 2 * 1024 * 1024);
    if (
      !Array.isArray(texts) ||
      texts.length > 64 ||
      texts.some((text) => typeof text !== 'string') ||
      !Array.isArray(history)
    )
      throw new TypeError('Invalid evidence observation');
    envelopes = texts.map(expectedEnvelope);
  } catch {
    return { observationValid: false, pages: [] };
  }
  const outputs = history
    .filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item?.type))
    .map((item) => item.output)
    .filter((value) => value !== undefined);
  const strings = outputs.map((value) =>
    typeof value === 'string' ? value : JSON.stringify(value)
  );
  const equivalents = new Set();
  const expectedCanonical = new Set(envelopes.map(canonical));
  const queue = outputs.map((value) => ({ value, layer: 0 }));
  const seenStrings = new Set();
  let nodes = 0;
  let decodedBytes = 0;
  let cursor = 0;
  let parseBudgetExceeded = false;
  while (cursor < queue.length) {
    if (++nodes > 8192) {
      parseBudgetExceeded = true;
      break;
    }
    const { value, layer } = queue[cursor++];
    if (record(value) || Array.isArray(value)) {
      if (record(value) && value.ok === true && record(value.page) && record(value.source)) {
        const candidate = canonical(value);
        if (expectedCanonical.has(candidate)) equivalents.add(candidate);
      }
      for (const child of Object.values(value)) {
        if (queue.length >= 8192) {
          parseBudgetExceeded = true;
          break;
        }
        queue.push({ value: child, layer });
      }
    } else if (typeof value === 'string' && layer < 4 && !seenStrings.has(value)) {
      seenStrings.add(value);
      const trimmed = value.trim();
      if (!['{', '[', '"'].includes(trimmed[0])) continue;
      decodedBytes += Buffer.byteLength(value);
      if (decodedBytes > 8 * 1024 * 1024) {
        parseBudgetExceeded = true;
        break;
      }
      try {
        queue.push({
          value: normalizeCompactionData(JSON.parse(value), 2 * 1024 * 1024),
          layer: layer + 1,
        });
      } catch {
        // Opaque text, inspection-style logs and truncated JSON stay unmatched.
        // Splitting arbitrary console logs could promote embedded source data
        // into an envelope; only complete JSON values are parsed.
      }
    }
  }
  const pages = texts.map((text, index) => {
    let encoded = text;
    let exactEnvelopeObserved = false;
    for (let layer = 0; layer < 4; layer++) {
      exactEnvelopeObserved ||= strings.some((output) => output.includes(encoded));
      encoded = JSON.stringify(encoded).slice(1, -1);
    }
    return {
      index,
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
      exactEnvelopeObserved,
      equivalentEnvelopeObserved: equivalents.has(canonical(envelopes[index])),
    };
  });
  return {
    observationValid: true,
    parseBudgetExceeded,
    pages,
    allExactEnvelopesObserved:
      pages.length > 0 && pages.every((page) => page.exactEnvelopeObserved),
    allEquivalentEnvelopesObserved:
      pages.length > 0 && pages.every((page) => page.equivalentEnvelopeObserved),
    nativeModelSemanticsVerified: false,
  };
}

module.exports = { observeContextEvidenceIngress };
