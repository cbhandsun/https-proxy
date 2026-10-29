'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { parsePublicWindow, historyEntryBytes } = require('./context-public-window');
const {
  isPublicHistoryReference,
  readPublicHistoryReferences,
} = require('./context-history-public-references');

const {
  privateHistoryCapacity,
  privateHistoryTtl,
  isPrivateHistoryRootId,
} = require('./context-recovery-private-capacity');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && /^hph_[a-f0-9]{32}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function historyStateFailure() {
  return Object.assign(new TypeError('invalid_context_history_state'), {
    code: 'invalid_context_history_state',
  });
}
function exact(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields
  )
    throw historyStateFailure();
}

// The caller has already authenticated the root and supplies the current scope.
// Public-history fingerprints are associations, not bearer capabilities.
function parseContextHistoryState(input, owner, protocol, validateTail, maximumTips = 256) {
  try {
    if (![256, 512].includes(maximumTips)) throw historyStateFailure();
    const version = input && Object.getOwnPropertyDescriptor(input, 'version')?.value;
    const capacity = privateHistoryCapacity(version);
    const state = normalizeCompactionData(input, capacity.stateBytes);
    const ttlMs = privateHistoryTtl(state.version);
    const windowFormat = state?.format === 2 || state?.format === 3;
    exact(
      state,
      (windowFormat
        ? 'entries,format,kind,observedAt,owner,protocol,tips,version'
        : 'entries,kind,observedAt,owner,protocol,tips,version'
      ).replace('protocol,', state.version === 3 ? 'protocol,rootId,' : 'protocol,')
    );
    if (
      state.kind !== 'history-map' ||
      state.owner !== owner ||
      state.protocol !== protocol ||
      (state.version === 3 && !isPrivateHistoryRootId(state.rootId)) ||
      !integer(state.observedAt) ||
      state.observedAt > Number.MAX_SAFE_INTEGER - ttlMs ||
      !Array.isArray(state.entries) ||
      state.entries.length > capacity.maxEntries ||
      !Array.isArray(state.tips) ||
      state.tips.length > maximumTips
    )
      throw historyStateFailure();
    const entries = new Map();
    let retainedBytes = 0;
    for (const source of state.entries) {
      exact(
        source,
        windowFormat
          ? 'bytes,createdAt,expiresAt,id,offset,parentId,prefix,tail,window'
          : 'bytes,createdAt,expiresAt,id,offset,parentId,prefix,tail'
      );
      const parent = source.parentId === null ? null : entries.get(source.parentId);
      const window =
        windowFormat && source.window !== null ? parsePublicWindow(source.window) : null;
      if (
        !id(source.id) ||
        entries.has(source.id) ||
        (source.parentId !== null && !parent) ||
        !integer(source.createdAt) ||
        source.createdAt > state.observedAt ||
        !integer(source.expiresAt) ||
        source.expiresAt <= state.observedAt ||
        source.expiresAt > source.createdAt + ttlMs ||
        (parent
          ? source.createdAt < parent.createdAt || source.expiresAt !== parent.expiresAt
          : source.expiresAt !== source.createdAt + ttlMs) ||
        !integer(source.offset) ||
        source.offset > 16384 ||
        !Array.isArray(source.prefix) ||
        (window
          ? protocol !== 'responses' ||
            source.prefix.length !== 0 ||
            window.count <= source.offset ||
            window.count > source.offset + 128 ||
            (parent &&
              (source.offset < (parent.window?.count ?? parent.prefix.length) ||
                (parent.window && window.scope !== parent.window.scope)))
          : source.prefix.length <= source.offset ||
            source.prefix.length > source.offset + 128 ||
            Boolean(parent?.window)) ||
        !source.prefix.every(hash) ||
        (!window &&
          parent &&
          (source.offset < parent.prefix.length ||
            !parent.prefix.every((value, index) => source.prefix[index] === value))) ||
        !Array.isArray(source.tail) ||
        !source.tail.length ||
        source.tail.length > 1024 ||
        Buffer.byteLength(JSON.stringify(source.tail)) > MAX_WIRE_BYTES ||
        source.tail.some(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            ['system', 'developer'].includes(item.role)
        ) ||
        !integer(source.bytes) ||
        source.bytes !== historyEntryBytes(source.tail, source.prefix, window)
      )
        throw historyStateFailure();
      const references = readPublicHistoryReferences(
        source.tail,
        (window?.count ?? source.prefix.length) - source.offset
      );
      if (references.size && (state.format !== 3 || protocol !== 'responses'))
        throw historyStateFailure();
      if (!window)
        for (const [position, digest] of references)
          if (source.prefix[source.offset + position] !== digest) throw historyStateFailure();
      const callIds = validateTail(
        protocol,
        source.tail,
        parent,
        state.format === 3,
        capacity.maxCalls
      );
      retainedBytes += source.bytes;
      if (retainedBytes > capacity.maxBytes) throw historyStateFailure();
      entries.set(source.id, { ...source, callIds, parent });
    }
    if (state.format === 2 && ![...entries.values()].some((entry) => entry.window))
      throw historyStateFailure();
    if (
      state.format === 3 &&
      ![...entries.values()].some((entry) => entry.tail.some(isPublicHistoryReference))
    )
      throw historyStateFailure();
    if (state.tips.some((tip) => !entries.has(tip))) throw historyStateFailure();
    // Every retained entry belongs to a requested committed tip. Reject hidden,
    // unreachable extras rather than enlarging restore authority or capacity.
    const reachable = new Set();
    for (const tip of state.tips)
      for (let entry = entries.get(tip); entry; entry = entry.parent) reachable.add(entry.id);
    if (reachable.size !== entries.size) throw historyStateFailure();
    return { state, entries, retainedBytes };
  } catch {
    throw historyStateFailure();
  }
}

module.exports = { historyStateFailure, parseContextHistoryState };
