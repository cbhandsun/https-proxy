'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const {
  normalizeRecoveryHistoryRequest,
  recoveryHistoryRequestBytes,
  recoveryHistoryRequestLimit,
} = require('./context-recovery-history-request');
const { selectContextBinding, indexBindingSnapshots } = require('./context-binding-selection');
const { selectBindingWindow, publishBindingWindow } = require('./context-binding-window');
const { canonicalBindingData: canonical } = require('./context-public-window');
const { createBindingFrontierCache } = require('./context-binding-frontiers');
const { recoveryHistoryIdentity } = require('./context-recovery-claude-identity');
const { codexToolInventory, codexToolsIdentityFormat } = require('./context-recovery-codex-tools');
const {
  observedResponsesEcho,
  publishedBindingFrontiers,
} = require('./context-responses-observed-echo');
const { isClaudeSummaryReceipt } = require('./context-recovery-claude-summary');
const {
  isCodexSummaryRequest,
  isCodexSummaryReceipt,
} = require('./context-recovery-codex-summary');
const {
  bindingStateFailure,
  parseContextBindingState,
} = require('./context-recovery-binding-state');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 16384;
const { LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS } = require('./context-recovery-limits');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const failure = (code) => ({ ok: false, code });
const transfers = new WeakMap();
const adoptionStates = new WeakMap();

// Sort validated JSON object keys, preserving array order and every field.
// This produces equality fingerprints, not a semantic similarity index.
function observedAnchor(item) {
  if (item.type === 'compaction') {
    return typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
  }
  if (
    item.role !== 'assistant' &&
    !['message', 'function_call', 'custom_tool_call'].includes(item.type)
  )
    return false;
  if (identity(item.id) || identity(item.call_id)) return true;
  if (
    Array.isArray(item.tool_calls) &&
    item.tool_calls.some((call) => record(call) && identity(call.id))
  )
    return true;
  return (
    Array.isArray(item.content) &&
    item.content.some((block) => record(block) && block.type === 'tool_use' && identity(block.id))
  );
}

function requestData(
  input,
  inheritedScope,
  seeds,
  historyFormat = 2,
  frontiers = createBindingFrontierCache()
) {
  const value = normalizeRecoveryHistoryRequest(input, historyFormat);
  const identityFormat = codexToolsIdentityFormat(value.protocol, value.policy);
  if (identityFormat && value.history.length) {
    const inventory = codexToolInventory(value.history);
    if (!inventory || canonical(inventory) !== canonical(value.policy.codexAdditionalTools))
      throw new TypeError('Invalid context binding tool policy');
  }
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        !['principal', 'protocol', 'target', 'policy', 'history', 'previousResponseId'].includes(
          key
        )
    ) ||
    !identity(value.principal) ||
    !identity(value.target) ||
    !['chat', 'responses', 'claude'].includes(value.protocol) ||
    !Array.isArray(value.history) ||
    value.history.length > MAX_ITEMS ||
    !value.history.every(record) ||
    (value.previousResponseId !== undefined && !identity(value.previousResponseId))
  ) {
    throw new TypeError('Invalid context binding request');
  }
  const scope =
    inheritedScope ??
    digest(canonical([value.principal, value.protocol, value.target, value.policy ?? null]));
  // Compact requests omit generation tool schemas. Only this separate index
  // may locate their already observed input; ordinary reads remain full-policy scoped.
  const continuityScope = digest(
    canonical([
      value.principal,
      value.protocol,
      value.target,
      value.policy?.instructions ?? null,
      value.policy?.system ?? null,
    ])
  );
  const { frontier, continuityFrontier, prefixes, continuityPrefixes } = frontiers.calculate({
    scope,
    continuityScope,
    seeds,
    protocol: value.protocol,
    history: value.history,
    identityFormat,
  });
  const codexSummary =
    value.protocol === 'responses' &&
    isCodexSummaryRequest(
      {
        input: value.history,
        ...(value.policy?.tools == null ? {} : { tools: value.policy.tools }),
        tool_choice: value.policy?.toolChoice,
        ...(value.previousResponseId === undefined ||
        isCodexSummaryReceipt(value.previousResponseId)
          ? {}
          : { previous_response_id: value.previousResponseId }),
      },
      historyFormat
    );
  return {
    ...(identityFormat ? { identityFormat } : {}),
    scope,
    frontier,
    prefixes,
    continuityScope,
    continuityFrontier,
    continuityPrefixes,
    policyFingerprint: digest(canonical(value.policy ?? null)),
    codexSummary,
    compactionPolicyOmitted:
      (!identityFormat || codexSummary) &&
      ((value.policy?.tools == null && value.policy?.toolChoice == null) || codexSummary),
    protocol: value.protocol,
    count: value.history.length,
    bytes: recoveryHistoryRequestBytes(value),
    previousResponseId: value.previousResponseId,
  };
}

// Stores only fingerprints and causal metadata. Capabilities are in-process
// object identities; arbitrary wire labels cannot select a saved conversation.
function createContextBindingRegistry(options = {}) {
  return createRegistry(restoreOptions(options, ['now', 'maxSnapshots', 'ttlMs', 'historyFormat']));
}

function createRegistry(
  { now = Date.now, maxSnapshots = 256, ttlMs = LEGACY_RECOVERY_TTL_MS, historyFormat = 2 } = {},
  restored
) {
  if (
    ![2, 3].includes(historyFormat) ||
    typeof now !== 'function' ||
    ![LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS].includes(ttlMs) ||
    !Number.isSafeInteger(maxSnapshots) ||
    maxSnapshots < 1 ||
    maxSnapshots > 4096
  ) {
    throw new TypeError('Invalid context binding configuration');
  }
  const snapshots = new Map();
  const windows = new Map();
  const compactionInputs = new Map();
  const responses = new Map();
  const summaryResponses = new Map();
  const claims = new WeakMap();
  const frontiers = createBindingFrontierCache();
  let lastTime = 0;
  let nextExpiryAt = Infinity;
  let closed = false;
  const requestFormat = () =>
    historyFormat === 3 || [...snapshots.values()].some((snapshot) => snapshot.historyFormat === 3)
      ? 3
      : 2;

  function clock() {
    let time;
    try {
      time = now();
    } catch {
      time = null;
    }
    if (
      !Number.isSafeInteger(time) ||
      time < lastTime ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - RECOVERY_TTL_MS
    ) {
      closed = true;
      snapshots.clear();
      frontiers.clear();
      windows.clear();
      compactionInputs.clear();
      responses.clear();
      summaryResponses.clear();
      return null;
    }
    lastTime = time;
    // Every call still checks the clock. Only expiry/index housekeeping waits
    // for the earliest private deadline; rollback is unindexed and withdraw
    // removes its own indexes synchronously.
    if (time < nextExpiryAt) return time;
    nextExpiryAt = Infinity;
    for (const [id, snapshot] of snapshots)
      if (time >= snapshot.expiresAt) {
        snapshots.delete(id);
        frontiers.clear();
      } else nextExpiryAt = Math.min(nextExpiryAt, snapshot.expiresAt);
    for (const index of [windows, compactionInputs, responses, summaryResponses]) {
      for (const [key, ids] of index) {
        for (const id of ids) if (!snapshots.has(id)) ids.delete(id);
        if (!ids.size) index.delete(key);
      }
    }
    return time;
  }

  function add(index, key, id) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(id);
  }

  function claim(token) {
    if (closed || clock() === null || !record(token)) return null;
    const id = claims.get(token);
    return id ? (snapshots.get(id) ?? null) : null;
  }

  function ancestry(snapshot) {
    const ids = [];
    let parent = snapshot.parentId;
    while (parent) {
      const ancestor = snapshots.get(parent);
      if (!ancestor || !ancestor.committed || ancestor.scope !== snapshot.scope) {
        return failure('context_binding_ancestor_unavailable');
      }
      ids.push(ancestor.id);
      parent = ancestor.parentId;
    }
    return { ok: true, snapshotIds: ids };
  }

  function publish(token, output, responseId, compaction) {
    const snapshot = claim(token);
    if (!snapshot || snapshot.committed) return failure('context_binding_stale');
    const ancestors = ancestry(snapshot);
    if (!ancestors.ok) return ancestors;
    let items, window;
    try {
      items = normalizeCompactionData(output, MAX_BYTES);
      if (
        !Array.isArray(items) ||
        !items.length ||
        !items.every(record) ||
        items.length + snapshot.count > MAX_ITEMS ||
        Buffer.byteLength(canonical(items)) + snapshot.bytes >
          recoveryHistoryRequestLimit(snapshot.historyFormat) ||
        (responseId !== undefined && !identity(responseId)) ||
        (compaction && !items.some((item) => item.type === 'compaction' && observedAnchor(item)))
      ) {
        throw new TypeError('invalid');
      }
      window = publishBindingWindow(snapshot.window, items.length, compaction);
    } catch {
      return failure('invalid_context_binding_output');
    }
    // A standalone native compaction replaces its input window, unlike an
    // ordinary completion that appends output. Neither path rewrites a block.
    let frontier = compaction ? snapshot.scope : snapshot.frontier;
    let continuityFrontier = compaction ? snapshot.continuityScope : snapshot.continuityFrontier;
    for (const item of items)
      frontier = digest(
        frontier + '\0' + canonical(recoveryHistoryIdentity(snapshot.protocol, item))
      );
    for (const item of items)
      continuityFrontier = digest(
        continuityFrontier + '\0' + canonical(recoveryHistoryIdentity(snapshot.protocol, item))
      );
    snapshot.committed = true;
    snapshot.window = window;
    snapshot.publishedFrontier = frontier;
    snapshot.publishedContinuityFrontier = continuityFrontier;
    if (
      snapshot.protocol === 'responses' &&
      !compaction &&
      items.some(
        (item) =>
          Object.hasOwn(item, 'metadata') ||
          Object.hasOwn(item, 'internal_chat_message_metadata_passthrough')
      )
    ) {
      const echo = observedResponsesEcho(items);
      if (echo) {
        let echoFrontier = snapshot.frontier;
        let echoContinuityFrontier = snapshot.continuityFrontier;
        for (const item of echo) {
          const encoded = canonical(item);
          echoFrontier = digest(echoFrontier + '\0' + encoded);
          echoContinuityFrontier = digest(echoContinuityFrontier + '\0' + encoded);
        }
        snapshot.echoFrontier = echoFrontier;
        snapshot.echoContinuityFrontier = echoContinuityFrontier;
      }
    }
    snapshot.responseKey =
      responseId === undefined ? null : digest(snapshot.scope + '\0' + responseId);
    if (snapshot.protocol === 'responses' && isCodexSummaryReceipt(responseId))
      snapshot.summaryResponseKey = digest(snapshot.continuityScope + '\0' + responseId);
    // Plain output may continue a fully observed anchored window. Inherited
    // identity alone is insufficient: incremental response-ID requests may omit
    // that window and must not turn plain text into a global lookup identity.
    snapshot.anchored = snapshot.anchoredPrefix || items.some(observedAnchor);
    if (snapshot.anchored) {
      for (const value of publishedBindingFrontiers(snapshot)) add(windows, value, snapshot.id);
      for (const value of publishedBindingFrontiers(snapshot, true))
        add(compactionInputs, value, snapshot.id);
    }
    if (responseId !== undefined)
      add(responses, digest(snapshot.scope + '\0' + responseId), snapshot.id);
    if (snapshot.summaryResponseKey)
      add(summaryResponses, snapshot.summaryResponseKey, snapshot.id);
    return { ok: true, snapshotId: snapshot.id };
  }

  function begin(input, compaction = false) {
    const time = clock();
    if (closed || time === null) return failure('context_binding_unavailable');
    let data;
    try {
      data = requestData(input, undefined, undefined, requestFormat(), frontiers);
    } catch {
      return failure('invalid_context_binding');
    }
    if (snapshots.size >= maxSnapshots) return failure('context_binding_quota');
    const selected = selectContextBinding(
      data,
      { snapshots, windows, compactionInputs, responses, summaryResponses },
      compaction
    );
    if (!selected.ok) return selected;
    const { parent, reason } = selected;
    const selectedFormat = parent?.historyFormat ?? historyFormat;
    if (data.bytes > recoveryHistoryRequestLimit(selectedFormat))
      return failure('invalid_context_binding');
    const summaryContinuation =
      (data.protocol === 'claude' &&
        isClaudeSummaryReceipt(data.previousResponseId) &&
        !selected.observedSummaryDescendant) ||
      (data.protocol === 'responses' && isCodexSummaryReceipt(data.previousResponseId));
    if (compaction) data = requestData(input, parent.scope, undefined, selectedFormat, frontiers);
    const fullPrefix = Boolean(
      parent &&
      publishedBindingFrontiers(parent).some((frontier) => data.prefixes.includes(frontier))
    );
    const selectedWindow = selectBindingWindow({
      count: data.count,
      hasPrevious: data.previousResponseId !== undefined && !summaryContinuation,
      fullPrefix,
      parentCount: parent?.window?.count ?? null,
    });
    const window = summaryContinuation ? { kind: 'summary', count: data.count } : selectedWindow;
    if (!compaction && window.kind === 'delta')
      data = requestData(
        input,
        undefined,
        {
          frontier: parent.publishedFrontier,
          continuityFrontier: parent.publishedContinuityFrontier,
        },
        selectedFormat,
        frontiers
      );
    // Ambiguous histories get a fresh isolated branch, never a union of
    // evidence from candidates or a fallback to a shorter matching prefix.
    const id = 'hbs_' + randomUUID().replace(/-/g, '');
    const token = Object.freeze({});
    snapshots.set(id, {
      id,
      historyFormat: selectedFormat,
      ...(data.identityFormat ? { identityFormat: data.identityFormat } : {}),
      protocol: data.protocol,
      parentId: parent?.id ?? null,
      anchoredPrefix: Boolean(
        parent?.anchored && (fullPrefix || window.kind === 'delta' || summaryContinuation)
      ),
      window,
      scope: data.scope,
      frontier: data.frontier,
      continuityScope: data.continuityScope,
      continuityFrontier: data.continuityFrontier,
      policyFingerprint: compaction ? parent.policyFingerprint : data.policyFingerprint,
      count: data.count,
      bytes: data.bytes,
      createdAt: time,
      expiresAt: time + (parent ? parent.expiresAt - parent.createdAt : ttlMs),
      committed: false,
    });
    nextExpiryAt = Math.min(nextExpiryAt, snapshots.get(id).expiresAt);
    claims.set(token, id);
    return Object.freeze({
      ok: true,
      token,
      snapshotId: id,
      parentSnapshotId: parent?.id ?? null,
      reason,
      summaryContinuation,
      historyFormat: selectedFormat,
      policyFingerprint: compaction ? parent.policyFingerprint : data.policyFingerprint,
    });
  }
  const registry = {
    begin,
    beginCompaction(input) {
      return begin(input, true);
    },
    commit(token, output, responseId) {
      return publish(token, output, responseId, false);
    },
    commitCompaction(token, canonicalWindow) {
      return publish(token, canonicalWindow, undefined, true);
    },
    ancestors(token) {
      const snapshot = claim(token);
      if (!snapshot) return failure('context_binding_stale');
      return ancestry(snapshot);
    },
    publicWindow(token) {
      const snapshot = claim(token);
      if (!snapshot || snapshot.committed || snapshot.window.count === null) return null;
      return {
        scope: snapshot.scope,
        frontier: snapshot.frontier,
        count: snapshot.window.count,
        publishedFrontier: null,
      };
    },
    rollback(token) {
      const snapshot = claim(token);
      if (!snapshot || snapshot.committed) return false;
      snapshots.delete(snapshot.id);
      claims.delete(token);
      return true;
    },
    withdraw(token) {
      const snapshot = claim(token);
      if (!snapshot) return [];
      const removed = new Set([snapshot.id]);
      for (const item of snapshots.values()) {
        if (removed.has(item.parentId)) removed.add(item.id);
      }
      for (const id of removed) snapshots.delete(id);
      for (const index of [windows, compactionInputs, responses, summaryResponses]) {
        for (const [key, ids] of index) {
          for (const id of removed) ids.delete(id);
          if (!ids.size) index.delete(key);
        }
      }
      return [...removed];
    },
    inspect() {
      clock();
      return {
        closed,
        snapshots: snapshots.size,
        committed: [...snapshots.values()].filter((snapshot) => snapshot.committed).length,
      };
    },
    close() {
      closed = true;
      snapshots.clear();
      frontiers.clear();
      windows.clear();
      compactionInputs.clear();
      responses.clear();
      summaryResponses.clear();
    },
  };
  adoptionStates.set(registry, {
    probe(input, additional, compaction) {
      if (typeof compaction !== 'boolean') throw bindingStateFailure();
      if (
        !Array.isArray(additional) ||
        Object.getPrototypeOf(additional) !== Array.prototype ||
        additional.length > 4 ||
        Reflect.ownKeys(additional).length !== additional.length + 1
      )
        throw bindingStateFailure();
      let data;
      try {
        data = requestData(input, undefined, undefined, 3, frontiers);
      } catch {
        return failure('invalid_context_binding');
      }
      const incoming = [];
      const seen = new Set([registry]);
      for (let index = 0; index < additional.length; index++) {
        const slot = Object.getOwnPropertyDescriptor(additional, String(index));
        if (!slot?.enumerable || !Object.hasOwn(slot, 'value') || seen.has(slot.value))
          throw bindingStateFailure();
        const source = adoptionStates.get(slot.value);
        if (!source) throw bindingStateFailure();
        seen.add(slot.value);
        incoming.push(source.copy());
      }
      const time = clock();
      if (closed || time === null) return failure('context_binding_unavailable');
      const combined = new Map(snapshots);
      for (const group of incoming) {
        const retained = new Set();
        for (const snapshot of group.snapshots) {
          if (combined.has(snapshot.id)) throw bindingStateFailure();
          if (
            snapshot.expiresAt <= time ||
            (snapshot.parentId !== null && !retained.has(snapshot.parentId))
          )
            continue;
          retained.add(snapshot.id);
          combined.set(snapshot.id, snapshot);
        }
      }
      const selected = selectContextBinding(data, indexBindingSnapshots(combined), compaction);
      if (!selected.ok) return selected;
      if (data.bytes > recoveryHistoryRequestLimit(selected.parent?.historyFormat ?? historyFormat))
        return failure('invalid_context_binding');
      let root = selected.parent;
      while (root?.parentId) {
        root = combined.get(root.parentId);
        if (!root) return failure('context_binding_ancestor_unavailable');
      }
      return Object.freeze({
        ok: true,
        reason: selected.reason,
        parentSnapshotId: selected.parent?.id ?? null,
        rootSnapshotId: root?.id ?? null,
        policyFingerprint: compaction ? selected.parent.policyFingerprint : data.policyFingerprint,
      });
    },
    prepare(sourceRegistry) {
      const source = adoptionStates.get(sourceRegistry);
      if (!source || sourceRegistry === registry || closed || clock() === null)
        throw bindingStateFailure();
      const incoming = source.copy();
      const check = () => {
        if (
          closed ||
          snapshots.size + incoming.snapshots.length > maxSnapshots ||
          incoming.snapshots.some((snapshot) => snapshots.has(snapshot.id))
        )
          throw bindingStateFailure();
      };
      check();
      let committed = false;
      return {
        check,
        commit() {
          if (committed) throw bindingStateFailure();
          committed = true;
          // Owner checks every participant immediately before this synchronous
          // commit. No clock, input callback, await or external code runs here.
          for (const snapshot of incoming.snapshots) {
            snapshots.set(snapshot.id, snapshot);
            nextExpiryAt = Math.min(nextExpiryAt, snapshot.expiresAt);
            if (snapshot.anchored) {
              for (const frontier of publishedBindingFrontiers(snapshot))
                add(windows, frontier, snapshot.id);
              for (const frontier of publishedBindingFrontiers(snapshot, true))
                add(compactionInputs, frontier, snapshot.id);
            }
            if (snapshot.responseKey !== null) add(responses, snapshot.responseKey, snapshot.id);
            if (snapshot.summaryResponseKey)
              add(summaryResponses, snapshot.summaryResponseKey, snapshot.id);
          }
          lastTime = Math.max(lastTime, incoming.observedAt);
        },
      };
    },
    copy() {
      if (closed || clock() === null || [...snapshots.values()].some((item) => !item.committed))
        throw bindingStateFailure();
      return {
        observedAt: lastTime,
        snapshots: [...snapshots.values()].map((item) => ({ ...item })),
      };
    },
  });
  transfers.set(registry, (rootId) => {
    if (closed || clock() === null) throw bindingStateFailure();
    const root = typeof rootId === 'string' ? snapshots.get(rootId) : null;
    if (!root?.committed || root.parentId !== null) throw bindingStateFailure();
    const selected = new Set();
    const retained = [];
    for (const snapshot of snapshots.values()) {
      if (snapshot.committed && (snapshot.id === rootId || selected.has(snapshot.parentId))) {
        selected.add(snapshot.id);
        const {
          historyFormat: _historyFormat,
          identityFormat: _identityFormat,
          ...serialized
        } = snapshot;
        retained.push(serialized);
      }
    }
    return parseContextBindingState(
      {
        version: root.expiresAt - root.createdAt === RECOVERY_TTL_MS ? 2 : 1,
        kind: 'binding-root',
        format: root.historyFormat,
        ...(root.identityFormat ? { identityFormat: root.identityFormat } : {}),
        observedAt: lastTime,
        rootId,
        protocol: root.protocol,
        scope: root.scope,
        continuityScope: root.continuityScope,
        policyFingerprint: root.policyFingerprint,
        snapshots: retained,
      },
      root,
      maxSnapshots
    );
  });
  if (restored) {
    try {
      lastTime = restored.observedAt;
      if (clock() === null) throw bindingStateFailure();
      // An expired root invalidates its whole tree even when a later child has
      // a newer local expiry. No ancestor may be silently detached on restore.
      for (const state of restored.states) {
        if (state.snapshots[0].expiresAt <= lastTime) continue;
        for (const source of state.snapshots) {
          const snapshot = {
            ...source,
            historyFormat: state.format === 3 ? 3 : 2,
            ...(state.identityFormat ? { identityFormat: state.identityFormat } : {}),
            window: source.window ?? { kind: 'unavailable', count: null },
          };
          snapshots.set(snapshot.id, snapshot);
          nextExpiryAt = Math.min(nextExpiryAt, snapshot.expiresAt);
          const token = Object.freeze({});
          claims.set(token, snapshot.id);
          restored.tokens.set(snapshot.id, token);
          if (snapshot.anchored) {
            for (const frontier of publishedBindingFrontiers(snapshot))
              add(windows, frontier, snapshot.id);
            for (const frontier of publishedBindingFrontiers(snapshot, true))
              add(compactionInputs, frontier, snapshot.id);
          }
          if (snapshot.responseKey !== null) add(responses, snapshot.responseKey, snapshot.id);
          if (snapshot.summaryResponseKey)
            add(summaryResponses, snapshot.summaryResponseKey, snapshot.id);
        }
      }
    } catch {
      registry.close();
      throw bindingStateFailure();
    }
  }
  return registry;
}

function exportContextBindingRegistry(registry, rootId) {
  try {
    const transfer = transfers.get(registry);
    if (!transfer) throw bindingStateFailure();
    return transfer(rootId);
  } catch {
    throw bindingStateFailure();
  }
}

// Trusted owner transaction only. Serialized state must first pass the normal
// root importer; no raw JSON or caller-selected lookup becomes authority here.
function prepareContextBindingAdoption(target, source) {
  try {
    const state = adoptionStates.get(target);
    if (!state) throw bindingStateFailure();
    return state.prepare(source);
  } catch {
    throw bindingStateFailure();
  }
}

// Trusted admission probe. Additional registries must be privately restored,
// validated candidates. Returns causal IDs only; creates no claim or snapshot.
function probeContextBindingRegistry(registry, input, additional = [], compaction = false) {
  try {
    const state = adoptionStates.get(registry);
    if (!state) throw bindingStateFailure();
    return state.probe(input, additional, compaction);
  } catch {
    throw bindingStateFailure();
  }
}

// The authenticated root owner provides a current trusted binding basis. The
// returned tokens are fresh process capabilities, never decoded wire objects.
function restoreContextBindingRegistry(options, state) {
  try {
    const safe = restoreOptions(options, ['binding', 'now', 'maxSnapshots', 'historyFormat']);
    return restoreContextBindingRoots(
      {
        ...(safe.now === undefined ? {} : { now: safe.now }),
        ...(safe.maxSnapshots === undefined ? {} : { maxSnapshots: safe.maxSnapshots }),
        ...(safe.historyFormat === undefined ? {} : { historyFormat: safe.historyFormat }),
      },
      [{ binding: safe.binding, state }]
    );
  } catch {
    throw bindingStateFailure();
  }
}

function restoreOptions(options, names) {
  if (!record(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
    throw bindingStateFailure();
  const safe = {};
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!names.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw bindingStateFailure();
    safe[key] = descriptor.value;
  }
  return safe;
}
function restoreContextBindingRoots(options, input) {
  try {
    const safe = restoreOptions(options, ['now', 'maxSnapshots', 'ttlMs', 'historyFormat']);
    const maximum = safe.maxSnapshots === undefined ? 256 : safe.maxSnapshots;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
      throw bindingStateFailure();
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > 4 ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      throw bindingStateFailure();
    const roots = [];
    let aggregate = 2,
      extended = false;
    for (let index = 0; index < input.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(input, String(index));
      const wrapper = slot?.value;
      if (
        !slot?.enumerable ||
        !wrapper ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(wrapper)) ||
        Reflect.ownKeys(wrapper).sort().join(',') !== 'binding,state'
      )
        throw bindingStateFailure();
      const bindingSlot = Object.getOwnPropertyDescriptor(wrapper, 'binding');
      const stateSlot = Object.getOwnPropertyDescriptor(wrapper, 'state');
      if (
        !bindingSlot?.enumerable ||
        !Object.hasOwn(bindingSlot, 'value') ||
        !stateSlot?.enumerable ||
        !Object.hasOwn(stateSlot, 'value')
      )
        throw bindingStateFailure();
      const state = normalizeCompactionData(stateSlot.value, 2 * 1024 * 1024);
      const binding = normalizeRecoveryHistoryRequest(
        bindingSlot.value,
        state?.format === 3 ? 3 : 2
      );
      extended ||= state?.format === 3;
      aggregate +=
        recoveryHistoryRequestBytes(binding) +
        Buffer.byteLength(JSON.stringify(state)) +
        21 +
        (index ? 1 : 0);
      roots.push({ binding, state });
    }
    if (!extended && aggregate > 12 * 1024 * 1024) throw bindingStateFailure();
    const restored = { observedAt: 0, states: [], tokens: new Map() };
    const ids = new Set();
    for (const root of roots) {
      if (!record(root) || Object.keys(root).sort().join(',') !== 'binding,state')
        throw bindingStateFailure();
      const parsed = parseContextBindingState(
        root.state,
        requestData(root.binding, undefined, undefined, root.state?.format === 3 ? 3 : 2),
        maximum
      );
      restored.observedAt = Math.max(restored.observedAt, parsed.observedAt);
      for (const snapshot of parsed.snapshots) {
        if (ids.has(snapshot.id) || ids.size >= maximum) throw bindingStateFailure();
        ids.add(snapshot.id);
      }
      restored.states.push(parsed);
    }
    const registry = createRegistry(
      {
        now: safe.now === undefined ? Date.now : safe.now,
        maxSnapshots: maximum,
        ttlMs: safe.ttlMs,
        historyFormat: safe.historyFormat,
      },
      restored
    );
    return { registry, snapshots: restored.tokens };
  } catch {
    throw bindingStateFailure();
  }
}

module.exports = {
  createContextBindingRegistry,
  exportContextBindingRegistry,
  restoreContextBindingRegistry,
  restoreContextBindingRoots,
  prepareContextBindingAdoption,
  probeContextBindingRegistry,
};
