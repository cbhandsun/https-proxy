'use strict';

const { createHash } = require('node:crypto');
const {
  TASK_STATE_SCHEMA,
  MAX_TASK_STATE_BYTES,
  generatedTaskStateRequirements,
  taskStateCitationSources,
  selectTaskStateSource,
  parseTaskStateSummary,
  taskStateSummaryCandidate,
} = require('./context-task-state');

function invalid() {
  return new TypeError('Invalid task-state continuity source');
}
function denseData(values, maximum) {
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length > maximum ||
    Reflect.ownKeys(values).length !== values.length + 1
  )
    throw invalid();
  return Array.from({ length: values.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    return descriptor.value;
  });
}
function empty(pinnedMessages) {
  return { candidate: null, source: null, pinnedMessages: Object.freeze(pinnedMessages) };
}

// Rebase only to a unique, exact current original with the same role and full
// message digest. Old m_N ordinals are snapshot-local, not identity. No source
// text is reconstructed from a quote; missing/ambiguous originals pin the old
// genuine state instead of allowing a lossy replacement. Nothing reads a tool,
// old chat file, archive or model here, nor retains any new original text.
function prepareTaskStateContinuity(chunks, messages) {
  const sources = denseData(chunks, 16);
  if (!sources.length) throw invalid();
  const byDigest = new Map();
  for (const source of sources) {
    for (const entry of taskStateCitationSources(source)) {
      const key = `${entry.role}:${entry.digest}`;
      if (!byDigest.has(key)) byDigest.set(key, new Map());
      byDigest.get(key).set(entry.id, entry);
    }
  }
  const states = [...new Set(denseData(messages, 16384))].flatMap((message) => {
    const previous = generatedTaskStateRequirements(message);
    return previous?.requirements.length ? [{ message, ...previous }] : [];
  });
  const pinned = [];
  const requirements = [];
  function reference(previous) {
    const candidates = byDigest.get(`${previous.sourceRole}:${previous.sourceDigest}`);
    if (candidates?.size !== 1) return null;
    return { sourceId: candidates.values().next().value.id, quote: previous.quote };
  }
  for (const state of states) {
    if (!state.rebasable) {
      pinned.push(state.message);
      continue;
    }
    const rebased = state.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      status: requirement.status,
      sources: requirement.sources.map(reference),
      ...(requirement.revision ? { revision: reference(requirement.revision) } : {}),
    }));
    if (
      rebased.some(
        (requirement) =>
          requirement.sources.includes(null) ||
          (Object.hasOwn(requirement, 'revision') && requirement.revision === null)
      )
    ) {
      pinned.push(state.message);
    } else requirements.push(...rebased);
  }
  const unique = [...new Map(requirements.map((entry) => [JSON.stringify(entry), entry])).values()];
  if (!unique.length) return empty(pinned);
  const ids = new Map();
  for (const entry of unique) ids.set(entry.id, (ids.get(entry.id) || 0) + 1);
  const candidate = {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: unique.map((entry) =>
      ids.get(entry.id) === 1
        ? entry
        : {
            ...entry,
            id:
              'carried_' +
              createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 48),
          }
    ),
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  const text = JSON.stringify(candidate);
  if (unique.length > 32 || Buffer.byteLength(text) > MAX_TASK_STATE_BYTES)
    return empty(states.map((state) => state.message));
  const wanted = unique
    .flatMap((entry) => [...entry.sources, ...(entry.revision ? [entry.revision] : [])])
    .map((entry) => entry.sourceId);
  try {
    const source = selectTaskStateSource(sources, wanted);
    const state = parseTaskStateSummary(text, source);
    return {
      candidate: taskStateSummaryCandidate(state, source),
      source,
      pinnedMessages: Object.freeze(pinned),
    };
  } catch (error) {
    if (error?.code !== 'invalid_task_state') throw error;
    // Reordering can invalidate an old revision even when every quote exists.
    // Keep all old states exact; never invent chronology or reactivate a grant.
    return empty(states.map((state) => state.message));
  }
}

module.exports = { prepareTaskStateContinuity };
