'use strict';

const { createHash } = require('node:crypto');
const {
  storageData,
  storageReplyData,
  storageFailure,
  STORAGE_TTL_MS,
  supportsRecoverySourcePages,
  supportsRecoveryReaderSettlement,
  supportsRecoveryReferenceWrites,
  supportsRecoveryReferenceStates,
  supportsRecoveryReferenceAdmission,
  supportsRecoveryReadSettlement,
} = require('./context-recovery-storage-contract');
const { parseRootCheckpoint, createRootCheckpoint } = require('./context-recovery-root-checkpoint');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const {
  recoveryRootCapacity,
  validateRecoveryPublicationCounts,
} = require('./context-recovery-capacity');
const { discoverRecoveryStorage } = require('./context-recovery-storage-discovery');
const { parseRecoveryColdAdmission } = require('./context-recovery-cold-admission');
const { parseStoredEvidencePage } = require('./context-evidence-stored-page');
const {
  parseReaderSettlement,
  applyReaderSettlement,
  applyReferenceReaderSettlement,
} = require('./context-recovery-reader-settlement');
const { createReferenceWrite } = require('./context-recovery-reference-write');
const { createRecoveryDurableAck } = require('./context-recovery-durable-ack');
const {
  createRecoveryReadSettlement,
  assertRecoveryReadSettlement,
} = require('./context-recovery-read-settlement');
const {
  parseReferenceState,
  createReferenceState,
  validateReferenceTransition,
  validateReferenceAgainstCurrent,
} = require('./context-recovery-reference-state');

function saved(input, expected) {
  const value = storageData(input, 1024);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'revision' ||
    value.revision !== expected ||
    !Number.isSafeInteger(value.revision)
  )
    throw storageFailure();
  return value.revision;
}
function loaded(input, expected, currentReference) {
  if (input === null) return null;
  const value = storageReplyData(input, currentReference ? 'load-reference' : 'load');
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      (currentReference
        ? 'createdAt,expiresAt,reference,revision'
        : 'createdAt,expiresAt,revision,state') ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < expected.createdAt ||
    value.createdAt > expected.observedAt ||
    value.expiresAt !== expected.expiresAt ||
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > STORAGE_TTL_MS
  )
    throw storageFailure();
  if (currentReference) {
    value.reference = validateReferenceAgainstCurrent(value.reference, currentReference);
    return value;
  }
  value.state = parseRootCheckpoint(value.state, expected);
  if (fingerprintContextData(value.state.root.budget) !== fingerprintContextData(expected.budget))
    throw storageFailure();
  return value;
}
const journal = (value) =>
  [...value]
    .map(([snapshotId, state]) => ({ snapshotId, state }))
    .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));

const transitions = {
  unobserved: ['prepared', 'transport-finished', 'uncertain', 'withdrawn'],
  prepared: ['sending', 'uncertain', 'withdrawn'],
  sending: ['transport-finished', 'uncertain', 'withdrawn'],
  'transport-finished': ['withdrawn'],
  uncertain: ['withdrawn'],
  withdrawn: [],
};
function updatePublication(states, snapshotId, state) {
  const prior = states.get(snapshotId);
  if (
    !Object.hasOwn(transitions, prior) ||
    (state !== prior && !transitions[prior].includes(state))
  )
    throw storageFailure();
  states.set(snapshotId, state);
}

// Shared by read and publication transactions. The enclosing owner supplies
// exclusive live-root access; this service owns CAS/version and safe replies.
function createRecoveryRootStorage(storage) {
  const slot = storage && Object.getOwnPropertyDescriptor(storage, 'execute');
  if (typeof slot?.value !== 'function') throw storageFailure();
  const execute = slot.value.bind(storage),
    roots = new Map();
  let closed = false;
  let lifecycleFailed = false;
  let globalBarriers = 0;
  let generation = 0;
  let globalRevocation;
  let suspension;
  let discovering = false;
  let discovery;
  let tail = Promise.resolve();
  const lifecycle = new Set();
  function admitPublications(entry, states) {
    try {
      validateRecoveryPublicationCounts(
        [...roots.values()].map((item) => ({
          version: item.capacityVersion ?? 6,
          count:
            item === entry ? states.size : (item.pendingPublications ?? item.publications).size,
        }))
      );
    } catch {
      throw storageFailure();
    }
  }
  async function call(request, entry) {
    const pending = (async () => {
      const result = execute(request);
      return storageReplyData(
        nativeReaderPromise(result) ? await result : result,
        request.operation
      );
    })();
    entry?.pending.add(pending);
    try {
      return await pending;
    } finally {
      entry?.pending.delete(pending);
    }
  }
  function enroll(input) {
    const root = storageData(input, 1024);
    if (
      !root ||
      Array.isArray(root) ||
      Object.keys(root).sort().join(',') !== 'createdAt,expiresAt,principal,rootId' ||
      typeof root.rootId !== 'string' ||
      !/^hbs_[a-f0-9]{32}$/.test(root.rootId) ||
      typeof root.principal !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(root.principal) ||
      !Number.isSafeInteger(root.createdAt) ||
      root.createdAt < 0 ||
      !Number.isSafeInteger(root.expiresAt) ||
      root.expiresAt <= root.createdAt ||
      root.expiresAt - root.createdAt > STORAGE_TTL_MS
    )
      throw storageFailure();
    for (const [id, retained] of roots) {
      if (retained.expiresAt <= root.createdAt && !retained.pending.size) {
        retained.invalidated = true;
        roots.delete(id);
      }
    }
    let entry = roots.get(root.rootId);
    if (entry) {
      if (['principal', 'createdAt', 'expiresAt'].some((key) => entry[key] !== root[key]))
        throw storageFailure();
      return entry;
    }
    if ([...roots.values()].filter((item) => !item.invalidated).length >= 4 || roots.size >= 256)
      throw storageFailure();
    entry = {
      principal: root.principal,
      createdAt: root.createdAt,
      expiresAt: root.expiresAt,
      scope: createHash('sha256')
        .update('hpm/recovery-root/v1\0' + root.rootId)
        .digest('hex'),
      revision: 0,
      failed: false,
      publications: new Map(),
      pending: new Set(),
      invalidated: false,
    };
    roots.set(root.rootId, entry);
    generation++;
    return entry;
  }
  function enqueue(entries, all, retain = false) {
    for (const entry of entries) {
      entry.invalidated = true;
      if (retain) entry.suspended = !entry.revoking;
      else {
        entry.revoking = true;
        entry.suspended = false;
      }
    }
    if (all) globalBarriers++;
    const task = tail.then(async () => {
      try {
        await Promise.allSettled(entries.flatMap((entry) => [...entry.pending]));
        if (retain) {
          if (lifecycleFailed) throw storageFailure();
          if (closed) return { ok: true };
          // Rotate transaction epochs, retaining the denial index for explicit
          // principal revocation. Old transactions keep invalidated objects;
          // fresh authorization must reload CAS/publication state from storage.
          for (const [id, entry] of roots) {
            if (!entries.includes(entry) || entry.revoking) continue;
            roots.set(id, {
              ...entry,
              revision: 0,
              failed: false,
              invalidated: false,
              suspended: false,
              pending: new Set(),
              publications: new Map(),
            });
          }
          generation++;
          return { ok: true };
        }
        const request = all
          ? { operation: 'revoke-all' }
          : {
              operation: 'revoke-scopes',
              entries: entries.map(({ scope, createdAt, expiresAt }) => ({
                scope,
                createdAt,
                expiresAt,
              })),
            };
        const result = await call(request);
        if (
          !result ||
          Array.isArray(result) ||
          Object.keys(result).join(',') !== 'revoked' ||
          !Number.isSafeInteger(result.revoked) ||
          result.revoked < 0 ||
          result.revoked > (all ? 256 : entries.length) ||
          (!all && result.revoked !== entries.length)
        )
          throw storageFailure();
        for (const entry of entries) entry.publications.clear();
        return { ok: true };
      } catch {
        lifecycleFailed = true;
        return { ok: false, code: 'context_recovery_storage_unavailable' };
      } finally {
        if (all) globalBarriers--;
      }
    });
    tail = task;
    lifecycle.add(task);
    void task.then(() => lifecycle.delete(task));
    return task;
  }
  const service = {
    supportsSourcePages() {
      return supportsRecoverySourcePages(slot.value);
    },
    supportsReaderSettlement() {
      return supportsRecoveryReaderSettlement(slot.value);
    },
    supportsReferenceStates() {
      return (
        supportsRecoveryReferenceStates(slot.value) &&
        supportsRecoverySourcePages(slot.value) &&
        supportsRecoveryReaderSettlement(slot.value)
      );
    },
    supportsReferenceAdmission() {
      return service.supportsReferenceStates() && supportsRecoveryReferenceAdmission(slot.value);
    },
    observeReference(input) {
      if (!service.supportsReferenceAdmission()) return false;
      let entry;
      try {
        if (closed || globalBarriers || lifecycleFailed) throw storageFailure();
        const facts = parseRecoveryColdAdmission(input);
        entry = roots.get(facts.root.rootId);
        if (
          !entry ||
          entry.failed ||
          entry.invalidated ||
          entry.pending.size ||
          entry.revision !== 0 ||
          facts.scope !== entry.scope ||
          ['principal', 'createdAt', 'expiresAt'].some(
            (name) => entry[name] !== facts.root[name]
          ) ||
          (entry.capacityVersion !== undefined &&
            (entry.capacityVersion !== facts.capacityVersion ||
              entry.historyFormat !== facts.historyFormat))
        )
          throw storageFailure();
        entry.capacityVersion = facts.capacityVersion;
        entry.historyFormat = facts.historyFormat;
        const states = new Map(
          facts.publications.map(({ snapshotId, state }) => [snapshotId, state])
        );
        admitPublications(entry, states);
        entry.revision = facts.revision;
        entry.sourceIds = new Set(facts.sourceIds);
        entry.publications = states;
        return true;
      } catch {
        if (entry) entry.failed = true;
        throw storageFailure();
      }
    },
    discover() {
      if (closed) return Promise.reject(storageFailure());
      if (discovery) return discovery;
      if (closed || globalBarriers || lifecycleFailed || roots.size)
        return Promise.reject(storageFailure());
      discovering = true;
      globalBarriers++;
      discovery = (async () => {
        try {
          const entries = await discoverRecoveryStorage(storage, () => !closed && !lifecycleFailed);
          if (closed || lifecycleFailed) throw storageFailure();
          // Discovery validated the complete generation before enrollment.
          for (const entry of entries) enroll(entry);
          return { ok: true, roots: entries.length };
        } catch {
          lifecycleFailed = true;
          throw storageFailure();
        } finally {
          discovering = false;
          globalBarriers--;
        }
      })();
      lifecycle.add(discovery);
      void discovery.then(
        () => lifecycle.delete(discovery),
        () => lifecycle.delete(discovery)
      );
      return discovery;
    },
    registerRoot(input) {
      if (closed || globalBarriers || lifecycleFailed) throw storageFailure();
      enroll(input);
    },
    admitRoot(input) {
      if (closed || globalBarriers || lifecycleFailed) throw storageFailure();
      const entry = enroll(input);
      if (entry.invalidated || entry.failed) throw storageFailure();
    },
    async begin(checkpoint, payloads, deferAdmission = false, reader = false) {
      if (closed || globalBarriers || lifecycleFailed) throw storageFailure();
      if (typeof deferAdmission !== 'boolean' || typeof reader !== 'boolean')
        throw storageFailure();
      let root;
      let referenceOnly = false;
      try {
        checkpoint = storageData(checkpoint);
        referenceOnly = checkpoint.kind === 'recovery-reference-state';
        if (referenceOnly) {
          if (!service.supportsReferenceStates() || typeof payloads !== 'function')
            throw storageFailure();
          checkpoint = parseReferenceState(checkpoint);
          root = checkpoint.metadata;
        } else {
          root = checkpoint.root;
          parseRootCheckpoint(checkpoint, root);
        }
      } catch {
        throw storageFailure();
      }
      for (const [id, item] of roots) if (item.expiresAt <= root.observedAt) roots.delete(id);
      const entry = enroll({
        rootId: root.rootId,
        principal: root.principal,
        createdAt: root.createdAt,
        expiresAt: root.expiresAt,
      });
      if (entry.failed || entry.invalidated) throw storageFailure();
      const capacityVersion = referenceOnly ? root.sourceVersion : root.version;
      const historyFormat = root.binding.format ?? 2;
      if (
        entry.capacityVersion !== undefined &&
        (recoveryRootCapacity(entry.capacityVersion) !== recoveryRootCapacity(capacityVersion) ||
          entry.historyFormat !== historyFormat)
      )
        throw storageFailure();
      entry.capacityVersion = capacityVersion;
      entry.historyFormat = historyFormat;
      const scope = entry.scope;
      let last = checkpoint;
      const readerBeforeBudget = reader ? storageData(root.budget, 1024) : null;
      let combinedRead;
      let persisted = null;
      let admission = null;
      let sourceIds;
      try {
        const views = new Set(root.snapshots.map((view) => view.id));
        if (
          deferAdmission &&
          referenceOnly &&
          service.supportsReferenceAdmission() &&
          entry.revision > 0 &&
          entry.sourceIds &&
          [...entry.publications].every(
            ([id, state]) => views.has(id) || ['uncertain', 'withdrawn'].includes(state)
          )
        ) {
          admission = createReferenceState(
            checkpoint.metadata,
            checkpoint.stagedSources,
            journal(entry.publications)
          );
          sourceIds = new Set(entry.sourceIds);
        } else {
          const record = loaded(
            await call({ operation: referenceOnly ? 'load-reference' : 'load', scope }, entry),
            root,
            referenceOnly ? checkpoint : null
          );
          persisted = (referenceOnly ? record?.reference : record?.state) ?? null;
          if (entry.invalidated || closed || lifecycleFailed) throw storageFailure();
          if ((record?.revision ?? 0) < entry.revision) throw storageFailure();
          const storedJournal = new Map(
            (persisted?.publications ?? []).map((item) => [item.snapshotId, item.state])
          );
          admitPublications(entry, storedJournal);
          if (
            entry.revision &&
            fingerprintContextData(journal(storedJournal)) !==
              fingerprintContextData(journal(entry.publications))
          )
            throw storageFailure();
          entry.revision = record?.revision ?? 0;
          entry.publications = storedJournal;
          if (referenceOnly) {
            sourceIds = new Set(
              persisted
                ? [...persisted.metadata.ledger.sources, ...persisted.stagedSources].map(
                    (source) => source.sourceId
                  )
                : []
            );
            entry.sourceIds = new Set(sourceIds);
          }
        }
      } catch {
        entry.failed = true;
        throw storageFailure();
      }
      return {
        fail() {
          entry.failed = true;
        },
        async settleReader(input) {
          if (
            admission ||
            closed ||
            globalBarriers ||
            lifecycleFailed ||
            entry.failed ||
            entry.invalidated
          )
            throw storageFailure();
          try {
            const settlement = parseReaderSettlement(input);
            if (combinedRead) {
              if (combinedRead.settled) throw storageFailure();
              assertRecoveryReadSettlement(combinedRead.settlement, settlement);
              combinedRead.settled = true;
              return;
            }
            const state = referenceOnly
              ? applyReferenceReaderSettlement(last, settlement)
              : applyReaderSettlement(last, settlement);
            const revision = saved(
              await call(
                {
                  operation: 'settle-reader',
                  scope,
                  expectedRevision: entry.revision,
                  settlement,
                },
                entry
              ),
              entry.revision + 1
            );
            if (entry.invalidated || closed || lifecycleFailed) throw storageFailure();
            entry.revision = revision;
            last = state;
            persisted = state;
            if (referenceOnly) {
              sourceIds = new Set(
                [...state.metadata.ledger.sources, ...state.stagedSources].map(
                  (source) => source.sourceId
                )
              );
              entry.sourceIds = new Set(sourceIds);
            }
          } catch {
            entry.failed = true;
            throw storageFailure();
          }
        },
        async readSource(source, args, maxResultBytes) {
          if (
            admission ||
            closed ||
            globalBarriers ||
            lifecycleFailed ||
            entry.failed ||
            entry.invalidated
          )
            throw storageFailure();
          try {
            if (
              referenceOnly &&
              reader &&
              supportsRecoveryReadSettlement(slot.value) &&
              maxResultBytes > 0 &&
              maxResultBytes <= 16224
            ) {
              if (combinedRead) throw storageFailure();
              // Facts originate in this one owned reservation, never model args.
              const request = {
                operation: 'read-source-and-settle',
                scope,
                expectedRevision: entry.revision,
                source,
                arguments: args,
                maxResultBytes,
                beforeBudget: readerBeforeBudget,
                observedAt: last.metadata.observedAt,
              };
              // No second read or fallback is permitted after an uncertain ACK.
              combinedRead = { settled: false };
              const result = await call(request, entry);
              if (closed || globalBarriers || lifecycleFailed || entry.failed || entry.invalidated)
                throw storageFailure();
              const revision = saved({ revision: result.revision }, entry.revision + 1);
              const page = parseStoredEvidencePage(result.page, source, args, maxResultBytes);
              const expected = createRecoveryReadSettlement(
                last,
                request,
                page,
                result.settlement.observedAt
              );
              if (fingerprintContextData(expected) !== fingerprintContextData(result.settlement))
                throw storageFailure();
              const state = applyReferenceReaderSettlement(last, result.settlement);
              combinedRead.settlement = result.settlement;
              entry.revision = revision;
              last = persisted = state;
              sourceIds = new Set(
                [...state.metadata.ledger.sources, ...state.stagedSources].map(
                  (value) => value.sourceId
                )
              );
              entry.sourceIds = new Set(sourceIds);
              return page;
            }
            const result = await call(
              {
                operation: 'read-source',
                scope,
                expectedRevision: entry.revision,
                source,
                arguments: args,
                maxResultBytes,
              },
              entry
            );
            if (closed || globalBarriers || lifecycleFailed || entry.failed || entry.invalidated)
              throw storageFailure();
            return parseStoredEvidencePage(result, source, args, maxResultBytes);
          } catch {
            // A failed or malformed durable read cannot be settled as an ordinary
            // model refusal. Keep its write-ahead debit and stop this root's I/O.
            entry.failed = true;
            throw storageFailure();
          }
        },
        async save(candidate, change) {
          if (closed || globalBarriers || lifecycleFailed || entry.failed || entry.invalidated)
            throw storageFailure();
          try {
            candidate = storageData(candidate);
            if (referenceOnly) {
              candidate = validateReferenceTransition(candidate, last);
            } else {
              const expected = { ...root, observedAt: candidate.root.observedAt };
              parseRootCheckpoint(candidate, expected);
              if (candidate.root.observedAt < last.root.observedAt) throw storageFailure();
            }
          } catch {
            throw storageFailure();
          }
          const states = new Map(entry.publications);
          const current = new Set(
            (referenceOnly ? candidate.metadata : candidate.root).snapshots.map((item) => item.id)
          );
          for (const [id, state] of states)
            if (!current.has(id) && state !== 'uncertain') states.set(id, 'withdrawn');
          for (const id of current) if (!states.has(id)) states.set(id, 'unobserved');
          if (change) {
            change = storageData(change, 1024);
            if (
              Object.keys(change).sort().join(',') !== 'snapshotId,state' ||
              !current.has(change.snapshotId) ||
              !['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn'].includes(
                change.state
              )
            )
              throw storageFailure();
            updatePublication(states, change.snapshotId, change.state);
          }
          if (entry.pendingPublications) throw storageFailure();
          admitPublications(entry, states);
          const state = referenceOnly
            ? createReferenceState(candidate.metadata, candidate.stagedSources, journal(states))
            : createRootCheckpoint(candidate.root, candidate.stagedSources, journal(states));
          if (!referenceOnly) parseRootCheckpoint(state, candidate.root);
          // Reserve before yielding to storage so concurrent roots cannot each
          // admit against the same unused legacy/global journal capacity.
          entry.pendingPublications = states;
          try {
            const known = new Set(
              sourceIds ??
                (referenceOnly && persisted
                  ? [...persisted.metadata.ledger.sources, ...persisted.stagedSources].map(
                      (source) => source.sourceId
                    )
                  : [])
            );
            const request = referenceOnly
              ? {
                  operation: 'save-reference-state',
                  scope,
                  expectedRevision: entry.revision,
                  expiresAt: root.expiresAt,
                  reference: state,
                  ...(admission ? { admission } : {}),
                  payloads: payloads(
                    [...state.metadata.ledger.sources, ...state.stagedSources]
                      .filter((source) => !known.has(source.sourceId))
                      .map((source) => source.sourceId)
                  ),
                }
              : supportsRecoveryReferenceWrites(slot.value)
                ? {
                    operation: 'save-reference',
                    scope,
                    expectedRevision: entry.revision,
                    expiresAt: root.expiresAt,
                    ...createReferenceWrite(state, persisted),
                  }
                : {
                    operation: 'save',
                    scope,
                    expectedRevision: entry.revision,
                    expiresAt: root.expiresAt,
                    state,
                  };
            const revision = saved(await call(request, entry), entry.revision + 1);
            if (entry.invalidated || closed || lifecycleFailed) throw storageFailure();
            entry.revision = revision;
            entry.publications = states;
            last = state;
            persisted = state;
            if (referenceOnly) {
              sourceIds = new Set(
                [...state.metadata.ledger.sources, ...state.stagedSources].map(
                  (source) => source.sourceId
                )
              );
              entry.sourceIds = new Set(sourceIds);
            }
            admission = null;
            return referenceOnly ? createRecoveryDurableAck(state, revision) : null;
          } catch {
            // An error may follow a durable commit. Retain the reservation in
            // the failed root's denial journal until authenticated reload.
            entry.publications = states;
            entry.failed = true;
            throw storageFailure();
          } finally {
            entry.pendingPublications = null;
          }
        },
        checkpoint() {
          return storageData(last);
        },
      };
    },
    close() {
      closed = true;
    },
    available() {
      return !closed && !globalBarriers && !lifecycleFailed;
    },
    revokePrincipal(principal) {
      if (
        discovering ||
        lifecycleFailed ||
        typeof principal !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(principal)
      )
        return Promise.resolve({ ok: false, code: 'context_recovery_storage_unavailable' });
      const entries = [...roots.values()].filter(
        (entry) => entry.principal === principal && (!entry.invalidated || entry.suspended)
      );
      return entries.length ? enqueue(entries, false) : service.drain();
    },
    revokeAll() {
      if (discovering)
        return Promise.resolve({ ok: false, code: 'context_recovery_storage_unavailable' });
      if (globalRevocation?.generation === generation) return globalRevocation.task;
      const task = enqueue([...roots.values()], true);
      globalRevocation = { generation, task };
      return task;
    },
    suspendAll() {
      if (discovering || closed || lifecycleFailed)
        return Promise.resolve({ ok: false, code: 'context_recovery_storage_unavailable' });
      if (suspension) return suspension;
      const task = enqueue([...roots.values()], true, true);
      suspension = task;
      void task.then(() => {
        if (suspension === task) suspension = undefined;
      });
      return task;
    },
    closeAsync() {
      const task = service.revokeAll();
      closed = true;
      return task;
    },
    async drain() {
      await Promise.allSettled([...lifecycle]);
      await Promise.allSettled([...roots.values()].flatMap((entry) => [...entry.pending]));
      return lifecycleFailed
        ? { ok: false, code: 'context_recovery_storage_unavailable' }
        : { ok: true };
    },
  };
  return service;
}

module.exports = { createRecoveryRootStorage };
