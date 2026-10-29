'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const MAX_ITEMS = 16384;
const invalid = () => new TypeError('Invalid context binding window');
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_ITEMS;

function parseBindingWindow(input) {
  const value = normalizeCompactionData(input, 1024);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'count,kind' ||
    !['full', 'delta', 'compaction', 'summary', 'unavailable'].includes(value.kind) ||
    (value.kind === 'unavailable' ? value.count !== null : !count(value.count))
  )
    throw invalid();
  return value;
}

function selectBindingWindow(input) {
  const value = normalizeCompactionData(input, 1024);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'count,fullPrefix,hasPrevious,parentCount' ||
    !count(value.count) ||
    typeof value.fullPrefix !== 'boolean' ||
    typeof value.hasPrevious !== 'boolean' ||
    (value.parentCount !== null && !count(value.parentCount))
  )
    throw invalid();
  if (!value.hasPrevious || value.fullPrefix) return { kind: 'full', count: value.count };
  if (value.parentCount !== null && count(value.parentCount + value.count))
    return { kind: 'delta', count: value.parentCount + value.count };
  return { kind: 'unavailable', count: null };
}

function publishBindingWindow(input, outputCount, compaction) {
  const value = parseBindingWindow(input);
  if (!count(outputCount) || outputCount === 0 || typeof compaction !== 'boolean') throw invalid();
  if (compaction) return { kind: 'compaction', count: outputCount };
  if (value.count !== null && count(value.count + outputCount))
    return { kind: value.kind, count: value.count + outputCount };
  return { kind: 'unavailable', count: null };
}

module.exports = { parseBindingWindow, selectBindingWindow, publishBindingWindow };
