'use strict';

const { createHash } = require('node:crypto');
const { sanitizeToolHistoryDiagnostics } = require('./workbuddy-tool-history-diagnostics');
const { createToolHistoryNote } = require('./workbuddy-tool-history-notes');

const MAX_MESSAGES = 16384;
const MAX_RESULTS_PER_CALL = 64;
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const REASONS = new Set([
  'invalid_shape',
  'invalid_id',
  'duplicate_call',
  'orphan_result',
  'missing_result',
  'duplicate_result',
  'result_limit',
]);

function failure(reason, diagnostics) {
  const error = new TypeError('Invalid WorkBuddy tool history');
  error.code = 'invalid_workbuddy_tool_history';
  error.reason = REASONS.has(reason) ? reason : 'invalid_shape';
  if (diagnostics) error.diagnostics = sanitizeToolHistoryDiagnostics(diagnostics);
  throw error;
}

function record(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && Object.hasOwn(descriptor, 'value');
    })
  );
}

function identity(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    failure('invalid_id');
  return value;
}

// Validate data before fingerprinting: no getters, toJSON hooks, cycles, or
// unbounded traversal. Fingerprints and payloads never enter diagnostics.
function validateData(value, budget, depth = 0) {
  if (depth > 64 || --budget.nodes < 0) failure('invalid_shape');
  if (typeof value === 'string') {
    budget.bytes -= Buffer.byteLength(value);
    if (budget.bytes < 0) failure('invalid_shape');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > budget.nodes ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      failure('invalid_shape');
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) failure('invalid_shape');
      validateData(descriptor.value, budget, depth + 1);
    }
    return;
  }
  if (!record(value)) failure('invalid_shape');
  for (const [key, child] of Object.entries(value)) {
    budget.bytes -= Buffer.byteLength(key);
    if (budget.bytes < 0) failure('invalid_shape');
    validateData(child, budget, depth + 1);
  }
}

function fingerprint(message, budget) {
  if (
    message.content !== null &&
    typeof message.content !== 'string' &&
    !Array.isArray(message.content)
  )
    failure('invalid_shape');
  if (message.is_error != null && typeof message.is_error !== 'boolean') failure('invalid_shape');
  if (message.status != null && !['error', 'completed'].includes(message.status))
    failure('invalid_shape');
  validateData(message.content, budget);
  return createHash('sha256')
    .update(JSON.stringify([message.content, message.is_error === true, message.status ?? null]))
    .digest('hex');
}

function combinedResult(records, chronology) {
  if (records.length === 1 && !chronology) return records[0];
  const content = [];
  if (chronology) {
    let text =
      '[Tool-history repair: normalized placement is not evidence of event order or success.';
    if (chronology.firstProgressIndex !== undefined)
      text += ` Assistant progress within original message indices ${chronology.firstProgressIndex} through ${chronology.lastProgressIndex} (range may include outputs) follows this batch with original content and role.`;
    if (chronology.firstCallBoundaryIndex !== undefined)
      text += ` Later outputs for this already completed call arrived across subsequent tool-call batches at original message indices ${chronology.firstCallBoundaryIndex} through ${chronology.lastCallBoundaryIndex}. Do not infer that subsequent calls or assistant messages observed outputs recorded later.`;
    content.push(createToolHistoryNote(`${text}]`));
  }
  if (records.length > 1) {
    content.push(
      createToolHistoryNote(
        '[Multiple recorded outputs for one tool call. All distinct records are preserved in order; they may disagree. Do not assume success from any one record.]'
      )
    );
  }
  records.forEach((message, index) => {
    const error = message.is_error === true || message.status === 'error';
    const source = chronology ? `; original message index ${chronology.sourceIndices[index]}` : '';
    const empty = message.content === null ? '; null content' : '';
    content.push(
      createToolHistoryNote(
        `\n[Recorded output ${index + 1}${source}${error ? '; marked as error' : ''}${empty}]\n`
      )
    );
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content });
    else if (Array.isArray(message.content)) content.push(...message.content);
  });
  const result = { ...records[0], content };
  if (records.some((message) => message.is_error === true || message.status === 'error'))
    result.is_error = true;
  delete result.status;
  return result;
}

function normalizeWorkBuddyToolHistory(messages, { repair = true } = {}) {
  if (
    !Array.isArray(messages) ||
    messages.length > MAX_MESSAGES ||
    Object.getPrototypeOf(messages) !== Array.prototype ||
    Reflect.ownKeys(messages).length !== messages.length + 1
  )
    failure('invalid_shape');
  const output = [];
  const seen = new Map();
  const completed = new Map();
  let batch = new Map();
  let latestCallBatchIndex = 0;
  let progress = [];
  let deferredCount = 0;
  const budget = { nodes: 262144, bytes: 64 * 1024 * 1024 };
  const diagnostics = {
    deduplicatedResults: 0,
    combinedResults: 0,
    combinedCalls: 0,
    deferredAssistantMessages: 0,
    lateResultsAcrossCallBatches: 0,
  };
  const finishBatch = (boundaryType, boundaryMessageIndex) => {
    for (const [id, entry] of batch) {
      const prior = seen.get(id);
      if (!entry.records.length)
        failure('missing_result', {
          messageCount: messages.length,
          messageIndex: boundaryMessageIndex,
          callsSeen: seen.size,
          activeCalls: batch.size,
          callMessageIndex: prior.callMessageIndex,
          boundaryType,
          boundaryMessageIndex,
          resultsSeenForCall: 0,
        });
      const chronology = deferredCount
        ? {
            firstProgressIndex: progress[0].sourceIndex,
            lastProgressIndex: progress[deferredCount - 1].sourceIndex,
            sourceIndices: entry.sourceIndices,
          }
        : undefined;
      output[entry.outputIndex] = combinedResult(entry.records, chronology);
      entry.chronology = chronology;
      if (entry.records.length > 1) diagnostics.combinedCalls += 1;
      prior.boundaryType = boundaryType;
      prior.boundaryMessageIndex = boundaryMessageIndex;
      prior.resultsSeenForCall = entry.count;
      if (repair && boundaryType === 'new_call_batch') {
        entry.firstSubsequentCallIndex = boundaryMessageIndex;
        completed.set(id, entry);
      }
    }
    for (const entry of progress) output.push(entry.message);
    diagnostics.deferredAssistantMessages += deferredCount;
    progress = [];
    deferredCount = 0;
    batch = new Map();
    if (boundaryType !== 'new_call_batch') {
      for (const id of completed.keys()) {
        const prior = seen.get(id);
        prior.boundaryType = boundaryType;
        prior.boundaryMessageIndex = boundaryMessageIndex;
      }
      completed.clear();
    }
  };
  for (let index = 0; index < messages.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) failure('invalid_shape');
    const message = descriptor.value;
    if (!record(message) || !ROLES.has(message.role)) failure('invalid_shape');
    if (
      message.function_call != null ||
      (message.role !== 'assistant' && message.tool_calls != null)
    )
      failure('invalid_shape');
    if (message.role === 'tool') {
      const id = identity(message.tool_call_id);
      const late = !batch.has(id);
      const entry = batch.get(id) || (repair ? completed.get(id) : undefined);
      if (!entry) {
        const prior = seen.get(id);
        failure('orphan_result', {
          messageCount: messages.length,
          messageIndex: index,
          callsSeen: seen.size,
          activeCalls: batch.size,
          orphanRelation: prior ? 'closed_call_batch' : 'no_prior_call',
          ...prior,
        });
      }
      if (++entry.count > MAX_RESULTS_PER_CALL) failure('result_limit');
      const digest = fingerprint(message, budget);
      if (entry.count > 1 && !repair) failure('duplicate_result');
      if (entry.fingerprints.has(digest)) diagnostics.deduplicatedResults += 1;
      else {
        entry.fingerprints.add(digest);
        if (entry.records.length) {
          diagnostics.combinedResults += 1;
          if (late && entry.records.length === 1) diagnostics.combinedCalls += 1;
        } else {
          entry.outputIndex = output.length;
          output.push(message);
        }
        entry.records.push(message);
        entry.sourceIndices.push(index);
      }
      if (late) {
        entry.chronology = {
          ...entry.chronology,
          sourceIndices: entry.sourceIndices,
          firstCallBoundaryIndex: entry.firstSubsequentCallIndex,
          lastCallBoundaryIndex: latestCallBatchIndex,
        };
        output[entry.outputIndex] = combinedResult(entry.records, entry.chronology);
        seen.get(id).resultsSeenForCall = entry.count;
        diagnostics.lateResultsAcrossCallBatches += 1;
      } else deferredCount = progress.length;
      continue;
    }
    // Only assistant narration inside the current call batch may be deferred.
    // A new batch can admit late supplemental results only for globally unique,
    // already completed calls in this uninterrupted assistant/tool segment.
    // User/policy and empty-call boundaries revoke that capability. Strict
    // send-time admission never performs repair or invents missing records.
    if (repair && batch.size && message.role === 'assistant' && message.tool_calls == null) {
      if (
        message.content !== null &&
        typeof message.content !== 'string' &&
        !Array.isArray(message.content)
      )
        failure('invalid_shape');
      validateData(message, budget);
      progress.push({ message, sourceIndex: index });
      continue;
    }
    const boundaryType =
      message.role !== 'assistant'
        ? message.role
        : message.tool_calls != null
          ? Array.isArray(message.tool_calls) && message.tool_calls.length === 0
            ? 'empty_call_batch'
            : 'new_call_batch'
          : 'assistant';
    finishBatch(boundaryType, index);
    if (boundaryType === 'new_call_batch') latestCallBatchIndex = index;
    if (message.tool_calls != null) {
      if (
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length > 64 ||
        Object.getPrototypeOf(message.tool_calls) !== Array.prototype ||
        Reflect.ownKeys(message.tool_calls).length !== message.tool_calls.length + 1
      )
        failure('invalid_shape');
      for (let callIndex = 0; callIndex < message.tool_calls.length; callIndex += 1) {
        const callDescriptor = Object.getOwnPropertyDescriptor(
          message.tool_calls,
          String(callIndex)
        );
        if (!callDescriptor || !Object.hasOwn(callDescriptor, 'value')) failure('invalid_shape');
        const call = callDescriptor.value;
        if (
          !record(call) ||
          call.type !== 'function' ||
          !record(call.function) ||
          typeof call.function.name !== 'string' ||
          !call.function.name.trim() ||
          typeof call.function.arguments !== 'string'
        )
          failure('invalid_shape');
        const id = identity(call.id);
        if (seen.has(id)) failure('duplicate_call');
        seen.set(id, { callMessageIndex: index });
        batch.set(id, {
          count: 0,
          records: [],
          sourceIndices: [],
          fingerprints: new Set(),
          outputIndex: -1,
        });
      }
    }
    output.push(message);
  }
  finishBatch('end_of_history', messages.length);
  const changed =
    diagnostics.deduplicatedResults +
      diagnostics.combinedResults +
      diagnostics.deferredAssistantMessages +
      diagnostics.lateResultsAcrossCallBatches >
    0;
  return { messages: changed ? output : messages, changed, diagnostics };
}

function workBuddyToolHistoryError(error) {
  if (!record(error) && !(error instanceof TypeError)) return null;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const reason = Object.getOwnPropertyDescriptor(error, 'reason')?.value;
  if (code !== 'invalid_workbuddy_tool_history' || !REASONS.has(reason)) return null;
  return {
    code,
    reason,
    diagnostics: sanitizeToolHistoryDiagnostics(
      Object.getOwnPropertyDescriptor(error, 'diagnostics')?.value
    ),
    payload: {
      error: {
        type: 'invalid_request_error',
        code,
        message:
          'Tool history contains missing, orphaned, or ambiguous call records. Rebuild the complete call/result history or start a new task. The invalid history was not sent upstream.',
      },
    },
  };
}

module.exports = { normalizeWorkBuddyToolHistory, workBuddyToolHistoryError };
