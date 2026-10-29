'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');

const TYPE = 'hpm_public_output_reference';
const invalid = () => new TypeError('Invalid public history reference');
const index = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value < limit;
const isPublicHistoryReference = (item) => item?.type === TYPE;

// References are private map metadata, never provider history. Only exact
// published output can supply their bytes; they do not select a root or source.
function readPublicHistoryReferences(tail, outputCount = 128) {
  const references = new Map();
  for (const item of tail) {
    if (!isPublicHistoryReference(item)) continue;
    if (
      Object.keys(item).sort().join(',') !== 'digest,index,type' ||
      !index(item.index, outputCount) ||
      typeof item.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.digest) ||
      references.has(item.index)
    )
      throw invalid();
    references.set(item.index, item.digest);
  }
  return references;
}

function preparePublicHistoryReferences(tail, input) {
  const references = normalizeCompactionData(input, 32768);
  if (!Array.isArray(references) || references.length > 128) throw invalid();
  if (tail.some(isPublicHistoryReference)) throw invalid();
  const result = [...tail];
  const positions = new Set();
  for (const reference of references) {
    if (
      !reference ||
      Array.isArray(reference) ||
      Object.keys(reference).sort().join(',') !== 'historyIndex,outputIndex' ||
      !index(reference.historyIndex, tail.length) ||
      !index(reference.outputIndex, 128) ||
      positions.has(reference.historyIndex)
    )
      throw invalid();
    const item = tail[reference.historyIndex];
    if (
      item?.type !== 'web_search_call' &&
      !(item?.type === 'message' && item.role === 'assistant') &&
      !(
        ['function_call', 'custom_tool_call'].includes(item?.type) &&
        typeof item.name === 'string' &&
        ![LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL].includes(item.name)
      )
    )
      throw invalid();
    positions.add(reference.historyIndex);
    result[reference.historyIndex] = {
      type: TYPE,
      index: reference.outputIndex,
      digest: fingerprintContextData(item),
    };
  }
  readPublicHistoryReferences(result);
  return result;
}

function verifyPublicHistoryReferences(tail, output) {
  const references = readPublicHistoryReferences(tail, output.length);
  for (const [position, digest] of references)
    if (fingerprintContextData(output[position]) !== digest) throw invalid();
  return references;
}

module.exports = {
  isPublicHistoryReference,
  readPublicHistoryReferences,
  preparePublicHistoryReferences,
  verifyPublicHistoryReferences,
};
