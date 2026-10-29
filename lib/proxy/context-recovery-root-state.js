'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const {
  normalizeRecoveryStateData,
  normalizeRecoveryReferenceData,
} = require('./context-recovery-state-data');
const { normalizeRecoveryHistoryRequest } = require('./context-recovery-history-request');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { validateRecoveryRootPolicy } = require('./context-recovery-root-policy');
const {
  RECOVERY_MAX_SNAPSHOTS,
  recoveryRootCapacity,
  recoveryRootOriginalBytes,
} = require('./context-recovery-capacity');
const {
  createRecoverySnapshotMap,
  createRecoverySnapshotSet,
  recoverySnapshotOwnEntries,
} = require('./context-recovery-snapshot-index');
const {
  parseRecoveryPendingResults,
  pendingResultsBytes,
  MAX_PENDING_RESULTS_BYTES,
} = require('./context-recovery-pending-results');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const { createRecoverySourcePolicyValidator } = require('./context-recovery-source-policy');
const { exportContextBindingRegistry, restoreContextBindingRoots } = require('./context-binding');
const { exportContextHistoryMap, restoreContextHistoryRoots } = require('./context-history-map');
const {
  exportContextEvidenceLedger,
  exportContextEvidenceMetadata,
  restoreContextEvidenceLedger,
  restoreOwnedContextEvidenceLedger,
} = require('./context-evidence-ledger');
const { admitRecoveryRoot } = require('./context-recovery-ledger-admission');
const { parseEvidenceLedgerMetadata } = require('./context-evidence-ledger-state');
const { parseContextBindingState } = require('./context-recovery-binding-state');
const {
  exportContextEvidenceBudget,
  restoreContextEvidenceBudget,
} = require('./context-evidence-tools');

const { RECOVERY_TTL_MS: TTL_MS } = require('./context-recovery-limits');
const { rootStateFailure } = require('./context-recovery-root-contract');
const MAX_STATE_BYTES = 12 * 1024 * 1024;
function rootData(input) {
  const version = input && Object.getOwnPropertyDescriptor(input, 'version')?.value;
  return version === 9 || version === 10
    ? normalizeRecoveryStateData(input)
    : normalizeCompactionData(input, MAX_STATE_BYTES);
}
const sha = (value) => createHash('sha256').update(value).digest('hex');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identity = (value, maximum = 256) =>
  typeof value === 'string' && new RegExp('^[A-Za-z0-9_.:-]{1,' + maximum + '}$').test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields
  )
    throw rootStateFailure();
}
function scope(state) {
  return {
    principal: state.principal,
    protocol: state.protocol,
    target: state.target,
    policy: state.policyFingerprint,
  };
}
function sourceDescriptor(source) {
  return Object.fromEntries(
    ['sourceId', 'callId', 'toolName', 'argumentsDigest', 'digest', 'bytes', 'expiresAt']
      .map((key) => [key, source[key]])
      .concat([['trust', 'tool_data_not_instructions']])
  );
}

// Trusted session-owner export only. Pending branches and their captures must
// not acquire authority merely because they share a root's backing ledger.
function partitionRecoveryRootState(
  root,
  registry,
  historyMap,
  snapshots,
  observedAt,
  exportLedger = exportContextEvidenceLedger
) {
  const binding = exportContextBindingRegistry(registry, root.id);
  const selected = binding.snapshots.map((entry) => {
    const snapshot = snapshots.get(entry.id);
    if (!snapshot || snapshot.root !== root) throw rootStateFailure();
    return snapshot;
  });
  const publicGenerationState = selected.some((snapshot) => snapshot.publicResponse === true);
  const tokens = selected.map((entry) => entry.mappingSnapshot).filter(Boolean);
  const history = exportContextHistoryMap(historyMap, root.mappingScope, tokens);
  const mappingIds = new Map(tokens.map((token, index) => [token, history.tips[index]]));
  const visible = new Set(
    selected.flatMap((snapshot) => [...recoverySnapshotOwnEntries(snapshot.visible)])
  );
  const ledger = exportLedger(root.ledger);
  const stagedSources = ledger.sources.filter((source) => !visible.has(source.sourceId));
  ledger.sources = ledger.sources.filter((source) => visible.has(source.sourceId));
  const views = binding.snapshots.map((entry, index) => {
    const snapshot = selected[index];
    return {
      id: entry.id,
      calls: [...recoverySnapshotOwnEntries(snapshot.calls)].map(([callId, call]) => ({
        callId,
        ...call,
      })),
      visible: [...recoverySnapshotOwnEntries(snapshot.visible)],
      captured: [...recoverySnapshotOwnEntries(snapshot.captured)].map(([callId, descriptor]) => ({
        callId,
        sourceId: descriptor.sourceId,
      })),
      mappingId: mappingIds.get(snapshot.mappingSnapshot) ?? null,
      privateHistoryComplete: snapshot.privateHistoryComplete === true,
      ...(publicGenerationState ? { publicResponse: snapshot.publicResponse === true } : {}),
      ...{
        pendingResults: parseRecoveryPendingResults(snapshot.pendingResults ?? []),
        pendingReady: snapshot.pendingReady !== false,
      },
    };
  });
  const state = rootData({
    ...(publicGenerationState ? { publicGenerationFormat: 1 } : {}),
    version:
      root.capacityVersion >= 8
        ? root.capacityVersion
        : binding.protocol === 'responses' &&
            binding.snapshots.some((entry) => entry.window?.kind === 'summary')
          ? 7
          : 6,
    kind: 'recovery-root',
    rootId: root.id,
    principal: root.principal,
    protocol: root.mappingScope.protocol,
    target: root.mappingScope.target,
    policyFingerprint: root.mappingScope.policy,
    policyBasis: root.policyBasis,
    createdAt: root.createdAt,
    expiresAt: root.expiresAt,
    observedAt: Math.max(observedAt, binding.observedAt, history.observedAt, ledger.observedAt),
    callCount: root.callCount,
    binding,
    history,
    ledger,
    budget: exportContextEvidenceBudget(root.budget),
    snapshots: views,
  });
  return { root: state, stagedSources };
}

function exportRecoveryRootState(...args) {
  return partitionRecoveryRootState(...args).root;
}

// One owner-held cut of the ledger supplies published and staged evidence.
// Budget checkpoints must not export/materialize every source a second time.
function exportRecoveryRootCheckpoint(...args) {
  const { root, stagedSources } = partitionRecoveryRootState(...args);
  return require('./context-recovery-root-checkpoint').createRootCheckpoint(root, stagedSources);
}

function exportRecoveryRootMetadata(root, registry, historyMap, snapshots, observedAt) {
  const state = partitionRecoveryRootState(
    root,
    registry,
    historyMap,
    snapshots,
    observedAt,
    exportContextEvidenceMetadata
  );
  const { version: sourceVersion, ...fields } = state.root;
  return {
    metadata: { ...fields, version: 1, kind: 'recovery-root-metadata', sourceVersion },
    stagedSources: state.stagedSources,
  };
}

// Validate associations after the existing component importers have checked
// their own policy, byte limits, ancestry, content hashes and private exchanges.
function linkRoot(state, ledger, budget, historyTokens, now, binding) {
  if (
    state.budget.successfulReads > state.ledger.readCount ||
    state.ledger.readCount > state.budget.calls
  )
    throw rootStateFailure();
  const sources = new Map(state.ledger.sources.map((source) => [source.sourceId, source]));
  const descriptors = new Map([...sources].map(([id, source]) => [id, sourceDescriptor(source)]));
  const root = {
    capacityVersion: state.version >= 8 ? state.version : 6,
    id: state.rootId,
    principal: state.principal,
    mappingScope: scope(state),
    policyBasis: state.version >= 2 ? state.policyBasis : (binding.policy ?? null),
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    ledger,
    budget,
    descriptors,
    mappingTokens: new Set(),
    callCount: state.callCount,
    active: true,
  };
  const snapshots = new Map(),
    usedSources = new Set(),
    usedMappings = new Set();
  const history = new Map(state.history.entries.map((entry) => [entry.id, entry]));
  const bindings = new Map(state.binding.snapshots.map((entry) => [entry.id, entry]));
  let callCount = 0,
    pendingBytes = 0;
  if (!Array.isArray(state.snapshots) || state.snapshots.length !== state.binding.snapshots.length)
    throw rootStateFailure();
  const expectedTips = state.snapshots.map((view) => view?.mappingId).filter((id) => id !== null);
  if (JSON.stringify(expectedTips) !== JSON.stringify(state.history.tips)) throw rootStateFailure();
  for (let index = 0; index < state.snapshots.length; index++) {
    const view = state.snapshots[index],
      bound = state.binding.snapshots[index];
    exact(
      view,
      state.publicGenerationFormat === 1
        ? 'calls,captured,id,mappingId,pendingReady,pendingResults,privateHistoryComplete,publicResponse,visible'
        : state.version >= 6
          ? 'calls,captured,id,mappingId,pendingReady,pendingResults,privateHistoryComplete,visible'
          : state.version >= 4
            ? 'calls,captured,id,mappingId,pendingReady,pendingResults,visible'
            : 'calls,captured,id,mappingId,visible'
    );
    const pendingResults =
      state.version >= 4 ? parseRecoveryPendingResults(view.pendingResults) : [];
    pendingBytes += pendingResultsBytes(pendingResults);
    if (
      pendingBytes > MAX_PENDING_RESULTS_BYTES ||
      (state.version >= 4 && typeof view.pendingReady !== 'boolean') ||
      (state.version >= 6 && typeof view.privateHistoryComplete !== 'boolean') ||
      (state.publicGenerationFormat === 1 &&
        (typeof view.publicResponse !== 'boolean' ||
          (view.publicResponse &&
            (bound.responseKey === null ||
              // A summary request window can be the input to an ordinary,
              // independently generated answer. Only a response carrying the
              // host summary receipt is itself a summary response. Native
              // compaction remains ineligible for public response ancestry.
              Object.hasOwn(bound, 'summaryResponseKey') ||
              bound.window?.kind === 'compaction' ||
              pendingResults.length > 0)))) ||
      (pendingResults.length && (state.protocol !== 'responses' || bound.responseKey === null))
    )
      throw rootStateFailure();
    const parent = snapshots.get(bound.parentId);
    const privateHistoryComplete =
      state.version >= 6 ? view.privateHistoryComplete : state.protocol !== 'responses';
    if (
      parent?.privateHistoryComplete === false &&
      privateHistoryComplete &&
      !['compaction', 'summary'].includes(bound.window?.kind)
    )
      throw rootStateFailure();
    if (
      view.id !== bound.id ||
      !Array.isArray(view.calls) ||
      view.calls.length > 128 ||
      !Array.isArray(view.captured) ||
      view.captured.length > recoveryRootCapacity(state.version).maxSources ||
      !Array.isArray(view.visible) ||
      view.visible.length !== view.captured.length ||
      new Set(view.visible).size !== view.visible.length
    )
      throw rootStateFailure();
    const calls = createRecoverySnapshotMap(parent?.calls),
      captured = createRecoverySnapshotMap(parent?.captured);
    const visible = createRecoverySnapshotSet(parent?.visible);
    for (const call of view.calls) {
      exact(call, 'argumentsDigest,callId,toolName');
      if (
        !identity(call.callId) ||
        !identity(call.toolName, 128) ||
        !digest(call.argumentsDigest) ||
        calls.has(call.callId) ||
        !parseCompletedEvidenceSource({
          callId: call.callId,
          toolName: call.toolName,
          arguments: {},
          completed: true,
          output: '',
        }).ok
      )
        throw rootStateFailure();
      calls.set(call.callId, { toolName: call.toolName, argumentsDigest: call.argumentsDigest });
      callCount++;
    }
    for (const entry of view.captured) {
      exact(entry, 'callId,sourceId');
      const call = parent?.calls.get(entry.callId),
        source = sources.get(entry.sourceId);
      if (
        !call ||
        captured.has(entry.callId) ||
        !source ||
        usedSources.has(entry.sourceId) ||
        !view.visible.includes(entry.sourceId) ||
        visible.has(entry.sourceId) ||
        source.callId !== 'hpa_' + sha(view.id + '\0' + entry.callId) ||
        source.toolName !== call.toolName ||
        source.argumentsDigest !== call.argumentsDigest ||
        source.createdAt < bound.createdAt ||
        source.createdAt >= state.expiresAt
      )
        throw rootStateFailure();
      captured.set(entry.callId, descriptors.get(entry.sourceId));
      visible.add(entry.sourceId);
      usedSources.add(entry.sourceId);
    }
    let mappingSnapshot;
    if (view.mappingId !== null) {
      const entry = history.get(view.mappingId);
      if (!entry || !state.history.tips.includes(view.mappingId)) throw rootStateFailure();
      mappingSnapshot = historyTokens.get(view.mappingId);
      if (view.mappingId !== parent?.mappingId) {
        if (
          usedMappings.has(view.mappingId) ||
          entry.parentId !==
            (bound.window?.kind === 'summary' ? null : (parent?.mappingId ?? null)) ||
          (entry.window
            ? !['full', 'delta', 'summary'].includes(bound.window?.kind) ||
              entry.window.scope !== bound.scope ||
              entry.window.frontier !== bound.frontier ||
              entry.window.publishedFrontier !== bound.publishedFrontier ||
              entry.window.count !== bound.window.count ||
              entry.offset !==
                (bound.window.kind === 'delta'
                  ? (bindings.get(bound.parentId)?.window?.count ?? -16385) + bound.count
                  : bound.count)
            : entry.offset !== bound.count) ||
          entry.createdAt < bound.createdAt
        )
          throw rootStateFailure();
        usedMappings.add(view.mappingId);
      }
      if (!mappingSnapshot && now < state.expiresAt) throw rootStateFailure();
      if (mappingSnapshot) root.mappingTokens.add(mappingSnapshot);
    }
    snapshots.set(view.id, {
      pendingResults,
      pendingReady: state.version < 4 || view.pendingReady,
      root,
      calls: calls.freeze(),
      captured: captured.freeze(),
      visible: visible.freeze(),
      mappingSnapshot,
      mappingId: view.mappingId,
      privateHistoryComplete,
      publicResponse: state.publicGenerationFormat === 1 && view.publicResponse,
    });
  }
  if (
    callCount > state.callCount ||
    usedSources.size !== sources.size ||
    usedMappings.size !== history.size
  )
    throw rootStateFailure();
  return { root, snapshots };
}

function parseRoot(
  input,
  binding,
  policyFingerprint = fingerprintContextData(binding.policy ?? null)
) {
  return validateParsedRoot(rootData(input), binding, policyFingerprint);
}

// Private semantic checks of this call's bounded clone. The reconstructed
// metadata root is shallower and smaller than its already normalized envelope;
// no external caller can bypass rootData or metadata envelope normalization.
function validateParsedRoot(state, binding, policyFingerprint) {
  validateRecoveryRootPolicy(state);
  if (
    state.kind !== 'recovery-root' ||
    !identity(state.principal) ||
    !identity(state.target) ||
    state.principal !== binding.principal ||
    state.protocol !== binding.protocol ||
    state.target !== binding.target ||
    state.policyFingerprint !== policyFingerprint ||
    !integer(state.createdAt) ||
    !integer(state.expiresAt) ||
    state.createdAt > Number.MAX_SAFE_INTEGER - TTL_MS ||
    !integer(state.observedAt) ||
    state.observedAt < state.createdAt ||
    state.observedAt >= state.expiresAt ||
    !integer(state.callCount) ||
    state.callCount > recoveryRootCapacity(state.version).maxCalls ||
    state.rootId !== state.binding?.rootId ||
    state.protocol !== state.binding?.protocol ||
    state.policyFingerprint !== state.binding?.policyFingerprint ||
    state.binding?.snapshots?.[0]?.createdAt < state.createdAt ||
    [state.binding, state.history, state.ledger].some(
      (part) => !integer(part?.observedAt) || part.observedAt > state.observedAt
    )
  )
    throw rootStateFailure();
  return state;
}

// Validate a distinct metadata envelope without restoring evidence payloads or
// returning registry tokens. Temporary association validators are always closed.
// This checks internal consistency only; current-request admission is separate.
function validateRecoveryRootMetadata(input) {
  let bindings, histories;
  try {
    const value = normalizeRecoveryReferenceData(input, MAX_STATE_BYTES);
    exact(value, 'metadata,stagedSources');
    const metadata = value.metadata;
    if (
      metadata?.kind !== 'recovery-root-metadata' ||
      metadata.version !== 1 ||
      !Array.isArray(value.stagedSources)
    )
      throw rootStateFailure();
    const { sourceVersion, ...fields } = metadata;
    const binding = {
      principal: metadata.principal,
      protocol: metadata.protocol,
      target: metadata.target,
      policy: metadata.policyBasis ?? null,
      history: [],
    };
    const state = validateParsedRoot(
      { __proto__: null, ...fields, kind: 'recovery-root', version: sourceVersion },
      binding,
      metadata.policyFingerprint
    );
    const ledger = parseEvidenceLedgerMetadata(
      {
        ...state.ledger,
        sources: [...state.ledger.sources, ...value.stagedSources].sort(
          (a, b) => a.createdAt - b.createdAt
        ),
      },
      sha(JSON.stringify([state.principal, state.rootId])),
      state.ledger.policy
    );
    // Validate published sources independently too: staged sources can never
    // satisfy a published snapshot's association or appear in its visible set.
    parseEvidenceLedgerMetadata(state.ledger, ledger.ownerBinding, ledger.policy);
    const time = state.observedAt;
    if (state.version === 1) {
      // v1 retains only policy fingerprints, not the original policy basis.
      // Check its stored ancestry without inventing a null request policy.
      // Actual adoption still requires the caller's original current policy.
      const parsed = parseContextBindingState(state.binding, state.binding, 256);
      if (parsed.rootId !== state.rootId) throw rootStateFailure();
    } else {
      bindings = restoreContextBindingRoots(
        { now: () => time, ttlMs: TTL_MS, maxSnapshots: RECOVERY_MAX_SNAPSHOTS },
        [{ binding, state: state.binding }]
      );
    }
    histories = restoreContextHistoryRoots(
      { now: () => time, ttlMs: TTL_MS, maximumTips: 512, capacityVersion: 2 },
      [{ scope: scope(state), state: state.history }]
    );
    const budget = restoreContextEvidenceBudget(state.budget);
    linkRoot(state, null, budget, histories.snapshots, time, binding);
    if (bindings && !bindings.snapshots.has(state.rootId)) throw rootStateFailure();
    return value;
  } catch {
    throw rootStateFailure();
  } finally {
    bindings?.registry.close();
    histories?.historyMap.close();
  }
}

function restoreOptions(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw rootStateFailure();
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== 'now')) throw rootStateFailure();
  const slot = Object.getOwnPropertyDescriptor(options, 'now');
  if (
    slot &&
    (!slot.enumerable || !Object.hasOwn(slot, 'value') || typeof slot.value !== 'function')
  )
    throw rootStateFailure();
  return slot?.value ?? Date.now;
}

// Batch admission inspects descriptors before reading values, then normalizes
// each root independently. Four legal roots may exceed the normalizer's 16 MiB
// whole-value ceiling; that must not expand any per-root or global store quota.
function restoreRootStates(options, input, metadataOnly) {
  const ledgers = [];
  const validateSourcePolicy = createRecoverySourcePolicyValidator();
  let bindings, histories;
  try {
    const now = restoreOptions(options);
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > 4 ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      throw rootStateFailure();
    const parsed = [],
      rootIds = new Set();
    for (let index = 0; index < input.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(input, String(index));
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw rootStateFailure();
      const wrapper = slot.value;
      if (
        !wrapper ||
        typeof wrapper !== 'object' ||
        Array.isArray(wrapper) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(wrapper)) ||
        Reflect.ownKeys(wrapper).sort().join(',') !== 'binding,state'
      )
        throw rootStateFailure();
      const fields = {};
      for (const key of ['binding', 'state']) {
        const field = Object.getOwnPropertyDescriptor(wrapper, key);
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw rootStateFailure();
        fields[key] = field.value;
      }
      const binding = normalizeRecoveryHistoryRequest(fields.binding, 3);
      let incoming = fields.state;
      let stagedSources = [];
      if (metadataOnly) {
        incoming = normalizeRecoveryReferenceData(incoming, MAX_STATE_BYTES);
        const validated = validateRecoveryRootMetadata(
          incoming?.kind === 'recovery-root-metadata'
            ? { metadata: incoming, stagedSources: [] }
            : incoming
        );
        const { metadata } = validated;
        stagedSources = validated.stagedSources;
        const { sourceVersion, ...root } = metadata;
        incoming = { ...root, version: sourceVersion, kind: 'recovery-root' };
      }
      // Public exports and normalizers remain mutable. Only this restore call
      // owns the isolated frozen ledger and its nonserializable provenance.
      const version = incoming && Object.getOwnPropertyDescriptor(incoming, 'version')?.value;
      const owned =
        !metadataOnly && (version === 9 || version === 10) ? admitRecoveryRoot(incoming) : null;
      const state = owned
        ? validateParsedRoot(owned.state, binding, fingerprintContextData(binding.policy ?? null))
        : parseRoot(incoming, binding);
      if (rootIds.has(state.rootId)) throw rootStateFailure();
      rootIds.add(state.rootId);
      parsed.push({ binding, state, stagedSources, proof: owned?.proof });
    }
    const observedAt = Math.max(0, ...parsed.map(({ state }) => state.observedAt));
    const legacySnapshots = parsed
      .filter(({ state }) => state.version < 8)
      .reduce((count, { state }) => count + state.binding.snapshots.length, 0);
    if (legacySnapshots > 256) throw rootStateFailure();
    const time = now();
    if (!integer(time) || time < observedAt || time > Number.MAX_SAFE_INTEGER - TTL_MS)
      throw rootStateFailure();
    // A single checked time waterline gives every component the same restore
    // admission point. Normal session clocks take over after reconstruction.
    let initializing = true;
    const componentNow = () => (initializing ? time : now());
    bindings = restoreContextBindingRoots(
      { now: componentNow, ttlMs: TTL_MS, maxSnapshots: RECOVERY_MAX_SNAPSHOTS, historyFormat: 3 },
      parsed.map(({ binding, state }) => ({ binding, state: state.binding }))
    );
    histories = restoreContextHistoryRoots(
      { now: componentNow, ttlMs: TTL_MS, maximumTips: 512, capacityVersion: 2 },
      parsed.map(({ state }) => ({ scope: scope(state), state: state.history }))
    );
    const roots = new Map(),
      snapshots = new Map();
    for (const { state, binding, stagedSources, proof } of parsed) {
      for (const source of metadataOnly ? [] : state.ledger.sources) {
        if (!validateSourcePolicy(source.callId, source.toolName, source.output))
          throw rootStateFailure();
      }
      const restoreLedger = metadataOnly
        ? require('./context-evidence-ledger').restoreContextEvidenceMetadata
        : proof !== undefined
          ? restoreOwnedContextEvidenceLedger
          : restoreContextEvidenceLedger;
      const ledger = restoreLedger(
        {
          owner: state.principal,
          threadId: state.rootId,
          now: componentNow,
          ttlMs: state.ledger.policy.ttlMs,
          maxEntries: recoveryRootCapacity(state.version).maxSources,
          maxBytes: recoveryRootOriginalBytes(state.version),
        },
        metadataOnly
          ? {
              ...state.ledger,
              sources: [...state.ledger.sources, ...stagedSources].sort(
                (a, b) => a.createdAt - b.createdAt
              ),
            }
          : state.ledger,
        proof
      );
      ledgers.push(ledger);
      const budget = restoreContextEvidenceBudget(state.budget);
      const linked = linkRoot(state, ledger, budget, histories.snapshots, time, binding);
      if (time >= state.expiresAt) {
        ledger.close();
        const token = bindings.snapshots.get(state.rootId);
        if (token) bindings.registry.withdraw(token);
        for (const id of state.history.tips) {
          const historyToken = histories.snapshots.get(id);
          if (historyToken) histories.historyMap.discard(historyToken);
        }
        continue;
      }
      if (!bindings.snapshots.has(state.rootId)) throw rootStateFailure();
      roots.set(state.rootId, linked.root);
      for (const [id, view] of linked.snapshots) snapshots.set(id, view);
    }
    initializing = false;
    return {
      registry: bindings.registry,
      historyMap: histories.historyMap,
      roots,
      snapshots,
      lastTime: time,
      now,
    };
  } catch {
    bindings?.registry.close();
    histories?.historyMap.close();
    for (const ledger of ledgers) ledger.close();
    throw rootStateFailure();
  }
}

function restoreRecoveryRootStates(options, input) {
  return restoreRootStates(options, input, false);
}
function restoreRecoveryRootMetadataStates(options, input) {
  return restoreRootStates(options, input, true);
}

module.exports = {
  rootStateFailure,
  exportRecoveryRootState,
  exportRecoveryRootCheckpoint,
  exportRecoveryRootMetadata,
  validateRecoveryRootMetadata,
  restoreRecoveryRootMetadataStates,
  restoreRecoveryRootStates,
};
