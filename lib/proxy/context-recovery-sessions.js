'use strict';

const { createHash } = require('node:crypto');
const { projectContextEvidenceCoverage } = require('./context-evidence-coverage');
const { createContextBindingRegistry } = require('./context-binding');
const {
  createRecoverySnapshotMap,
  createRecoverySnapshotSet,
  inspectRecoverySnapshotIndex,
} = require('./context-recovery-snapshot-index');
const {
  createContextEvidenceLedger,
  captureObservedContextEvidence,
  readContextEvidenceStoredPage,
  exportContextEvidenceProgress,
} = require('./context-evidence-ledger');
const {
  createContextEvidenceTaskBudget,
  createContextEvidenceTools,
  reserveContextEvidenceBudget,
  readContextEvidenceReservation,
  readContextEvidenceReservationAsync,
  exportContextEvidenceReservation,
  settleContextEvidenceReservation,
  abandonContextEvidenceReservation,
  LIST_EVIDENCE_TOOL,
  READ_EVIDENCE_TOOL,
} = require('./context-evidence-tools');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryHistoryRequest } = require('./context-recovery-history-request');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { codexRecoveryPolicyIdentity } = require('./context-recovery-codex-tools');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const { createContextHistoryMap } = require('./context-history-map');
const {
  fingerprintContextData,
  fingerprintRecoveryHistory,
} = require('./context-recovery-fingerprint');
const { assertNativeCompactionResponse } = require('./native-responses-compaction');
const {
  isCodexSummaryRequest,
  isCodexSummaryReceipt,
  sealCodexSummaryResponse,
} = require('./context-recovery-codex-summary');
const {
  claudeRecoveryPolicyIdentity,
  isClaudeSummaryRequest,
  sealClaudeSummaryResponse,
} = require('./context-recovery-claude-summary');
const { createRecoveryRootOwner, rootOwnerFailure } = require('./context-recovery-root-owner');
const {
  storageFailure,
  supportsRecoveryScan,
  supportsRecoveryReferenceScan,
  supportsRecoveryReferenceStates,
  supportsRecoverySourcePages,
  supportsRecoveryReaderSettlement,
} = require('./context-recovery-storage-contract');
const { rootStateFailure } = require('./context-recovery-root-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { parseReaderSettlement } = require('./context-recovery-reader-settlement');
const {
  RECOVERY_ROOT_VERSION,
  RECOVERY_MAX_SNAPSHOTS,
  recoveryRootCapacity,
  recoveryRootOriginalBytes,
} = require('./context-recovery-capacity');

const { RECOVERY_TTL_MS: TTL_MS, RECOVERY_MAX_ROOTS } = require('./context-recovery-limits');
const MAX_BYTES = 2 * 1024 * 1024;
const transfers = new WeakMap();
const owners = new WeakMap();
const ownedSessions = new WeakMap();
const storageAttachments = new WeakMap();
const adoptions = new WeakMap();
const selections = new WeakMap();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code) => ({ ok: false, code });
const tagged = (result) => ({
  ...result,
  observation: 'client_reported',
  verification: 'not_verified',
});

// One bounded root ledger holds bytes, while immutable request views authorize
// only ancestor evidence. A sibling's newly captured source is never enumerable.
// This service has no executor, transcript reader, HTTP client or credential access.
function createContextRecoverySessions({ now = Date.now } = {}) {
  return createSessions(now);
}

function createSessions(now, restored) {
  if (typeof now !== 'function') throw new TypeError('Invalid recovery session clock');
  let registry =
    restored?.registry ??
    createContextBindingRegistry({
      now,
      ttlMs: TTL_MS,
      maxSnapshots: RECOVERY_MAX_SNAPSHOTS,
      historyFormat: 3,
    });
  let historyMap =
    restored?.historyMap ??
    createContextHistoryMap({ now, ttlMs: TTL_MS, maximumTips: 512, capacityVersion: 2 });
  const roots = restored?.roots ?? new Map();
  const snapshots = restored?.snapshots ?? new Map();
  let enabled = Boolean(restored);
  let closed = false;
  let lastTime = restored?.lastTime ?? 0;
  let rejected = 0;
  let persistentReader = null;
  let persistentPublication = null;
  let persistentStorage = null;
  let storageStartup = null;
  let policyGeneration = 0;
  let stopped = false;
  let adopting = false;
  let revocationGeneration = 0;
  let loadingExecute = null;
  let loadingScan = () => false;
  let loadingReferenceScan = () => false;
  let selectedBegin = null;
  let loading;
  let loadingFailed = false;
  function snapshotCapacityAvailable(root) {
    const capacity = recoveryRootCapacity(root.capacityVersion);
    let own = 0,
      legacy = 0;
    for (const snapshot of snapshots.values()) {
      if (snapshot.root === root) own++;
      if (snapshot.root.capacityVersion < 8) legacy++;
    }
    return own < capacity.maxSnapshots && (root.capacityVersion >= 8 || legacy < 256);
  }
  // Disabled and synchronous memory owners need no restore/loading graph.
  // First asynchronous admission owns initialization; shutdown only drains it.
  function rootLoading() {
    if (loadingFailed) throw storageFailure();
    if (loading) return loading;
    try {
      const { createRecoveryRootLoading } = require('./context-recovery-root-loading');
      const {
        probeRecoveryRootStates,
        probeRecoveryRootMetadataStates,
      } = require('./context-recovery-root-selection');
      const {
        adoptRecoveryRootStates,
        adoptRecoveryRootMetadataStates,
      } = require('./context-recovery-root-adoption');
      loading = createRecoveryRootLoading({
        capture() {
          const generation = policyGeneration;
          const revocation = revocationGeneration;
          return () => {
            const time = clock();
            if (
              closed ||
              !enabled ||
              time === null ||
              adopting ||
              generation !== policyGeneration ||
              revocation !== revocationGeneration ||
              storageStartup?.pending() ||
              (persistentStorage && !persistentStorage.available())
            )
              throw storageFailure();
            return time;
          };
        },
        execute: () => loadingExecute,
        scan: () => loadingScan(),
        referenceScan: () => loadingReferenceScan(),
        activeRoots: () => new Set(roots.keys()),
        probe: (request, input, compaction) =>
          admission(probeRecoveryRootStates, input, request, compaction),
        adopt: (input) => admission(adoptRecoveryRootStates, input),
        probeMetadata: (request, input, compaction) =>
          admission(probeRecoveryRootMetadataStates, input, request, compaction),
        adoptMetadata: (input) => admission(adoptRecoveryRootMetadataStates, input),
        begin(request, results, compaction, selection, check) {
          check();
          if (selectedBegin) throw storageFailure();
          selectedBegin = { selection, check };
          let capability;
          try {
            capability = sessions.begin(request, results, compaction);
            check();
            return capability;
          } catch {
            if (capability?.ok) capability.abort();
            throw storageFailure();
          } finally {
            selectedBegin = null;
          }
        },
      });
      return loading;
    } catch {
      loadingFailed = true;
      throw storageFailure();
    }
  }
  for (const root of roots.values()) root.owner = createRecoveryRootOwner();

  function dispose(root) {
    root.active = false;
    root.owner.close();
    for (const token of root.mappingTokens) historyMap.discard(token);
    root.mappingTokens.clear();
    root.ledger.close();
    roots.delete(root.id);
    for (const [id, snapshot] of snapshots) if (snapshot.root === root) snapshots.delete(id);
  }

  function clear() {
    for (const root of [...roots.values()]) dispose(root);
    registry.close();
    historyMap.close();
  }

  function stop(revoke) {
    if (stopped) {
      if (revoke) void storageLifecycle('closeAsync');
      return;
    }
    stopped = true;
    enabled = false;
    closed = true;
    if (storageStartup?.pending()) {
      void storageStartup.enqueue(() => {
        if (revoke) return persistentStorage.closeAsync();
        persistentStorage.close();
        return { ok: true };
      });
    } else {
      if (revoke) void persistentStorage?.closeAsync();
      persistentStorage?.close();
    }
    persistentReader?.close();
    persistentPublication?.close();
    clear();
  }

  function storageLifecycle(method, ...args) {
    if (!persistentStorage) return;
    return storageStartup?.pending()
      ? storageStartup.enqueue(() => persistentStorage[method](...args))
      : persistentStorage[method](...args);
  }

  async function drainStorage() {
    await loading?.drain();
    const startup = storageStartup ? await storageStartup.drain() : { ok: true };
    const persisted = persistentStorage ? await persistentStorage.drain() : { ok: true };
    return !loadingFailed && startup.ok && persisted.ok
      ? { ok: true }
      : failure('context_recovery_storage_unavailable');
  }

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
      time > Number.MAX_SAFE_INTEGER - TTL_MS
    ) {
      stop(true);
      return null;
    }
    lastTime = time;
    for (const root of [...roots.values()]) if (time >= root.expiresAt) dispose(root);
    return time;
  }

  const sessions = {
    suspend() {
      if (closed) return;
      policyGeneration++;
      enabled = false;
      void storageLifecycle('suspendAll');
      persistentPublication?.suspend();
      clear();
    },
    async suspendAsync() {
      sessions.suspend();
      const result = await drainStorage();
      return closed ? failure('context_recovery_disabled') : result;
    },
    configure(value) {
      if (typeof value !== 'boolean') throw new TypeError('Invalid recovery session policy');
      if (!value) {
        policyGeneration++;
        enabled = false;
        void storageLifecycle('revokeAll');
        clear();
      } else if (!closed && !enabled) {
        if (storageStartup?.pending()) return;
        if (persistentStorage && !persistentStorage.available()) return;
        registry = createContextBindingRegistry({
          now,
          ttlMs: TTL_MS,
          maxSnapshots: RECOVERY_MAX_SNAPSHOTS,
          historyFormat: 3,
        });
        historyMap = createContextHistoryMap({
          now,
          ttlMs: TTL_MS,
          maximumTips: 512,
          capacityVersion: 2,
        });
        enabled = true;
      }
    },
    async configureAsync(value) {
      if (typeof value !== 'boolean') throw new TypeError('Invalid recovery session policy');
      if (!value) sessions.configure(false);
      const generation = policyGeneration;
      const result = await drainStorage();
      if (!result.ok) return result;
      if (value && generation !== policyGeneration) return failure('context_recovery_disabled');
      if (value) sessions.configure(true);
      return closed ? failure('context_recovery_disabled') : { ok: true };
    },
    beginCompaction(input, reportedResults = []) {
      return this.begin(input, reportedResults, true);
    },
    beginAsync(input, reportedResults = [], authorized, compaction = false) {
      if (closed || !enabled)
        return Promise.resolve(failure('context_recovery_storage_unavailable'));
      try {
        return rootLoading().begin(input, reportedResults, authorized, compaction);
      } catch {
        stop(true);
        return Promise.resolve(failure('context_recovery_storage_unavailable'));
      }
    },
    begin(input, reportedResults = [], compaction = false) {
      if (adopting) return failure('context_recovery_busy');
      const expected = selectedBegin;
      selectedBegin = null;
      const time = clock();
      if (closed || !enabled || time === null) return failure('context_recovery_disabled');
      let request;
      try {
        request = normalizeRecoveryHistoryRequest(input, 3);
      } catch {
        return failure('invalid_context_binding');
      }
      const binding = compaction ? registry.beginCompaction(request) : registry.begin(request);
      if (!binding.ok) return binding;
      if (
        expected?.selection &&
        (binding.parentSnapshotId !== expected.selection.parentSnapshotId ||
          binding.reason !== expected.selection.reason)
      ) {
        registry.rollback(binding.token);
        return failure('context_recovery_binding_changed');
      }
      let results;
      try {
        results = normalizeCompactionData(reportedResults, MAX_BYTES);
        if (!Array.isArray(results) || results.length > 128) throw new TypeError('invalid');
        const ids = new Set();
        for (const result of results) {
          if (
            !record(result) ||
            Object.keys(result).sort().join(',') !== 'callId,output' ||
            typeof result.callId !== 'string' ||
            !/^[A-Za-z0-9_.:-]{1,256}$/.test(result.callId) ||
            ids.has(result.callId)
          )
            throw new TypeError('invalid');
          ids.add(result.callId);
        }
      } catch {
        registry.rollback(binding.token);
        return failure('invalid_recovery_results');
      }
      const parent = binding.parentSnapshotId ? snapshots.get(binding.parentSnapshotId) : null;
      if (binding.parentSnapshotId && !parent) {
        registry.rollback(binding.token);
        return failure('context_recovery_scope_unavailable');
      }
      let root = parent?.root;
      if (root && !snapshotCapacityAvailable(root)) {
        registry.rollback(binding.token);
        return failure('context_binding_quota');
      }
      if (root && !root.owner.available()) {
        registry.rollback(binding.token);
        return failure('context_recovery_busy');
      }
      if (!root) {
        // Four new roots bound raw originals to 64 MiB. Older roots keep their
        // byte limits. Never evict a live root to admit another conversation.
        if (roots.size >= RECOVERY_MAX_ROOTS) {
          registry.rollback(binding.token);
          return failure('context_recovery_quota');
        }
        root = {
          capacityVersion: RECOVERY_ROOT_VERSION,
          id: binding.snapshotId,
          principal: request.principal,
          mappingScope: {
            principal: request.principal,
            protocol: request.protocol,
            target: request.target,
            policy: binding.policyFingerprint,
          },
          createdAt: time,
          policyBasis: request.policy ?? null,
          ledger: createContextEvidenceLedger({
            owner: request.principal,
            threadId: binding.snapshotId,
            now,
            ttlMs: TTL_MS,
            maxEntries: recoveryRootCapacity(RECOVERY_ROOT_VERSION).maxSources,
            maxBytes: recoveryRootOriginalBytes(RECOVERY_ROOT_VERSION),
          }),
          budget: createContextEvidenceTaskBudget(),
          descriptors: new Map(),
          mappingTokens: new Set(),
          callCount: 0,
          active: true,
          owner: createRecoveryRootOwner(),
          expiresAt: time + TTL_MS,
        };
        roots.set(root.id, root);
      }
      const visible = createRecoverySnapshotSet(parent?.visible);
      const calls = createRecoverySnapshotMap(parent?.calls);
      const captured = createRecoverySnapshotMap(parent?.captured);
      let active = true;
      let completed = false;
      let recoveryStarted = false;
      let coordinator = null;
      let stagedMapping = null;
      let releaseOutput = null;
      let pendingResults = [];
      const localSummary =
        compaction &&
        request.protocol === 'responses' &&
        isCodexSummaryRequest(
          {
            input: request.history,
            ...(request.policy?.tools == null ? {} : { tools: request.policy.tools }),
            tool_choice: request.policy?.toolChoice,
            ...(request.previousResponseId === undefined ||
            isCodexSummaryReceipt(request.previousResponseId)
              ? {}
              : { previous_response_id: request.previousResponseId }),
          },
          binding.historyFormat
        );
      const summaryContinuation = binding.summaryContinuation === true;
      let mappingSnapshot = summaryContinuation ? undefined : parent?.mappingSnapshot;
      const privateHistoryComplete =
        summaryContinuation || !parent || parent.privateHistoryComplete === true;
      let summaryResponseId;
      let isolatedRelease = false;
      let publicObservation = 'none';
      const mappingScope = {
        principal: request.principal,
        protocol: request.protocol,
        target: request.target,
        policy: binding.policyFingerprint,
      };
      function live() {
        if (expected) {
          try {
            expected.check();
          } catch {
            return false;
          }
        }
        return (
          clock() !== null &&
          enabled &&
          !closed &&
          root.active &&
          active &&
          registry.ancestors(binding.token).ok
        );
      }
      function abort() {
        active = false;
        root.owner.invalidate();
        coordinator?.cancel?.();
        if (!completed && stagedMapping) {
          historyMap.discard(stagedMapping);
          root.mappingTokens.delete(stagedMapping);
        }
        registry.rollback(binding.token);
        if (root.id === binding.snapshotId && !completed) dispose(root);
      }
      for (const result of results) {
        const call = calls.get(result.callId);
        if (!call) continue;
        // Arguments passed the source policy when the call was observed. Keep
        // only their digest, while rechecking every later result independently.
        const parsed = parseCompletedEvidenceSource({
          callId: result.callId,
          toolName: call.toolName,
          arguments: {},
          completed: true,
          output: result.output,
        });
        if (!parsed.ok) {
          rejected++;
          continue;
        }
        const prior = captured.get(result.callId);
        if (prior) {
          if (prior.digest !== hash(parsed.source.output)) {
            abort();
            return failure('context_recovery_source_conflict');
          }
          continue;
        }
        try {
          const descriptor = captureObservedContextEvidence(root.ledger, {
            callId: 'hpa_' + hash(binding.snapshotId + '\0' + result.callId),
            toolName: call.toolName,
            argumentsDigest: call.argumentsDigest,
            completed: true,
            output: parsed.source.output,
          });
          root.descriptors.set(descriptor.sourceId, descriptor);
          visible.add(descriptor.sourceId);
          captured.set(result.callId, descriptor);
        } catch {
          rejected++;
        }
      }
      const readers = createContextEvidenceTools(
        {
          list(args) {
            const entries = [...root.descriptors.values()].filter(
              (entry) => visible.has(entry.sourceId) && entry.expiresAt > lastTime
            );
            const after =
              args.afterSourceId === undefined
                ? -1
                : entries.findIndex((entry) => entry.sourceId === args.afterSourceId);
            if (args.afterSourceId !== undefined && after < 0)
              return { ok: false, error: 'evidence_index_unavailable' };
            const selected = entries.slice(after + 1, after + 1 + (args.limit ?? 8));
            return tagged({
              ok: true,
              sources: selected.map((entry) => ({ ...entry })),
              coverage: projectContextEvidenceCoverage(
                calls.size,
                entries.length,
                recoveryRootCapacity(root.capacityVersion).maxCalls
              ),
              nextAfterSourceId:
                after + 1 + selected.length < entries.length ? selected.at(-1).sourceId : null,
            });
          },
          read(args, maxBytes) {
            if (!visible.has(args.sourceId))
              return { ok: false, error: 'context_evidence_unavailable' };
            return tagged(root.ledger.read(args, Math.max(0, maxBytes - 96)));
          },
        },
        root.budget
      );
      function reply(name, args, lease) {
        if (!live()) return failure('context_evidence_unavailable');
        if (!root.owner.available(lease)) return failure('context_recovery_busy');
        if (
          persistentReader &&
          lease === undefined &&
          [LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL].includes(name)
        )
          return failure('context_recovery_async_required');
        return readers.reply(name, args);
      }
      function complete(output, observedCalls, responseId, lease) {
        if (!root.owner.available(lease)) return failure('context_recovery_busy');
        if (persistentPublication && lease === undefined)
          return failure('context_recovery_async_required');
        return completeOwned(output, observedCalls, responseId);
      }
      const capability = {
        ok: true,
        historyFormat: binding.historyFormat,
        reason: binding.reason,
        snapshotId: binding.snapshotId,
        definitions: readers.definitions,
        retainedTransportReference(callId, digest) {
          if (
            !live() ||
            typeof callId !== 'string' ||
            callId.length > 256 ||
            typeof digest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(digest)
          )
            return null;
          const entry = captured.get(callId);
          if (
            !entry ||
            !visible.has(entry.sourceId) ||
            entry.expiresAt <= lastTime ||
            entry.digest !== digest
          )
            return null;
          return { sourceId: entry.sourceId, digest: entry.digest, bytes: entry.bytes };
        },
        reply(name, args) {
          return reply(name, args);
        },
        async replyAsync(name, args) {
          if (!live()) return failure('context_evidence_unavailable');
          if (persistentReader) return persistentReader.reply(capability, name, args);
          return capability.reply(name, args);
        },
        recovery(inputBody, options = {}) {
          if (compaction && !localSummary) return failure('context_recovery_compaction_request');
          if (!live() || completed || recoveryStarted) return failure('context_recovery_stale');
          if (!root.owner.available()) return failure('context_recovery_busy');
          try {
            const controls = normalizeCompactionData(options, 1024);
            if (
              !record(controls) ||
              Object.keys(controls).some(
                (key) => !['deferMixedResults', 'publicGeneration'].includes(key)
              ) ||
              (controls.publicGeneration !== undefined &&
                controls.publicGeneration !== 'isolated') ||
              (controls.deferMixedResults !== undefined &&
                typeof controls.deferMixedResults !== 'boolean')
            )
              return failure('context_recovery_controls_unsupported');
            const body = normalizeRecoveryRequestBody(
              request.protocol,
              inputBody,
              binding.historyFormat
            );
            const serverContinuation =
              request.protocol === 'responses' &&
              request.previousResponseId !== undefined &&
              !summaryContinuation;
            if (
              request.protocol === 'responses' &&
              (summaryContinuation
                ? body.previous_response_id !== undefined
                : (body.previous_response_id ?? undefined) !== request.previousResponseId)
            )
              return failure('context_recovery_history_conflict');
            const key = request.protocol === 'responses' ? 'input' : 'messages';
            let publicHistory = body[key];
            if (request.protocol === 'responses' && typeof publicHistory === 'string')
              publicHistory = [
                { role: 'user', content: [{ type: 'input_text', text: publicHistory }] },
              ];
            if (
              fingerprintRecoveryHistory(publicHistory, binding.historyFormat) !==
              fingerprintRecoveryHistory(request.history, binding.historyFormat)
            )
              return failure('context_recovery_history_conflict');
            if (record(request.policy)) {
              const policy = {
                instructions: body.instructions ?? null,
                system: body.system ?? null,
                tools: body.tools ?? null,
                toolChoice: body.tool_choice ?? null,
              };
              const identity =
                request.protocol === 'claude'
                  ? claudeRecoveryPolicyIdentity(policy)
                  : request.protocol === 'responses'
                    ? codexRecoveryPolicyIdentity(policy, publicHistory)
                    : policy;
              if (fingerprintContextData(identity) !== fingerprintContextData(request.policy))
                return failure('context_recovery_policy_conflict');
            }
            let upstreamHistory = publicHistory;
            const inheritedResults = capability.readPendingResults();
            if (!serverContinuation && !privateHistoryComplete)
              return failure('context_recovery_continuation_unsupported');
            // A verified Responses ID selects provider-owned ancestry. Its input
            // is a delta, not the hashed full public window used by local maps.
            // Re-inserting that ancestor would duplicate private exchanges.
            if (mappingSnapshot && !serverContinuation) {
              const mapped = historyMap.rebuild({
                historyFormat: binding.historyFormat,
                scope: mappingScope,
                snapshot: mappingSnapshot,
                clientHistory: publicHistory,
              });
              if (!mapped.ok) return mapped;
              upstreamHistory = mapped.history;
            }
            if (inheritedResults.length) {
              if (!serverContinuation) {
                if (!mappingSnapshot) return failure('context_recovery_continuation_unsupported');
                try {
                  require('./context-recovery-pending-results').assertRebuiltPendingResults(
                    inheritedResults,
                    publicHistory,
                    upstreamHistory,
                    binding.historyFormat
                  );
                } catch {
                  return failure('context_recovery_continuation_unsupported');
                }
              } else {
                if (
                  upstreamHistory.some((item) =>
                    inheritedResults.some((prior) => prior.call_id === item.call_id)
                  )
                )
                  return failure('context_recovery_continuation_unsupported');
                upstreamHistory = [...inheritedResults, ...upstreamHistory];
              }
            }
            const isolated = controls.publicGeneration === 'isolated';
            if (
              isolated &&
              serverContinuation &&
              (parent?.publicResponse !== true || parent.pendingReady !== true)
            )
              return failure('context_recovery_public_history_unavailable');
            // Disabled owners, observation and exact readers do not need the
            // generation state machine. Load only after this turn's history,
            // policy and inherited results have passed their existing checks.
            if (isolated) {
              const {
                createContextRecoveryIsolatedCoordinator,
              } = require('./context-recovery-isolated-coordinator');
              coordinator = createContextRecoveryIsolatedCoordinator({
                kind: request.protocol,
                historyFormat: binding.historyFormat,
                body,
                privateBody: { ...body, [key]: upstreamHistory },
                session: capability,
                ...(serverContinuation
                  ? { publicPreviousResponseId: request.previousResponseId }
                  : {}),
              });
            } else {
              const {
                createContextRecoveryCoordinator,
              } = require('./context-recovery-coordinator');
              coordinator = createContextRecoveryCoordinator({
                kind: request.protocol,
                historyFormat: binding.historyFormat,
                body: { ...body, [key]: upstreamHistory },
                session: capability,
                deferMixedResults: controls.deferMixedResults,
              });
            }
            if (!coordinator.ok)
              return inheritedResults.length
                ? failure('context_recovery_continuation_unsupported')
                : coordinator;
            recoveryStarted = true;
            function finishRecovery(result) {
              if (!live()) return { mode: 'failed', ...failure('context_recovery_stale') };
              if (!root.owner.available())
                return { mode: 'failed', ...failure('context_recovery_busy') };
              if (result.mode !== 'release') return result;
              isolatedRelease = isolated;
              if (localSummary) {
                if (result.deferredExternal)
                  return { mode: 'failed', ...failure('context_recovery_summary_invalid') };
                const sealed = sealCodexSummaryResponse(result.response);
                if (!sealed)
                  return { mode: 'failed', ...failure('context_recovery_summary_invalid') };
                result = { ...result, response: sealed.response, output: sealed.output };
                summaryResponseId = sealed.responseId;
              }
              if (
                request.protocol === 'claude' &&
                binding.parentSnapshotId &&
                !result.deferredExternal &&
                isClaudeSummaryRequest(body)
              ) {
                const sealed = sealClaudeSummaryResponse(result.response);
                if (!sealed)
                  return { mode: 'failed', ...failure('context_recovery_summary_invalid') };
                result = { ...result, response: sealed.response, output: sealed.output };
                summaryResponseId = sealed.responseId;
              }
              pendingResults =
                result.deferredInput === undefined
                  ? []
                  : require('./context-recovery-pending-results').parseRecoveryPendingResults(
                      result.deferredInput
                    );
              releaseOutput = fingerprintContextData(result.output);
              const tail = result.history.slice(upstreamHistory.length);
              if (tail.length) {
                const publicWindow =
                  request.protocol === 'responses' ? registry.publicWindow(binding.token) : null;
                if (serverContinuation && !publicWindow) {
                  abort();
                  return {
                    mode: 'failed',
                    ...failure('context_recovery_continuation_unsupported'),
                  };
                }
                const staged = historyMap.prepare({
                  historyFormat: binding.historyFormat,
                  scope: mappingScope,
                  ttlMs: root.expiresAt - root.createdAt,
                  historyVersion:
                    root.capacityVersion >= 10
                      ? 3
                      : root.expiresAt - root.createdAt === TTL_MS
                        ? 2
                        : 1,
                  ...(root.capacityVersion >= 10 ? { rootId: root.id } : {}),
                  ...(mappingSnapshot ? { parent: mappingSnapshot } : {}),
                  clientHistory: publicHistory,
                  hiddenTail: tail,
                  ...(result.publicOutputReferences
                    ? {
                        publicReferences: result.publicOutputReferences.map((reference) => ({
                          historyIndex: reference.historyIndex - upstreamHistory.length,
                          outputIndex: reference.outputIndex,
                        })),
                      }
                    : {}),
                  ...(publicWindow ? { publicWindow } : {}),
                });
                if (!staged.ok) {
                  abort();
                  return { mode: 'failed', ...staged };
                }
                stagedMapping = staged.token;
                root.mappingTokens.add(stagedMapping);
              }
              return result;
            }
            return {
              ok: true,
              initialRequest: coordinator.initialRequest,
              inspectProgress: () => coordinator.inspectProgress(),
              accept(response) {
                if (!live()) return { mode: 'failed', ...failure('context_recovery_stale') };
                if (!root.owner.available())
                  return { mode: 'failed', ...failure('context_recovery_busy') };
                return finishRecovery(coordinator.accept(response));
              },
              async acceptAsync(response) {
                if (!live()) return { mode: 'failed', ...failure('context_recovery_stale') };
                if (!root.owner.available())
                  return { mode: 'failed', ...failure('context_recovery_busy') };
                return finishRecovery(await coordinator.acceptAsync(response));
              },
              cancel: abort,
            };
          } catch {
            return failure('context_recovery_request_unsupported');
          }
        },
        complete(output, observedCalls = [], responseId) {
          return complete(output, observedCalls, responseId);
        },
        async completeAsync(output, observedCalls = [], responseId) {
          if (persistentPublication)
            return persistentPublication.prepare(capability, output, observedCalls, responseId);
          return complete(output, observedCalls, responseId);
        },
        async completeObservedAsync(output, observedCalls = [], responseId) {
          if (!recoveryStarted) publicObservation = 'finished';
          if (persistentPublication)
            return persistentPublication.prepare(
              capability,
              output,
              observedCalls,
              responseId,
              true
            );
          return complete(output, observedCalls, responseId);
        },
        async completePublicAsync(output, observedCalls = [], responseId) {
          if (!recoveryStarted) publicObservation = 'prepared';
          if (persistentPublication)
            return persistentPublication.prepare(capability, output, observedCalls, responseId);
          return complete(output, observedCalls, responseId);
        },
        async startPublicationAsync() {
          if (persistentPublication) return persistentPublication.sending(capability);
          return live() ? { ok: true } : failure('context_recovery_stale');
        },
        async finishPublicationAsync() {
          if (!live()) return failure('context_recovery_stale');
          const snapshot = snapshots.get(binding.snapshotId);
          if (snapshot) snapshot.pendingReady = true;
          if (persistentPublication) {
            const result = await persistentPublication.finished(capability);
            if (!result.ok && snapshot) snapshot.pendingReady = false;
            return result;
          }
          return { ok: true };
        },
        readPendingResults() {
          if (
            !live() ||
            !root.owner.available() ||
            (parent?.pendingResults?.length && parent.pendingReady !== true)
          )
            throw new Error('Recovery pending results unavailable');
          return parent?.pendingResults?.length
            ? require('./context-recovery-pending-results').parseRecoveryPendingResults(
                parent.pendingResults
              )
            : [];
        },
        async withdrawAsync() {
          if (persistentPublication) return persistentPublication.withdraw(capability);
          capability.withdraw();
          return { ok: true };
        },
        async abortAsync() {
          if (persistentPublication) return persistentPublication.withdraw(capability);
          abort();
          return { ok: true };
        },
        completeCompaction(inputResponse) {
          if (!root.owner.available()) return failure('context_recovery_busy');
          if (persistentPublication) return failure('context_recovery_async_required');
          return completeCompaction(inputResponse);
        },
        async completeCompactionAsync(inputResponse) {
          if (persistentPublication)
            return persistentPublication.prepareCompaction(capability, inputResponse);
          if (!root.owner.available()) return failure('context_recovery_busy');
          return completeCompaction(inputResponse);
        },
        abort,
        withdraw() {
          active = false;
          root.owner.invalidate();
          coordinator?.cancel?.();
          if (stagedMapping) {
            historyMap.discard(stagedMapping);
            root.mappingTokens.delete(stagedMapping);
          }
          for (const id of registry.withdraw(binding.token)) snapshots.delete(id);
          if (root.id === binding.snapshotId) dispose(root);
        },
        inspect() {
          return {
            active: live(),
            completed,
            localSummary,
            visibleSources: visible.size,
            expiresAt: root.expiresAt,
            readers: readers.inspect(),
          };
        },
      };
      function completeOwned(output, observedCalls, responseId) {
        if (compaction && !localSummary) return failure('context_recovery_compaction_request');
        if (localSummary && summaryResponseId === undefined)
          return failure('context_recovery_summary_invalid');
        if (!live() || completed) return failure('context_recovery_stale');
        let parsedCalls;
        try {
          const safe = normalizeCompactionData(observedCalls, MAX_BYTES);
          if (
            !Array.isArray(safe) ||
            safe.length > 128 ||
            root.callCount + safe.length > recoveryRootCapacity(root.capacityVersion).maxCalls
          )
            throw new TypeError('invalid');
          parsedCalls = safe.map(parseCompletedEvidenceSource);
          if (parsedCalls.some((entry) => !entry.ok)) throw new TypeError('invalid');
          const ids = new Set();
          for (const entry of parsedCalls) {
            if (ids.has(entry.source.callId) || calls.has(entry.source.callId))
              throw new TypeError('conflict');
            ids.add(entry.source.callId);
          }
        } catch {
          return failure('invalid_recovery_calls');
        }
        let finalOutput;
        try {
          finalOutput = normalizeCompactionData(output, MAX_BYTES);
          if (pendingResults.length) {
            const {
              pendingResultsBytes,
              MAX_PENDING_RESULTS_BYTES,
            } = require('./context-recovery-pending-results');
            const retained = [...snapshots.values()]
              .filter((snapshot) => snapshot.root === root)
              .reduce(
                (sum, snapshot) => sum + pendingResultsBytes(snapshot.pendingResults ?? []),
                0
              );
            if (retained + pendingResultsBytes(pendingResults) > MAX_PENDING_RESULTS_BYTES)
              throw new TypeError('invalid');
          }
        } catch {
          return failure('invalid_recovery_output');
        }
        if (
          recoveryStarted &&
          (releaseOutput === null || fingerprintContextData(finalOutput) !== releaseOutput)
        )
          return failure('context_recovery_output_conflict');
        if (stagedMapping) {
          const published = historyMap.commit(stagedMapping, finalOutput);
          if (!published.ok) {
            abort();
            return published;
          }
          mappingSnapshot = published.snapshot;
        }
        if (!snapshotCapacityAvailable(root)) return failure('context_binding_quota');
        const committed = registry.commit(
          binding.token,
          finalOutput,
          summaryResponseId ?? responseId
        );
        if (!committed.ok) {
          if (stagedMapping) historyMap.discard(stagedMapping);
          return committed;
        }
        for (const entry of parsedCalls)
          calls.set(entry.source.callId, {
            toolName: entry.source.toolName,
            argumentsDigest: hash(JSON.stringify(entry.source.arguments)),
          });
        root.callCount += parsedCalls.length;
        completed = true;
        const publicResponse =
          request.protocol === 'responses' &&
          !localSummary &&
          responseId !== undefined &&
          (isolatedRelease ||
            (!recoveryStarted &&
              publicObservation !== 'none' &&
              (request.previousResponseId === undefined ||
                summaryContinuation ||
                (parent?.publicResponse === true && parent.pendingReady === true))));
        snapshots.set(binding.snapshotId, {
          pendingResults,
          pendingReady:
            pendingResults.length === 0 && (!publicResponse || publicObservation === 'finished'),
          publicResponse,
          root,
          calls: calls.freeze(),
          visible: visible.freeze(),
          captured: captured.freeze(),
          mappingSnapshot,
          privateHistoryComplete,
        });
        return { ok: true };
      }
      function completeCompaction(inputResponse) {
        if (!compaction || localSummary || !live() || completed || recoveryStarted)
          return failure('context_recovery_stale');
        let response;
        try {
          response = normalizeCompactionData(inputResponse, MAX_BYTES);
          assertNativeCompactionResponse(response, MAX_BYTES);
        } catch {
          return failure('context_recovery_compaction_invalid');
        }
        if (!snapshotCapacityAvailable(root)) return failure('context_binding_quota');
        const committed = registry.commitCompaction(binding.token, response.output);
        if (!committed.ok) return committed;
        // The provider's canonical replacement is the next upstream history.
        // Old private exchanges stay on the old branch; never splice them into it.
        mappingSnapshot = undefined;
        completed = true;
        snapshots.set(binding.snapshotId, {
          root,
          calls: calls.freeze(),
          visible: visible.freeze(),
          captured: captured.freeze(),
          mappingSnapshot,
          privateHistoryComplete: true,
        });
        return { ok: true };
      }
      ownedSessions.set(capability, {
        root,
        snapshotId: binding.snapshotId,
        withdraw: () => capability.withdraw(),
        reply,
        complete,
        completeCompaction,
        live,
        replyReserved: (reservation, name, args) =>
          readContextEvidenceReservation(readers, reservation, name, args),
        replyReservedAsync: (reservation, name, args, fetchPage) =>
          readContextEvidenceReservationAsync(
            readers,
            reservation,
            name,
            args,
            async (args, maximum) => {
              if (!visible.has(args.sourceId))
                return { ok: false, error: 'context_evidence_unavailable' };
              return tagged(
                await readContextEvidenceStoredPage(
                  root.ledger,
                  args,
                  Math.max(0, maximum - 96),
                  fetchPage
                )
              );
            }
          ),
      });
      return capability;
    },
    revoke(principal) {
      if (typeof principal !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(principal)) return;
      revocationGeneration++;
      void storageLifecycle('revokePrincipal', principal);
      for (const root of [...roots.values()]) if (root.principal === principal) dispose(root);
    },
    async revokeAsync(principal) {
      if (typeof principal !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(principal))
        return failure('context_recovery_storage_unavailable');
      sessions.revoke(principal);
      return drainStorage();
    },
    inspect() {
      clock();
      let snapshotIndexEntries = 0;
      let snapshotIndexLogicalEntries = 0;
      for (const snapshot of snapshots.values()) {
        for (const index of [snapshot.calls, snapshot.captured, snapshot.visible]) {
          const counts = inspectRecoverySnapshotIndex(index);
          snapshotIndexEntries += counts.ownEntries;
          snapshotIndexLogicalEntries += counts.size;
        }
      }
      return {
        enabled,
        closed,
        roots: roots.size,
        snapshots: snapshots.size,
        rejected,
        snapshotIndexEntries,
        snapshotIndexLogicalEntries,
      };
    },
    close() {
      stop(true);
    },
    async closeAsync() {
      stop(true);
      return drainStorage();
    },
    async shutdownAsync() {
      // Process shutdown retains committed bytes for fresh authorization on
      // restart. It never turns pending publication records into authority.
      stop(false);
      return drainStorage();
    },
  };
  function exportRoot(rootId, lease, checkpoint = false) {
    const time = clock();
    const root = roots.get(rootId);
    if (closed || !enabled || time === null || !root?.active) throw rootStateFailure();
    if (!root.owner.available(lease)) throw rootStateFailure();
    const {
      exportRecoveryRootState,
      exportRecoveryRootCheckpoint,
      exportRecoveryRootMetadata,
    } = require('./context-recovery-root-state');
    const exporter =
      checkpoint === 'metadata'
        ? exportRecoveryRootMetadata
        : checkpoint
          ? exportRecoveryRootCheckpoint
          : exportRecoveryRootState;
    const state = exporter(root, registry, historyMap, snapshots, time);
    const exportedRoot =
      checkpoint === 'metadata' ? state.metadata : checkpoint ? state.root : state;
    if (exportedRoot.observedAt >= root.expiresAt) throw rootStateFailure();
    return state;
  }
  transfers.set(sessions, exportRoot);
  function admission(operation, input, request, compaction) {
    if (adopting) throw rootStateFailure();
    adopting = true;
    const generation = policyGeneration;
    const revocation = revocationGeneration;
    try {
      return operation(
        {
          now,
          registry,
          historyMap,
          roots,
          snapshots,
          check() {
            const time = clock();
            if (
              closed ||
              !enabled ||
              time === null ||
              generation !== policyGeneration ||
              revocation !== revocationGeneration ||
              storageStartup?.pending() ||
              (persistentStorage && !persistentStorage.available())
            )
              throw rootStateFailure();
            return time;
          },
          register(root) {
            persistentStorage?.admitRoot({
              rootId: root.id,
              principal: root.principal,
              createdAt: root.createdAt,
              expiresAt: root.expiresAt,
            });
          },
        },
        input,
        request,
        compaction
      );
    } finally {
      adopting = false;
    }
  }
  adoptions.set(sessions, (input) => {
    const { adoptRecoveryRootStates } = require('./context-recovery-root-adoption');
    return admission(adoptRecoveryRootStates, input);
  });
  selections.set(sessions, (request, input, compaction) => {
    const { probeRecoveryRootStates } = require('./context-recovery-root-selection');
    return admission(probeRecoveryRootStates, input, request, compaction);
  });
  owners.set(sessions, (rootId) => {
    clock();
    const root = roots.get(rootId);
    if (closed || !enabled || !root?.active) throw rootOwnerFailure();
    const token = root.owner.acquire();
    const reservations = new Map();
    const reservationProgress = new Map();
    function checked(capability, requireCapability = false) {
      if (clock() === null || !root.active || !root.owner.available(token))
        throw rootOwnerFailure();
      if (capability === undefined && !requireCapability) return null;
      const target = ownedSessions.get(capability);
      if (!target || target.root !== root || !target.live()) throw rootOwnerFailure();
      return target;
    }
    function confirmBudget(reservation) {
      if (!reservations.has(reservation)) throw rootOwnerFailure();
      settleContextEvidenceReservation(reservations.get(reservation));
      reservations.delete(reservation);
      reservationProgress.delete(reservation);
    }
    return Object.freeze({
      identity(capability) {
        return Object.freeze({ snapshotId: checked(capability, true).snapshotId });
      },
      snapshot() {
        checked();
        return exportRoot(rootId, token);
      },
      checkpoint(capability, reservation) {
        checked(capability, true);
        if (reservation !== undefined && !reservations.has(reservation)) throw rootOwnerFailure();
        const { createRootCheckpoint } = require('./context-recovery-root-checkpoint');
        const checkpoint = exportRoot(rootId, token, true);
        if (reservation !== undefined) {
          checkpoint.root.budget = exportContextEvidenceReservation(reservations.get(reservation));
          return createRootCheckpoint(checkpoint.root, checkpoint.stagedSources);
        }
        return checkpoint;
      },
      metadata(capability, reservation) {
        checked(capability, true);
        if (reservation !== undefined && !reservations.has(reservation)) throw rootOwnerFailure();
        const state = exportRoot(rootId, token, 'metadata');
        if (reservation !== undefined)
          state.metadata.budget = exportContextEvidenceReservation(reservations.get(reservation));
        return state;
      },
      payloads(capability, sourceIds) {
        checked(capability, true);
        const { exportContextEvidencePayloads } = require('./context-evidence-ledger');
        const result = exportContextEvidencePayloads(root.ledger, sourceIds);
        checked(capability, true);
        return result;
      },
      evictPersisted(capability, acknowledgement) {
        checked(capability, true);
        const { acknowledgedRecoverySources } = require('./context-recovery-durable-ack');
        const { evictContextEvidencePayloads } = require('./context-evidence-ledger');
        const ids = acknowledgedRecoverySources(
          acknowledgement,
          exportRoot(rootId, token, 'metadata')
        );
        checked(capability, true);
        evictContextEvidencePayloads(root.ledger, ids);
        checked(capability, true);
      },
      assertReader(capability) {
        checked(capability, true);
      },
      readerSettlement(capability, reservation) {
        checked(capability, true);
        if (!reservations.has(reservation)) throw rootOwnerFailure();
        const progress = exportContextEvidenceProgress(root.ledger);
        const before = reservationProgress.get(reservation);
        const sources = progress.sources.filter((source) => {
          const prior = before.get(source.sourceId);
          if (!prior) throw rootOwnerFailure();
          return (
            source.coveredThrough !== prior.coveredThrough ||
            source.readComplete !== prior.readComplete
          );
        });
        checked(capability, true);
        return parseReaderSettlement({
          version: 2,
          kind: 'recovery-reader-settlement',
          rootId,
          observedAt: Math.max(progress.observedAt, lastTime),
          budget: exportContextEvidenceReservation(reservations.get(reservation)),
          ledger: { readCount: progress.readCount, sources },
        });
      },
      reply(capability, name, args) {
        return checked(capability, true).reply(name, args, token);
      },
      reserveBudget() {
        checked();
        const progress = exportContextEvidenceProgress(root.ledger);
        const reservation = Object.freeze({});
        reservations.set(reservation, reserveContextEvidenceBudget(root.budget));
        reservationProgress.set(
          reservation,
          new Map(progress.sources.map((source) => [source.sourceId, source]))
        );
        return reservation;
      },
      replyReserved(capability, reservation, name, args) {
        const target = checked(capability, true);
        if (!reservations.has(reservation)) throw rootOwnerFailure();
        return target.replyReserved(reservations.get(reservation), name, args);
      },
      async replyReservedAsync(capability, reservation, name, args, fetchPage) {
        const target = checked(capability, true);
        if (!reservations.has(reservation) || typeof fetchPage !== 'function')
          throw rootOwnerFailure();
        const result = await target.replyReservedAsync(
          reservations.get(reservation),
          name,
          args,
          async (source, range, maximum) => {
            checked(capability, true);
            const pending = fetchPage(source, range, maximum);
            if (!nativeReaderPromise(pending)) throw rootOwnerFailure();
            const page = await pending;
            checked(capability, true);
            return page;
          }
        );
        checked(capability, true);
        return result;
      },
      settlementSnapshot(reservation) {
        checked();
        if (!reservations.has(reservation)) throw rootOwnerFailure();
        const state = exportRoot(rootId, token);
        state.budget = exportContextEvidenceReservation(reservations.get(reservation));
        return state;
      },
      settleBudget(reservation) {
        checked();
        confirmBudget(reservation);
      },
      // Trusted persistence caller only: confirms validated durable accounting.
      // A late acknowledgement may settle counters without reviving authority.
      confirmBudget,
      complete(capability, output, calls = [], responseId) {
        if (reservations.size) throw rootOwnerFailure();
        return checked(capability, true).complete(output, calls, responseId, token);
      },
      completeCompaction(capability, response) {
        if (reservations.size) throw rootOwnerFailure();
        return checked(capability, true).completeCompaction(response);
      },
      release() {
        for (const reservation of reservations.values())
          abandonContextEvidenceReservation(reservation);
        reservations.clear();
        reservationProgress.clear();
        return root.owner.release(token);
      },
    });
  });
  storageAttachments.set(sessions, (storage, publication = false, startup = false) => {
    if (closed || persistentStorage || (startup && (enabled || roots.size || snapshots.size)))
      throw storageFailure();
    const { createRecoveryRootStorage } = require('./context-recovery-root-storage');
    const { createRecoveryRootReader } = require('./context-recovery-root-reader');
    const { createRecoveryRootPublication } = require('./context-recovery-root-publication');
    const { createRecoveryStorageStartup } = require('./context-recovery-storage-startup');
    const acquire = (capability) => {
      const target = ownedSessions.get(capability);
      if (!target || roots.get(target.root.id) !== target.root || !target.live())
        throw rootOwnerFailure();
      return owners.get(sessions)(target.root.id);
    };
    const rootStorage = createRecoveryRootStorage(storage);
    const execute = Object.getOwnPropertyDescriptor(storage, 'execute');
    if (typeof execute?.value !== 'function') throw storageFailure();
    loadingExecute = execute.value.bind(storage);
    loadingScan = () => supportsRecoveryScan(execute.value);
    loadingReferenceScan = () =>
      supportsRecoveryReferenceScan(execute.value) &&
      supportsRecoveryReferenceStates(execute.value) &&
      supportsRecoverySourcePages(execute.value) &&
      supportsRecoveryReaderSettlement(execute.value);
    // Restored or previously live roots must be revocable before their first
    // read. Registration is an index for denial, never restored authority.
    for (const root of roots.values())
      rootStorage.registerRoot({
        rootId: root.id,
        principal: root.principal,
        createdAt: root.createdAt,
        expiresAt: root.expiresAt,
      });
    persistentStorage = rootStorage;
    const install = () => {
      if (closed || (startup && clock() === null)) return false;
      persistentReader = createRecoveryRootReader(storage, acquire, persistentStorage);
      if (publication)
        persistentPublication = createRecoveryRootPublication({
          acquire,
          transactions: persistentStorage,
          drop(capability) {
            const target = ownedSessions.get(capability);
            if (!target) throw rootOwnerFailure();
            target.withdraw();
          },
        });
      return true;
    };
    if (!startup) {
      install();
      return;
    }
    storageStartup = createRecoveryStorageStartup(rootStorage);
    return storageStartup.complete(install).catch(() => {
      stop(false);
      throw storageFailure();
    });
  });
  return sessions;
}

// Trusted owner APIs only. The caller must authenticate stored roots and
// supply current binding bases; serialized labels never authorize themselves.
function exportContextRecoveryRoot(sessions, rootId) {
  try {
    const transfer = transfers.get(sessions);
    if (!transfer) throw rootStateFailure();
    return transfer(rootId);
  } catch {
    throw rootStateFailure();
  }
}
// Trusted diagnostics/export only. Uses the same root/clock/lease checks as the
// full exporter, but returns the distinct metadata envelope without raw bytes.
function exportContextRecoveryRootMetadata(sessions, rootId) {
  try {
    const transfer = transfers.get(sessions);
    if (!transfer) throw rootStateFailure();
    return transfer(rootId, undefined, 'metadata');
  } catch {
    throw rootStateFailure();
  }
}

// Trusted service capability only. This does not write storage or grant new
// source visibility; the holder must await its writes and release in finally.
function acquireContextRecoveryRoot(sessions, rootId) {
  try {
    const acquire = owners.get(sessions);
    if (!acquire) throw rootOwnerFailure();
    return acquire(rootId);
  } catch {
    throw rootOwnerFailure();
  }
}
function restoreContextRecoverySessions(options, input) {
  const { restoreRecoveryRootStates } = require('./context-recovery-root-state');
  const restored = restoreRecoveryRootStates(options, input);
  return createSessions(restored.now, restored);
}

// Trusted owner API: add freshly authorized roots without replacing live
// registries, mappings, budgets, pending branches or existing capabilities.
function adoptContextRecoveryRoots(sessions, input) {
  try {
    const adopt = adoptions.get(sessions);
    if (!adopt) throw rootStateFailure();
    return adopt(input);
  } catch {
    throw rootStateFailure();
  }
}

// Trusted owner probe: no adoption, new request branch or read capability.
function probeContextRecoveryRoots(sessions, request, input = [], compaction = false) {
  try {
    const probe = selections.get(sessions);
    if (!probe) throw rootStateFailure();
    return probe(request, input, compaction);
  } catch {
    throw rootStateFailure();
  }
}

// Private composition attachment. It enables durable async reads, not complete
// publication, startup discovery or authorization restore from write-ahead data.
function attachContextRecoveryReaderStorage(sessions, storage) {
  try {
    const attach = storageAttachments.get(sessions);
    if (!attach) throw storageFailure();
    attach(storage);
  } catch {
    throw storageFailure();
  }
}

// Trusted composition only. This also makes final publication asynchronous;
// activation, native compaction and startup authorization are separate boundaries.
function attachContextRecoveryStorage(sessions, storage) {
  try {
    const attach = storageAttachments.get(sessions);
    if (!attach) throw storageFailure();
    attach(storage, true);
  } catch {
    throw storageFailure();
  }
}

// Fresh disabled session only. Await discovery and queued lifecycle ACKs before
// enabling recovery. This enrolls offline denial identities, never read rights.
async function initializeContextRecoveryStorage(sessions, storage) {
  try {
    const attach = storageAttachments.get(sessions);
    if (!attach) throw storageFailure();
    const result = await attach(storage, true, true);
    if (!result?.ok) throw storageFailure();
    return { ok: true };
  } catch {
    throw storageFailure();
  }
}

module.exports = {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  exportContextRecoveryRootMetadata,
  acquireContextRecoveryRoot,
  restoreContextRecoverySessions,
  adoptContextRecoveryRoots,
  probeContextRecoveryRoots,
  attachContextRecoveryReaderStorage,
  attachContextRecoveryStorage,
  initializeContextRecoveryStorage,
};
