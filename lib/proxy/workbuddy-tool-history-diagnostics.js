'use strict';

const MAX_MESSAGES = 16384;
const MAX_COUNTER = MAX_MESSAGES * 64;
const MAX_SCAN_ENTRIES = 262144;
const BOUNDARIES = new Set([
  'user',
  'system',
  'developer',
  'assistant',
  'new_call_batch',
  'empty_call_batch',
  'end_of_history',
]);
const RELATIONS = new Set(['no_prior_call', 'closed_call_batch']);
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_call', 'call']);
const RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_result']);
const COUNTERS = new Set([
  'messageIndex',
  'messageCount',
  'callsSeen',
  'activeCalls',
  'callMessageIndex',
  'boundaryMessageIndex',
  'resultsSeenForCall',
]);

// Diagnostics read data descriptors only. Never evaluate getters, serialize input
// records, retain identifiers, or copy text/arguments/names into the result.
function dataProperty(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
    return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function listLength(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return -1;
  const length = dataProperty(value, 'length');
  return Number.isSafeInteger(length) && length >= 0 && length <= maximum ? length : -1;
}

function boundedId(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim()) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return undefined;
  }
  return value;
}

function sanitizeToolHistoryDiagnostics(value) {
  const result = {};
  for (const key of COUNTERS) {
    const count = dataProperty(value, key);
    if (Number.isSafeInteger(count) && count >= 0 && count <= MAX_COUNTER) result[key] = count;
  }
  const boundary = dataProperty(value, 'boundaryType');
  if (BOUNDARIES.has(boundary)) result.boundaryType = boundary;
  const relation = dataProperty(value, 'orphanRelation');
  if (RELATIONS.has(relation)) result.orphanRelation = relation;
  return result;
}

function inspectWorkBuddyToolHistoryConversion(input, messages, diagnostics) {
  const sourceLength = listLength(input, MAX_MESSAGES);
  const convertedLength = listLength(messages, MAX_MESSAGES);
  const index = dataProperty(sanitizeToolHistoryDiagnostics(diagnostics), 'messageIndex');
  const failedMessage =
    convertedLength >= 0 && Number.isSafeInteger(index) && index < convertedLength
      ? dataProperty(messages, String(index))
      : undefined;
  const failedId =
    dataProperty(failedMessage, 'role') === 'tool'
      ? boundedId(dataProperty(failedMessage, 'tool_call_id'))
      : undefined;
  const result = {
    sourceItemCount: Math.max(0, sourceLength),
    convertedMessageCount: Math.max(0, convertedLength),
    sourceCallItemCount: 0,
    sourceResultItemCount: 0,
    sourceNestedCallCount: 0,
    convertedCallCount: 0,
    convertedResultCount: 0,
    sourceMatchingCallCount: 0,
    sourceMatchingUnnamedCallCount: 0,
    sourceMatchingNestedCallCount: 0,
    sourceMatchingResultCount: 0,
    convertedMatchingCallCount: 0,
    sourceScanComplete: sourceLength >= 0 || input == null || typeof input === 'string',
    convertedScanComplete: convertedLength >= 0,
  };
  let remaining = MAX_SCAN_ENTRIES;
  const match = (id) => failedId !== undefined && boundedId(id) === failedId;
  const scan = (list, length, source) => {
    const completeKey = source ? 'sourceScanComplete' : 'convertedScanComplete';
    for (let itemIndex = 0; itemIndex < length; itemIndex += 1) {
      if (--remaining < 0) {
        result[completeKey] = false;
        break;
      }
      const item = dataProperty(list, String(itemIndex));
      if (item === undefined) result[completeKey] = false;
      const type = dataProperty(item, 'type');
      const role = dataProperty(item, 'role');
      if (source && (CALL_TYPES.has(type) || RESULT_TYPES.has(type))) {
        const id = dataProperty(item, 'call_id') || dataProperty(item, 'id');
        if (CALL_TYPES.has(type)) {
          result.sourceCallItemCount += 1;
          if (match(id)) {
            result.sourceMatchingCallCount += 1;
            if (result.sourceMatchingCallFirstIndex === undefined)
              result.sourceMatchingCallFirstIndex = itemIndex;
            const name = dataProperty(item, 'name');
            if (typeof name !== 'string' || !name.trim()) result.sourceMatchingUnnamedCallCount++;
          }
        } else {
          result.sourceResultItemCount += 1;
          if (match(id)) result.sourceMatchingResultCount += 1;
        }
      }
      if (!source && role === 'tool') result.convertedResultCount += 1;
      if (role !== 'assistant') continue;
      const calls = dataProperty(item, 'tool_calls');
      if (calls == null) continue;
      const callLength = listLength(calls, 64);
      if (callLength < 0) {
        result[completeKey] = false;
        continue;
      }
      for (let callIndex = 0; callIndex < callLength; callIndex += 1) {
        if (--remaining < 0) {
          result[completeKey] = false;
          break;
        }
        const call = dataProperty(calls, String(callIndex));
        if (call === undefined) result[completeKey] = false;
        result[source ? 'sourceNestedCallCount' : 'convertedCallCount'] += 1;
        if (match(dataProperty(call, 'id'))) {
          result[source ? 'sourceMatchingNestedCallCount' : 'convertedMatchingCallCount'] += 1;
          if (!source && result.convertedMatchingCallFirstIndex === undefined)
            result.convertedMatchingCallFirstIndex = itemIndex;
        }
      }
    }
  };
  scan(input, Math.max(0, sourceLength), true);
  scan(messages, Math.max(0, convertedLength), false);
  return result;
}

module.exports = { sanitizeToolHistoryDiagnostics, inspectWorkBuddyToolHistoryConversion };
