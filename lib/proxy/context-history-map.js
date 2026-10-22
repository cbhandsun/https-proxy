'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const {
  historyStateFailure,
  parseContextHistoryState,
} = require('./context-recovery-history-state');
const { fingerprintContextData: digest } = require('./context-recovery-fingerprint');
const { recoveryHistoryIdentity } = require('./context-recovery-claude-identity');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const {
  isPublicHistoryReference,
  preparePublicHistoryReferences,
  readPublicHistoryReferences,
  verifyPublicHistoryReferences,
} = require('./context-history-public-references');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');
const {
  parsePublicWindow,
  publishPublicWindow,
  matchesPublicWindow,
  historyEntryBytes,
} = require('./context-public-window');

const { LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS } = require('./context-recovery-limits');
const {
  privateHistoryCapacity,
  privateHistoryTtl,
  validatePrivateHistoryUsage,
  isPrivateHistoryRootId,
} = require('./context-recovery-private-capacity');
const { normalizeRecoveryStateData } = require('./context-recovery-state-data');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const transfers = new WeakMap();
const adoptionStates = new WeakMap();
const failed = (code = 'context_history_unavailable') => ({ ok: false, code });
function scopeDigest(input) {
  const scope = normalizeCompactionData(input, 4096);
  if (
    !record(scope) ||
    Object.keys(scope).sort().join(',') !== 'policy,principal,protocol,target' ||
    !['chat', 'responses', 'claude'].includes(scope.protocol) ||
    ['principal', 'target', 'policy'].some(
      (key) => typeof scope[key] !== 'string' || !scope[key].length
    )
  )
    throw new TypeError('Invalid history scope');
  return digest(scope);
}
function items(input, maximum, historyFormat = 2) {
  const result =
    historyFormat === 2
      ? normalizeCompactionData(input, MAX_WIRE_BYTES)
      : normalizeRecoveryRequestBody('responses', { input }, historyFormat).input;
  if (!Array.isArray(result) || result.length > maximum || !result.every(record))
    throw new TypeError('Invalid history items');
  return result;
}
const historyDigest = (protocol, item) => digest(recoveryHistoryIdentity(protocol, item));
function matches(prefix, history, protocol) {
  return (
    history.length >= prefix.length &&
    prefix.every((item, index) => item === historyDigest(protocol, history[index]))
  );
}

function validateTail(protocol, tail, parent, allowPublicReferences = false, maximumCalls = 64) {
  const names = new Set([LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL]);
  const seen = new Set();
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent)
    for (const id of ancestor.callIds) seen.add(id);
  const pending = new Set();
  const callIds = [];
  function call(id, name) {
    if (
      typeof id !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(id) ||
      !names.has(name) ||
      seen.has(id) ||
      seen.size >= maximumCalls
    )
      throw new TypeError('Invalid private history call');
    seen.add(id);
    pending.add(id);
    callIds.push(id);
  }
  function result(id) {
    if (!pending.delete(id)) throw new TypeError('Invalid private history result');
  }
  for (const item of tail) {
    if (protocol === 'chat') {
      if (
        item.role === 'assistant' &&
        Array.isArray(item.tool_calls) &&
        item.tool_calls.length &&
        !pending.size
      ) {
        for (const tool of item.tool_calls) {
          if (tool.type !== 'function') throw new TypeError('Invalid private history tool');
          call(tool.id, tool.function?.name);
        }
      } else if (item.role === 'tool' && typeof item.content === 'string')
        result(item.tool_call_id);
      else throw new TypeError('Invalid private history item');
    } else if (protocol === 'responses') {
      if (isPublicHistoryReference(item)) {
        if (!allowPublicReferences) throw new TypeError('Invalid private history reference');
      } else if (item.type === 'function_call') call(item.call_id, item.name);
      else if (item.type === 'function_call_output' && typeof item.output === 'string')
        result(item.call_id);
      else if (
        !['reasoning', 'compaction'].includes(item.type) &&
        !(item.type === 'message' && item.role === 'assistant')
      )
        throw new TypeError('Invalid private history item');
    } else {
      if (!Array.isArray(item.content)) throw new TypeError('Invalid private history blocks');
      if (item.role === 'assistant' && !pending.size) {
        const calls = item.content.filter((block) => block.type === 'tool_use');
        if (
          !calls.length ||
          item.content.some(
            (block) => !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)
          )
        )
          throw new TypeError('Invalid private history blocks');
        for (const tool of calls) call(tool.id, tool.name);
      } else if (item.role === 'user' && item.content.length) {
        for (const block of item.content) {
          if (block.type !== 'tool_result' || typeof block.content !== 'string')
            throw new TypeError('Invalid private history result');
          result(block.tool_use_id);
        }
      } else throw new TypeError('Invalid private history role');
    }
  }
  const references = readPublicHistoryReferences(tail);
  if (references.size && (protocol !== 'responses' || !allowPublicReferences))
    throw new TypeError('Invalid private history references');
  if (pending.size || !callIds.length) throw new TypeError('Incomplete private history');
  return callIds;
}

// Store only hashes of public history and explicitly supplied private exchanges.
// Never retain a second copy of the client's user/system messages. Capabilities
// stay private to trusted session code; there is no model-selected lookup index.
function createContextHistoryMap(options = {}) {
  return createHistoryMap(options);
}

function createHistoryMap(
  { now = Date.now, ttlMs = LEGACY_RECOVERY_TTL_MS, maximumTips = 256, capacityVersion = 1 } = {},
  restored
) {
  if (![256, 512].includes(maximumTips)) throw historyStateFailure();
  if (![1, 2].includes(capacityVersion)) throw historyStateFailure();
  if (typeof now !== 'function' || ![LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS].includes(ttlMs))
    throw new TypeError('Invalid history clock');
  const capabilities = new WeakMap();
  const entryTokens = new WeakMap();
  const retained = new Set();
  let retainedBytes = 0;
  let lastTime = 0;
  let closed = false;
  function remove(entry) {
    if (!entry.active) return;
    entry.active = false;
    retained.delete(entry);
    retainedBytes -= entry.bytes;
    entry.tail = [];
    entry.prefix = [];
  }
  function clock() {
    if (closed) return null;
    let value;
    try {
      value = now();
    } catch {
      value = null;
    }
    if (
      !Number.isSafeInteger(value) ||
      value < lastTime ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - RECOVERY_TTL_MS
    ) {
      closed = true;
      for (const entry of retained) remove(entry);
      return null;
    }
    lastTime = value;
    for (const entry of retained) if (entry.expiresAt <= value) remove(entry);
    return value;
  }
  function get(token, committed = true) {
    const entry = token && capabilities.get(token);
    if (!entry?.active || entry.committed !== committed) return null;
    for (let ancestor = entry.parent; ancestor; ancestor = ancestor.parent)
      if (!ancestor.active || !ancestor.committed) return null;
    return entry;
  }
  const map = {
    prepare({
      scope,
      parent,
      clientHistory,
      hiddenTail,
      publicWindow,
      publicReferences,
      ttlMs: entryTtlMs = ttlMs,
      historyFormat = 2,
      rootId,
      historyVersion = entryTtlMs === RECOVERY_TTL_MS ? 2 : 1,
    }) {
      const time = clock();
      if (time === null) return failed();
      try {
        if (![LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS].includes(entryTtlMs))
          return failed('context_history_invalid_input');
        const owner = scopeDigest(scope);
        const prior = parent === undefined ? null : get(parent);
        if (parent !== undefined && (!prior || prior.owner !== owner)) return failed();
        const capacity = privateHistoryCapacity(historyVersion);
        if (
          privateHistoryTtl(historyVersion) !== entryTtlMs ||
          (historyVersion === 3 && (capacityVersion !== 2 || !isPrivateHistoryRootId(rootId))) ||
          (prior &&
            (prior.version !== historyVersion || (historyVersion === 3 && prior.rootId !== rootId)))
        )
          return failed('context_history_invalid_input');
        const history = items(clientHistory, 16384, historyFormat);
        let tail = items(hiddenTail, 1024);
        if (publicReferences !== undefined) {
          if (scope.protocol !== 'responses') throw new TypeError('Invalid reference protocol');
          tail = preparePublicHistoryReferences(tail, publicReferences);
        }
        const window = publicWindow === undefined ? null : parsePublicWindow(publicWindow, false);
        if (
          window &&
          (scope.protocol !== 'responses' ||
            window.count < history.length ||
            (prior && window.count < (prior.window?.count ?? prior.prefix.length)) ||
            (prior?.window && prior.window.scope !== window.scope))
        )
          return failed('context_history_conflict');
        if (
          !tail.length ||
          (!window && prior && (prior.window || !matches(prior.prefix, history, scope.protocol)))
        )
          return failed('context_history_conflict');
        // Every hidden item must come from the private tool exchange. Inputs with
        // elevated roles are refused even if an adapter accidentally supplies one.
        if (tail.some((item) => ['system', 'developer'].includes(item.role)))
          return failed('context_history_invalid_tail');
        const callIds = validateTail(
          scope.protocol,
          tail,
          prior,
          publicReferences !== undefined,
          capacity.maxCalls
        );
        const prefix = window ? [] : history.map((item) => historyDigest(scope.protocol, item));
        const bytes = historyEntryBytes(tail, prefix, window);
        try {
          validatePrivateHistoryUsage(
            [...retained, { version: historyVersion, rootId, bytes }],
            capacityVersion
          );
        } catch {
          return failed('context_history_quota');
        }
        const token = Object.freeze({});
        const entry = {
          id: 'hph_' + randomUUID().replace(/-/g, ''),
          version: historyVersion,
          ...(historyVersion === 3 ? { rootId } : {}),
          protocol: scope.protocol,
          createdAt: time,
          owner,
          parent: prior,
          prefix,
          tail,
          offset: window?.count ?? history.length,
          ...(window ? { window } : {}),
          bytes,
          expiresAt: prior?.expiresAt ?? time + entryTtlMs,
          active: true,
          committed: false,
          callIds,
        };
        capabilities.set(token, entry);
        entryTokens.set(entry, token);
        retained.add(entry);
        retainedBytes += bytes;
        return { ok: true, token };
      } catch {
        return failed('context_history_invalid_input');
      }
    },
    commit(token, clientOutput) {
      if (clock() === null) return failed();
      const entry = get(token, false);
      if (!entry) return failed();
      try {
        const output = items(clientOutput, 128);
        verifyPublicHistoryReferences(entry.tail, output);
        const window = entry.window ? publishPublicWindow(entry.window, output) : null;
        const prefix = window
          ? []
          : [...entry.prefix, ...output.map((item) => historyDigest(entry.protocol, item))];
        const bytes = historyEntryBytes(entry.tail, prefix, window);
        if (!output.length) throw new TypeError('Invalid history commit');
        validatePrivateHistoryUsage(
          [...retained].map((item) => (item === entry ? { ...entry, bytes } : item)),
          capacityVersion
        );
        retainedBytes += bytes - entry.bytes;
        entry.prefix = prefix;
        if (window) entry.window = window;
        entry.bytes = bytes;
        entry.committed = true;
        return { ok: true, snapshot: token };
      } catch {
        remove(entry);
        return failed('context_history_commit_failed');
      }
    },
    rebuild({ scope, snapshot, clientHistory, historyFormat = 2 }) {
      if (clock() === null) return failed();
      const entry = get(snapshot);
      if (!entry) return failed();
      try {
        const history = items(clientHistory, 16384, historyFormat);
        if (entry.owner !== scopeDigest(scope)) return failed('context_history_conflict');
        const chain = [];
        for (let current = entry; current; current = current.parent) chain.unshift(current);
        if (
          chain.some((current) =>
            current.window
              ? !matchesPublicWindow(current.window, current.offset, history)
              : !matches(current.prefix, history, current.protocol)
          )
        )
          return failed('context_history_conflict');
        const result = [];
        const consumed = new Set();
        const appendPublic = (start, end) => {
          for (let index = start; index < end; index++)
            if (!consumed.has(index)) result.push(history[index]);
        };
        let offset = 0;
        for (const current of chain) {
          appendPublic(offset, current.offset);
          const outputCount = (current.window?.count ?? current.prefix.length) - current.offset;
          const output = history.slice(current.offset, current.offset + outputCount);
          verifyPublicHistoryReferences(current.tail, output);
          for (const item of current.tail) {
            if (isPublicHistoryReference(item)) {
              const position = current.offset + item.index;
              if (consumed.has(position)) throw new TypeError('Duplicate public reference');
              consumed.add(position);
              result.push(history[position]);
            } else result.push(item);
          }
          offset = current.offset;
        }
        appendPublic(offset, history.length);
        return { ok: true, history: items(result, 16384, historyFormat) };
      } catch {
        return failed('context_history_invalid_input');
      }
    },
    abort(token) {
      const entry = get(token, false);
      if (entry) remove(entry);
    },
    discard(token) {
      const entry = token && capabilities.get(token);
      if (entry?.active) remove(entry);
    },
    revoke(scope) {
      let owner;
      try {
        owner = scopeDigest(scope);
      } catch {
        return;
      }
      for (const entry of retained) if (entry.owner === owner) remove(entry);
    },
    inspect() {
      clock();
      return {
        closed,
        entries: retained.size,
        retainedBytes,
        maxBytes: (capacityVersion === 2 ? 32 : 4) * 1024 * 1024,
      };
    },
    close() {
      closed = true;
      for (const entry of retained) remove(entry);
    },
  };
  adoptionStates.set(map, {
    prepare(sourceMap) {
      const source = adoptionStates.get(sourceMap);
      if (!source || sourceMap === map || clock() === null) throw historyStateFailure();
      const incoming = source.copy();
      const copied = new Map();
      const entries = incoming.entries.map(({ entry, token }) => {
        const parent = entry.parent === null ? null : copied.get(entry.parent.id);
        if (entry.parent !== null && !parent) throw historyStateFailure();
        const clone = { ...entry, prefix: [...entry.prefix], tail: [...entry.tail], parent };
        copied.set(entry.id, clone);
        return { entry: clone, token };
      });
      const bytes = entries.reduce((total, item) => total + item.entry.bytes, 0);
      const check = () => {
        const ids = new Set([...retained].map((entry) => entry.id));
        if (closed || entries.some(({ entry }) => ids.has(entry.id))) throw historyStateFailure();
        validatePrivateHistoryUsage(
          [...retained, ...entries.map((item) => item.entry)],
          capacityVersion
        );
      };
      check();
      let committed = false;
      return {
        check,
        commit() {
          if (committed) throw historyStateFailure();
          committed = true;
          // Synchronous owner commit only: never invoke a clock or callback.
          for (const { entry, token } of entries) {
            capabilities.set(token, entry);
            entryTokens.set(entry, token);
            retained.add(entry);
          }
          retainedBytes += bytes;
          lastTime = Math.max(lastTime, incoming.observedAt);
        },
      };
    },
    copy() {
      if (clock() === null || [...retained].some((entry) => !entry.committed))
        throw historyStateFailure();
      return {
        observedAt: lastTime,
        entries: [...retained].map((entry) => ({ entry, token: entryTokens.get(entry) })),
      };
    },
  });
  transfers.set(map, (scope, tokens) => {
    if (clock() === null) throw historyStateFailure();
    const owner = scopeDigest(scope);
    if (
      !Array.isArray(tokens) ||
      Object.getPrototypeOf(tokens) !== Array.prototype ||
      tokens.length > maximumTips ||
      Reflect.ownKeys(tokens).length !== tokens.length + 1
    )
      throw historyStateFailure();
    const selected = new Map(),
      tips = [];
    for (let index = 0; index < tokens.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(tokens, String(index));
      if (!slot || !Object.hasOwn(slot, 'value')) throw historyStateFailure();
      const entry = get(slot.value);
      if (!entry || entry.owner !== owner || entry.protocol !== scope.protocol)
        throw historyStateFailure();
      const chain = [];
      for (let current = entry; current; current = current.parent) chain.unshift(current);
      for (const current of chain) selected.set(current.id, current);
      tips.push(entry.id);
    }
    const referenceFormat = [...selected.values()].some((entry) =>
      entry.tail.some(isPublicHistoryReference)
    );
    const windowFormat = referenceFormat || [...selected.values()].some((entry) => entry.window);
    const selectedVersions = new Set([...selected.values()].map((entry) => entry.version));
    const selectedRoots = new Set(
      [...selected.values()].filter((entry) => entry.version === 3).map((entry) => entry.rootId)
    );
    if (selectedVersions.size > 1 || selectedRoots.size > 1) throw historyStateFailure();
    const version = selectedVersions.values().next().value ?? 1;
    const state = {
      ...(windowFormat ? { format: referenceFormat ? 3 : 2 } : {}),
      version,
      ...(version === 3 ? { rootId: selectedRoots.values().next().value } : {}),
      kind: 'history-map',
      owner,
      protocol: scope.protocol,
      observedAt: lastTime,
      tips,
      entries: [...selected.values()].map((entry) => ({
        id: entry.id,
        parentId: entry.parent?.id ?? null,
        prefix: entry.prefix,
        tail: entry.tail,
        offset: entry.offset,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        ...(windowFormat ? { window: entry.window ?? null } : {}),
      })),
    };
    return parseContextHistoryState(state, owner, scope.protocol, validateTail, maximumTips).state;
  });
  if (restored) {
    try {
      lastTime = restored.observedAt;
      if (clock() === null) throw historyStateFailure();
      for (const [id, source] of restored.entries) {
        if (source.expiresAt <= lastTime) continue;
        const parent = source.parentId === null ? null : restored.liveEntries.get(source.parentId);
        if (source.parentId !== null && !parent) throw historyStateFailure();
        const entry = {
          ...source,
          parent,
          active: true,
          committed: true,
        };
        const token = Object.freeze({});
        capabilities.set(token, entry);
        entryTokens.set(entry, token);
        retained.add(entry);
        retainedBytes += entry.bytes;
        restored.liveEntries.set(id, entry);
        restored.snapshots.set(id, token);
      }
    } catch {
      map.close();
      throw historyStateFailure();
    }
  }
  return map;
}

function exportContextHistoryMap(map, inputScope, tokens) {
  try {
    const scope = normalizeCompactionData(inputScope, 4096);
    const transfer = transfers.get(map);
    if (!transfer) throw historyStateFailure();
    return transfer(scope, tokens);
  } catch {
    throw historyStateFailure();
  }
}

function prepareContextHistoryAdoption(target, source) {
  try {
    const state = adoptionStates.get(target);
    if (!state) throw historyStateFailure();
    return state.prepare(source);
  } catch {
    throw historyStateFailure();
  }
}

// Private owner-side import. The returned ID -> fresh token map is for trusted
// root reconstruction only; strings and old tokens remain unusable by rebuild.
function restoreContextHistoryMap(options, state) {
  try {
    const safe = restoreOptions(options, ['scope', 'now', 'maximumTips', 'capacityVersion']);
    return restoreContextHistoryRoots(
      {
        ...(safe.now === undefined ? {} : { now: safe.now }),
        maximumTips: safe.maximumTips,
        capacityVersion: safe.capacityVersion,
      },
      [{ scope: safe.scope, state }]
    );
  } catch {
    throw historyStateFailure();
  }
}

function restoreOptions(options, names) {
  if (!record(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
    throw historyStateFailure();
  const safe = {};
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!names.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw historyStateFailure();
    safe[key] = descriptor.value;
  }
  return safe;
}
function restoreContextHistoryRoots(options, input) {
  try {
    const safe = restoreOptions(options, ['now', 'ttlMs', 'maximumTips', 'capacityVersion']);
    if (safe.capacityVersion !== undefined && ![1, 2].includes(safe.capacityVersion))
      throw historyStateFailure();
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > 4 ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      throw historyStateFailure();
    const roots = [];
    for (let index = 0; index < input.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(input, String(index));
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw historyStateFailure();
      const root = restoreOptions(slot.value, ['scope', 'state']);
      roots.push({ scope: normalizeCompactionData(root.scope, 4096), state: root.state });
    }
    const restored = {
      observedAt: 0,
      entries: new Map(),
      liveEntries: new Map(),
      snapshots: new Map(),
    };
    const metadata = [];
    const legacyRoots = [];
    let hasDaily = false;
    let encodedBytes = 2 + Math.max(0, roots.length - 1);
    for (const root of roots) {
      if (!record(root) || Object.keys(root).sort().join(',') !== 'scope,state')
        throw historyStateFailure();
      const parsed = parseContextHistoryState(
        root.state,
        scopeDigest(root.scope),
        root.scope.protocol,
        validateTail,
        safe.maximumTips
      );
      // Each root keeps its existing versioned byte/depth/node admission.
      // Do not spend one root's node allowance across all four roots or clone
      // every private payload twice. The serialized batch still has its old
      // 48 MiB ceiling, including scope metadata and array/wrapper overhead.
      encodedBytes += Buffer.byteLength(JSON.stringify({ scope: root.scope, state: parsed.state }));
      if (encodedBytes > 48 * 1024 * 1024) throw historyStateFailure();
      if (parsed.state.version !== 3) legacyRoots.push({ scope: root.scope, state: parsed.state });
      restored.observedAt = Math.max(restored.observedAt, parsed.state.observedAt);
      hasDaily ||= parsed.state.version === 3;
      for (const [id, entry] of parsed.entries) {
        if (restored.entries.has(id)) throw historyStateFailure();
        restored.entries.set(id, {
          ...entry,
          owner: parsed.state.owner,
          protocol: parsed.state.protocol,
          version: parsed.state.version,
          ...(parsed.state.version === 3 ? { rootId: parsed.state.rootId } : {}),
        });
        metadata.push(restored.entries.get(id));
      }
    }
    // Legacy roots retain their original shared batch node/depth admission.
    // Only v3 receives an independent per-root node allowance.
    if (legacyRoots.length) normalizeRecoveryStateData(legacyRoots, 48 * 1024 * 1024);
    const capacityVersion = safe.capacityVersion ?? (hasDaily ? 2 : 1);
    validatePrivateHistoryUsage(metadata, capacityVersion);
    const historyMap = createHistoryMap(
      {
        now: safe.now === undefined ? Date.now : safe.now,
        ttlMs: safe.ttlMs,
        maximumTips: safe.maximumTips,
        capacityVersion,
      },
      restored
    );
    return { historyMap, snapshots: restored.snapshots };
  } catch {
    throw historyStateFailure();
  }
}

module.exports = {
  createContextHistoryMap,
  exportContextHistoryMap,
  restoreContextHistoryMap,
  restoreContextHistoryRoots,
  prepareContextHistoryAdoption,
};
