'use strict';

const {
  storageData,
  storageFailure,
  STORAGE_TTL_MS,
} = require('./context-recovery-storage-contract');
const { parseEvidenceBudgetState } = require('./context-evidence-budget-state');
const {
  MAX_READER_CALLS,
  MAX_READER_BYTES,
  MAX_READER_RESULT_BYTES,
} = require('./context-evidence-page');
const {
  createContextEvidenceTools,
  createContextEvidenceBudget,
  restoreContextEvidenceBudget,
  exportContextEvidenceBudget,
  LIST_EVIDENCE_TOOL,
  READ_EVIDENCE_TOOL,
} = require('./context-evidence-tools');

function budgetRecord(input) {
  const value = storageData(input, 2048);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'budget,kind,version' ||
    value.kind !== 'reader-budget' ||
    value.version !== 1
  )
    throw storageFailure();
  const budget = parseEvidenceBudgetState(value.budget);
  // This separate gateway primitive retains its original lifetime semantics.
  if (budget.version !== 1) throw storageFailure();
  return budget;
}
const record = (budget) => ({ version: 1, kind: 'reader-budget', budget });

function savedRevision(input, expected) {
  const value = storageData(input, 1024);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'revision' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision !== expected
  )
    throw storageFailure();
  return value.revision;
}

function loadedBudget(input) {
  if (input === null) return null;
  const value = storageData(input, 4096);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'createdAt,expiresAt,revision,state' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > STORAGE_TTL_MS
  )
    throw storageFailure();
  budgetRecord(value.state);
  return value;
}

// The trusted caller supplies a live authorized ledger and its own persistence
// scope. Stored accounting never creates ledger authority. This separate budget
// record is an integration primitive, not a restored production session.
async function createDurableEvidenceTools(options = {}) {
  let execute, ledger, scope, expiresAt, definitions;
  try {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      throw storageFailure();
    const safe = {};
    for (const name of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, name);
      if (
        !['ledger', 'storage', 'scope', 'expiresAt'].includes(name) ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      )
        throw storageFailure();
      safe[name] = descriptor.value;
    }
    ({ ledger, scope, expiresAt } = safe);
    const storage = safe.storage;
    const descriptor = storage && Object.getOwnPropertyDescriptor(storage, 'execute');
    if (
      !descriptor ||
      typeof descriptor.value !== 'function' ||
      typeof scope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(scope) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 0
    )
      throw storageFailure();
    execute = descriptor.value.bind(storage);
    definitions = createContextEvidenceTools(ledger).definitions;
    const loaded = loadedBudget(await execute({ operation: 'load', scope }));
    if (loaded === null) {
      savedRevision(
        await execute({
          operation: 'save',
          scope,
          expectedRevision: 0,
          expiresAt,
          state: record(exportContextEvidenceBudget(createContextEvidenceBudget())),
        }),
        1
      );
    }
  } catch {
    throw storageFailure();
  }
  let active = false,
    closed = false;
  function live() {
    if (closed) throw storageFailure();
  }
  return {
    definitions,
    async reply(name, args) {
      if (![LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL].includes(name)) return null;
      if (closed || active) return { ok: false, code: 'context_evidence_unavailable' };
      active = true;
      try {
        const loaded = loadedBudget(await execute({ operation: 'load', scope }));
        live();
        if (!loaded) throw storageFailure();
        const before = budgetRecord(loaded.state);
        if (before.calls >= MAX_READER_CALLS || before.returnedBytes >= MAX_READER_BYTES)
          return { ok: false, code: 'evidence_read_budget_exceeded' };
        const capacity = Math.min(MAX_READER_RESULT_BYTES, MAX_READER_BYTES - before.returnedBytes);
        const reserved = {
          ...before,
          calls: before.calls + 1,
          returnedBytes: before.returnedBytes + capacity,
        };
        // Commit the maximum possible debit before touching the ledger. A crash
        // or an uncertain final write retains that debit rather than granting a
        // fresh allowance. Revision conflicts are failures, never automatic retries.
        const reservation = savedRevision(
          await execute({
            operation: 'save',
            scope,
            expectedRevision: loaded.revision,
            expiresAt: loaded.expiresAt,
            state: record(reserved),
          }),
          loaded.revision + 1
        );
        live();
        const token = restoreContextEvidenceBudget(before);
        const tools = createContextEvidenceTools(ledger, token);
        const result = tools.reply(name, args);
        const after = exportContextEvidenceBudget(token);
        if (
          after.calls !== reserved.calls ||
          after.returnedBytes < before.returnedBytes ||
          after.returnedBytes > reserved.returnedBytes ||
          after.successfulReads < before.successfulReads ||
          after.successfulReads > before.successfulReads + 1
        )
          throw storageFailure();
        savedRevision(
          await execute({
            operation: 'save',
            scope,
            expectedRevision: reservation,
            expiresAt: loaded.expiresAt,
            state: record(after),
          }),
          reservation + 1
        );
        live();
        return result;
      } catch {
        return { ok: false, code: 'context_evidence_unavailable' };
      } finally {
        active = false;
      }
    },
    close() {
      closed = true;
    },
  };
}

module.exports = { createDurableEvidenceTools };
