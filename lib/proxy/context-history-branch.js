'use strict';

const { createHash } = require('node:crypto');
const { normalizeCallIdDigests } = require('./context-call-id-lineage');
const {
  isLocalCompactionMessage,
  carryLocalCompactionMessage,
} = require('./context-local-compaction-provenance');
const {
  carryResponsesHistoryPolicy,
  preservesResponsesHistory,
  shouldStoreResponsesHistory,
  responsesTruncation,
} = require('./responses-history-policy');
const { boundCompletedToolRounds } = require('./context-completed-rounds');
const {
  createTaskStateSource,
  isGeneratedTaskStateMessage,
  generatedTaskStateSourceDigest,
  carryGeneratedTaskStateMessage,
} = require('./context-task-state');

const branches = new WeakSet();
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 16384;
const MAX_HISTORY_CALL_IDS = 65536;
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const failure = (reason) => ({ ok: false, reason });
function limit(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
function identity(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function dataOptions(value, allowed) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
  );
}
function invalidHistory() {
  const error = new TypeError('Invalid or oversized context history');
  error.code = 'invalid_context_history';
  return error;
}
function checkJSON(value, depth, budget, arrayValue = false) {
  if (depth > 64 || --budget.nodes < 0) throw invalidHistory();
  if (value === undefined && !arrayValue) return;
  if (typeof value === 'string') {
    budget.bytes -= Buffer.byteLength(value);
    if (budget.bytes < 0) throw invalidHistory();
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw invalidHistory();
  const array = Array.isArray(value);
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || value.length > budget.nodes))
    throw invalidHistory();
  const keys = Reflect.ownKeys(value);
  if (keys.length > budget.nodes) throw invalidHistory();
  const clone = array ? [] : Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidHistory();
    if (array && key === 'length') continue;
    if (typeof key === 'symbol') continue;
    // Internal non-wire diagnostics are not context. Ignore data descriptors
    // but still reject accessors; only the sanitized clone is serialized.
    if (!descriptor.enumerable) continue;
    if (array && !/^(0|[1-9]\d*)$/.test(key)) throw invalidHistory();
    budget.bytes -= Buffer.byteLength(key);
    if (budget.bytes < 0) throw invalidHistory();
    const item = checkJSON(descriptor.value, depth + 1, budget, array);
    if (item !== undefined)
      Object.defineProperty(clone, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  if (array && (clone.length !== value.length || keys.length !== value.length + 1))
    throw invalidHistory();
  return clone;
}
function freezeJSON(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJSON(item);
    Object.freeze(value);
  }
  return value;
}
function normalizedBody(body, maxBytes) {
  if (!record(body)) throw invalidHistory();
  // Read only checked data descriptors. Never serialize caller objects with
  // getters/toJSON hooks, and reject huge sparse arrays before indexed work.
  const normalized = checkJSON(body, 0, { nodes: 262144, bytes: maxBytes });
  if (!Array.isArray(normalized.messages) || normalized.messages.length > MAX_HISTORY_MESSAGES)
    throw invalidHistory();
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized) > maxBytes) throw invalidHistory();
  const clone = JSON.parse(serialized);
  if (clone.messages.some((message) => !record(message) || !ROLES.has(message.role)))
    throw invalidHistory();
  clone.messages.forEach((message, index) => {
    carryGeneratedTaskStateMessage(message, body.messages[index]);
    carryLocalCompactionMessage(message, body.messages[index]);
  });
  carryResponsesHistoryPolicy(clone, body);
  return { body: freezeJSON(clone), serialized, bytes: Buffer.byteLength(serialized) };
}
function resultOnlyUser(message) {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every(
      (part) => record(part) && (part.type === 'tool_result' || record(part.functionResponse))
    )
  );
}
function mandatoryMessages(body, tail, replacementDigest) {
  if (preservesResponsesHistory(body)) return body.messages;
  const unsafe = boundCompletedToolRounds(body.messages, {
    keepCompletedToolRounds: 0,
    allowEmptyCompletedRounds: true,
  }).protectedIntervals;
  return body.messages.filter(
    (message, index) =>
      ['system', 'developer'].includes(message.role) ||
      (message.role === 'user' && !resultOnlyUser(message)) ||
      tail.has(index) ||
      unsafe.some((interval) => index >= interval.start && index <= interval.end) ||
      (isGeneratedTaskStateMessage(message) && !replacementDigest) ||
      isLocalCompactionMessage(message)
  );
}
function controls(body) {
  return JSON.stringify(
    Object.keys(body)
      .filter((key) => !['messages', 'tools'].includes(key))
      .sort()
      .map((key) => [key, body[key]])
  );
}
function samePolicy(left, right) {
  return (
    shouldStoreResponsesHistory(left) === shouldStoreResponsesHistory(right) &&
    responsesTruncation(left) === responsesTruncation(right)
  );
}
function retainsInOrder(required, messages) {
  let offset = 0;
  for (const message of required) {
    const serialized = JSON.stringify(message);
    while (offset < messages.length && JSON.stringify(messages[offset]) !== serialized) offset += 1;
    if (offset === messages.length) return false;
    offset += 1;
  }
  return true;
}

// Remember identities, not archived contents. Compaction may remove a complete
// exchange from the active window, but must not make its ID reusable within the
// same request. Hashes keep retained identity memory independent of ID length.
function extendCallIds(previous, body, maximum) {
  const next = new Set(previous);
  function add(id) {
    if (identity(id)) next.add(digest(id));
    return next.size <= maximum;
  }
  for (const message of body.messages) {
    if (!add(message.tool_call_id)) return null;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!add(call?.id)) return null;
    }
  }
  return next;
}

// A Responses response ID is an immutable branch point, not permission to merge
// parallel client requests. This handle owns one request branch. Its canonical
// value is private/frozen; shared writers use append + version CAS, never aliases.
function createContextHistoryBranch(body, options = {}) {
  if (
    !dataOptions(options, [
      'owner',
      'scope',
      'maxBytes',
      'maxStages',
      'maxCallIds',
      'initialCallIdDigests',
    ])
  )
    throw invalidHistory();
  if (!identity(options.owner) || !identity(options.scope)) throw invalidHistory();
  const maxBytes = limit(options.maxBytes, 16 * 1024 * 1024, MAX_HISTORY_BYTES);
  const maxStages = limit(options.maxStages, 4, 16);
  const maxCallIds = limit(options.maxCallIds, MAX_HISTORY_CALL_IDS, MAX_HISTORY_CALL_IDS);
  let initialCallIds;
  try {
    initialCallIds = normalizeCallIdDigests(options.initialCallIdDigests, maxCallIds);
  } catch (error) {
    if (error?.code !== 'invalid_context_call_lineage') throw error;
    throw invalidHistory();
  }
  let canonical = normalizedBody(body, maxBytes);
  let callIds = extendCallIds(new Set(initialCallIds), canonical.body, maxCallIds);
  if (!callIds) throw invalidHistory();
  let version = 1;
  let revision = 0;
  let closed = false;
  let committing = false;
  let snapshots = new WeakMap();
  let stageRecords = new WeakMap();
  const pending = new Set();
  const branchIdentity = Object.freeze({ owner: options.owner, scope: options.scope });
  function validSnapshot(snapshot) {
    const source = snapshots.get(snapshot);
    if (closed) return failure('context_history_closed');
    if (!source) return failure('invalid_context_history_snapshot');
    if (source.revision !== revision) return failure('stale_context_history_snapshot');
    return { ok: true, source };
  }
  function release(record) {
    pending.delete(record);
    record.candidate = null;
    record.callIds = null;
  }
  const branch = {
    hasToolCallId(id) {
      return !closed && identity(id) && callIds.has(digest(id));
    },
    matches(body) {
      if (closed) return false;
      try {
        const candidate = normalizedBody(body, maxBytes);
        return (
          candidate.serialized === canonical.serialized &&
          samePolicy(candidate.body, canonical.body)
        );
      } catch (error) {
        if (error?.code !== 'invalid_context_history') throw error;
        return false;
      }
    },
    snapshot() {
      if (closed) return failure('context_history_closed');
      const snapshot = Object.freeze({
        version,
        messageCount: canonical.body.messages.length,
        digest: digest(canonical.serialized),
        body: canonical.body,
      });
      snapshots.set(snapshot, { version, revision, body: canonical.body });
      return snapshot;
    },
    inspect(snapshot) {
      const checked = validSnapshot(snapshot);
      if (!checked.ok) return checked;
      return {
        ok: true,
        version,
        body: canonical.body,
        appendedMessages: canonical.body.messages.slice(checked.source.body.messages.length),
      };
    },
    append(messages, expectedVersion) {
      if (closed) return failure('context_history_closed');
      if (committing) return failure('context_history_busy');
      if (expectedVersion !== version) return failure('context_history_version_conflict');
      if (version >= Number.MAX_SAFE_INTEGER) return failure('context_history_version_exhausted');
      if (!Array.isArray(messages) || messages.length > MAX_HISTORY_MESSAGES)
        return failure('invalid_context_history');
      if (messages.length === 0) return { ok: true, version };
      let candidate;
      try {
        const additions = checkJSON(messages, 0, { nodes: 262144, bytes: maxBytes });
        candidate = normalizedBody(
          { ...canonical.body, messages: [...canonical.body.messages, ...additions] },
          maxBytes
        );
        additions.forEach((_message, index) => {
          carryGeneratedTaskStateMessage(
            candidate.body.messages[canonical.body.messages.length + index],
            messages[index]
          );
          carryLocalCompactionMessage(
            candidate.body.messages[canonical.body.messages.length + index],
            messages[index]
          );
        });
      } catch (error) {
        if (error?.code !== 'invalid_context_history') throw error;
        return failure(error.code);
      }
      const nextCallIds = extendCallIds(callIds, candidate.body, maxCallIds);
      if (!nextCallIds) return failure('context_history_call_id_limit');
      canonical = candidate;
      callIds = nextCallIds;
      version += 1;
      return { ok: true, version };
    },
    replace(body, expectedVersion) {
      if (closed) return failure('context_history_closed');
      if (committing) return failure('context_history_busy');
      if (expectedVersion !== version) return failure('context_history_version_conflict');
      if (version >= Number.MAX_SAFE_INTEGER || revision >= Number.MAX_SAFE_INTEGER)
        return failure('context_history_version_exhausted');
      let candidate;
      try {
        candidate = normalizedBody(body, maxBytes);
      } catch (error) {
        if (error?.code !== 'invalid_context_history') throw error;
        return failure(error.code);
      }
      const nextCallIds = extendCallIds(callIds, candidate.body, maxCallIds);
      if (!nextCallIds) return failure('context_history_call_id_limit');
      canonical = candidate;
      callIds = nextCallIds;
      version += 1;
      revision += 1;
      return { ok: true, version };
    },
    stage(snapshot, candidateBody) {
      const checked = validSnapshot(snapshot);
      if (!checked.ok) return checked;
      if (committing) return failure('context_history_busy');
      if (pending.size >= maxStages) return failure('context_history_stage_limit');
      if (version >= Number.MAX_SAFE_INTEGER || revision >= Number.MAX_SAFE_INTEGER)
        return failure('context_history_version_exhausted');
      let candidate;
      try {
        candidate = normalizedBody(candidateBody, maxBytes);
      } catch (error) {
        if (error?.code !== 'invalid_context_history') throw error;
        return failure(error.code);
      }
      if (
        controls(canonical.body) !== controls(candidate.body) ||
        !samePolicy(canonical.body, candidate.body)
      )
        return failure('context_history_controls_changed');
      const sourceDigest = createTaskStateSource(checked.source.body.messages)?.digest;
      const replacement =
        sourceDigest &&
        candidate.body.messages.some(
          (message) => generatedTaskStateSourceDigest(message) === sourceDigest
        );
      const tail = new Set(
        canonical.body.messages
          .slice(checked.source.body.messages.length)
          .map((_entry, index) => index + checked.source.body.messages.length)
      );
      if (
        !retainsInOrder(
          mandatoryMessages(canonical.body, tail, replacement),
          candidate.body.messages
        )
      )
        return failure('context_history_required_messages_missing');
      const nextCallIds = extendCallIds(callIds, candidate.body, maxCallIds);
      if (!nextCallIds) return failure('context_history_call_id_limit');
      const ticket = Object.freeze({ baseVersion: version, digest: digest(candidate.serialized) });
      const record = {
        version,
        revision,
        candidate,
        callIds: nextCallIds,
        result: null,
        rolledBack: false,
      };
      stageRecords.set(ticket, record);
      pending.add(record);
      return { ok: true, ticket };
    },
    commit(ticket, options = {}) {
      if (closed) return failure('context_history_closed');
      if (committing) return failure('context_history_busy');
      const record = stageRecords.get(ticket);
      if (!record || record.rolledBack) return failure('invalid_context_history_stage');
      if (record.result) return record.result;
      if (record.version !== version || record.revision !== revision) {
        release(record);
        record.rolledBack = true;
        return failure('context_history_version_conflict');
      }
      if (
        !dataOptions(options, ['signal', 'publish']) ||
        (options.signal != null && !(options.signal instanceof globalThis.AbortSignal)) ||
        (options.publish != null && typeof options.publish !== 'function')
      )
        return failure('invalid_context_history_commit');
      if (options.signal?.aborted) {
        release(record);
        record.rolledBack = true;
        return failure('context_history_cancelled');
      }
      committing = true;
      try {
        const publication = options.publish ? options.publish() : { ok: true };
        if (publication?.ok !== true) {
          release(record);
          record.rolledBack = true;
          return failure('context_history_publication_failed');
        }
        // No awaits, observable setters or further admission checks after the
        // atomic publisher succeeds. Reentrant writes/close are refused. Once
        // this commit linearizes, a later cancellation cannot undo it.
        canonical = record.candidate;
        callIds = record.callIds;
        version += 1;
        revision += 1;
        record.result = Object.freeze({ ok: true, version, body: canonical.body, publication });
        release(record);
        return record.result;
      } catch (error) {
        release(record);
        record.rolledBack = true;
        throw error;
      } finally {
        committing = false;
      }
    },
    rollback(ticket) {
      if (committing) return false;
      const record = stageRecords.get(ticket);
      if (!record || record.result) return false;
      release(record);
      record.rolledBack = true;
      return true;
    },
    stats() {
      return {
        version,
        revision,
        closed,
        messageCount: canonical?.body.messages.length || 0,
        bytes: canonical?.bytes || 0,
        stagedEntries: pending.size,
        retainedCallIds: callIds.size,
      };
    },
    close() {
      if (committing) return false;
      closed = true;
      canonical = null;
      callIds.clear();
      for (const record of pending) {
        record.rolledBack = true;
        release(record);
      }
      snapshots = new WeakMap();
      stageRecords = new WeakMap();
      return true;
    },
    identity: branchIdentity,
  };
  branches.add(branch);
  return Object.freeze(branch);
}

function isContextHistoryBranch(value) {
  return record(value) && branches.has(value);
}
function captureContextHistorySnapshot(branch, body, owner, scope) {
  if (branch == null) return null;
  if (
    !isContextHistoryBranch(branch) ||
    branch.identity.owner !== owner ||
    branch.identity.scope !== scope ||
    !branch.matches(body)
  ) {
    const error = new TypeError('Context history is stale, invalid or not owned by this request');
    error.code = 'context_history_conflict';
    throw error;
  }
  return branch.snapshot();
}
function contextHistoryControlDigest(body) {
  if (!record(body)) return null;
  return digest(
    JSON.stringify([
      Object.keys(body)
        .filter((key) => key !== 'messages')
        .sort()
        .map((key) => [key, body[key]]),
      shouldStoreResponsesHistory(body),
      responsesTruncation(body),
    ])
  );
}
function isContextHistoryFailure(reason) {
  return (
    typeof reason === 'string' &&
    (reason.startsWith('context_history_') ||
      [
        'stale_context_history_snapshot',
        'stale_context_snapshot',
        'invalid_context_history',
        'invalid_context_history_snapshot',
        'invalid_context_history_stage',
        'invalid_context_history_commit',
        'invalid_context_history_branch',
      ].includes(reason))
  );
}
function commitContextHistoryPlan(branch, snapshot, body, publish, signal) {
  if (!isContextHistoryBranch(branch)) return failure('invalid_context_history_branch');
  const staged = branch.stage(snapshot, body);
  if (!staged.ok) return staged;
  try {
    return branch.commit(staged.ticket, { publish, signal });
  } finally {
    branch.rollback(staged.ticket);
  }
}

module.exports = {
  MAX_HISTORY_BYTES,
  createContextHistoryBranch,
  isContextHistoryBranch,
  commitContextHistoryPlan,
  captureContextHistorySnapshot,
  contextHistoryControlDigest,
  isContextHistoryFailure,
};
