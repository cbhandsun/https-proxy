'use strict';

const { types } = require('node:util');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { parseReferenceState } = require('./context-recovery-reference-state');
const { parseReaderSettlement } = require('./context-recovery-reader-settlement');
const {
  parseEvidenceBudgetState,
  evidenceBudgetLimits,
} = require('./context-evidence-budget-state');
const {
  parseStoredEvidencePage,
  parseStoredEvidenceSource,
} = require('./context-evidence-stored-page');
const { parseContextEvidenceRequest } = require('./context-evidence-request');
const { encodeContextEvidenceOutput } = require('./context-evidence-output');
const {
  tagContextEvidenceResult,
  CONTEXT_EVIDENCE_OBSERVATION_RESERVE_BYTES,
} = require('./context-evidence-observation');
const {
  MAX_READER_RESULT_BYTES,
  EVIDENCE_ENVELOPE_RESERVE_BYTES,
} = require('./context-evidence-page');
const { storageFailure } = require('./context-recovery-storage-contract');

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const equalBudget = (a, b) =>
  ['version', 'calls', 'returnedBytes', 'successfulReads'].every((name) => a[name] === b[name]);

// Trusted owner-to-storage reservation facts. This never grants source access:
// the engine still pins the existing scope, revision, ciphertext and transaction.
function validateRecoveryReadReservation(inputReference, inputRequest, time) {
  try {
    if (types.isProxy(inputRequest)) throw storageFailure();
    const reference = parseReferenceState(inputReference);
    const request = normalizeCompactionData(inputRequest, 16384);
    if (
      !request ||
      Array.isArray(request) ||
      Object.keys(request).sort().join(',') !==
        'arguments,beforeBudget,expectedRevision,maxResultBytes,observedAt,operation,scope,source' ||
      request.operation !== 'read-source-and-settle' ||
      typeof request.scope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.scope) ||
      !integer(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !integer(request.observedAt) ||
      !Number.isSafeInteger(request.maxResultBytes) ||
      request.maxResultBytes <= 0 ||
      request.maxResultBytes >
        MAX_READER_RESULT_BYTES -
          EVIDENCE_ENVELOPE_RESERVE_BYTES -
          CONTEXT_EVIDENCE_OBSERVATION_RESERVE_BYTES
    )
      throw storageFailure();
    const root = reference.metadata;
    const before = parseEvidenceBudgetState(request.beforeBudget);
    const limits = evidenceBudgetLimits(before.version);
    if (
      before.calls >= limits.maxCalls ||
      before.returnedBytes >= limits.maxBytes ||
      !integer(time) ||
      request.observedAt !== root.observedAt ||
      time < request.observedAt ||
      time >= root.expiresAt
    )
      throw storageFailure();
    const reserved = {
      ...before,
      calls: before.calls + 1,
      returnedBytes:
        before.returnedBytes +
        Math.min(MAX_READER_RESULT_BYTES, limits.maxBytes - before.returnedBytes),
    };
    if (!equalBudget(root.budget, reserved)) throw storageFailure();
    const expected = parseStoredEvidenceSource(request.source);
    const args = parseContextEvidenceRequest('hpm_read_retained_evidence', request.arguments);
    const source = [...root.ledger.sources, ...reference.stagedSources].find(
      (item) => item.sourceId === expected.sourceId
    );
    if (
      !args.ok ||
      !source ||
      source.expiresAt <= time ||
      args.arguments.sourceId !== expected.sourceId ||
      args.arguments.digest !== expected.digest ||
      Object.keys(expected).some((name) => name !== 'trust' && expected[name] !== source[name])
    )
      throw storageFailure();
    return { reference, request, root, before, reserved, expected, args, source };
  } catch {
    throw storageFailure();
  }
}

// This private, one-use closure owns normalized reservation facts inside the
// same synchronous SQL transaction. Validate before source I/O, then validate
// the returned page without parsing the same reservation for a second time.
function prepareRecoveryReadSettlement(inputReference, inputRequest, time) {
  let reservation = validateRecoveryReadReservation(inputReference, inputRequest, time);
  return Object.freeze((inputPage) => {
    const selected = reservation;
    reservation = null;
    if (!selected) throw storageFailure();
    return settleValidatedRecoveryRead(selected, inputPage, time);
  });
}

function createRecoveryReadSettlement(inputReference, inputRequest, inputPage, time) {
  return prepareRecoveryReadSettlement(inputReference, inputRequest, time)(inputPage);
}

function settleValidatedRecoveryRead(reservation, inputPage, time) {
  try {
    const { request, root, before, reserved, expected, args, source } = reservation;
    const page = parseStoredEvidencePage(
      inputPage,
      expected,
      args.arguments,
      request.maxResultBytes
    );
    const encoded = encodeContextEvidenceOutput(tagContextEvidenceResult(page));
    const capacity =
      request.maxResultBytes +
      EVIDENCE_ENVELOPE_RESERVE_BYTES +
      CONTEXT_EVIDENCE_OBSERVATION_RESERVE_BYTES;
    if (encoded.bytes > capacity || before.returnedBytes + encoded.bytes > reserved.returnedBytes)
      throw storageFailure();
    let coveredThrough = source.coveredThrough,
      readComplete = source.readComplete;
    if (page.ok && page.page.offsetBytes <= coveredThrough) {
      coveredThrough = Math.max(coveredThrough, page.page.endOffsetBytes);
      readComplete = coveredThrough === source.bytes;
    }
    return parseReaderSettlement({
      version: 2,
      kind: 'recovery-reader-settlement',
      rootId: root.rootId,
      observedAt: time,
      budget: {
        ...before,
        calls: reserved.calls,
        returnedBytes: before.returnedBytes + encoded.bytes,
        successfulReads: before.successfulReads + (page.ok ? 1 : 0),
      },
      ledger: {
        readCount: root.ledger.readCount + (page.ok ? 1 : 0),
        sources:
          coveredThrough === source.coveredThrough && readComplete === source.readComplete
            ? []
            : [{ sourceId: source.sourceId, coveredThrough, readComplete }],
      },
    });
  } catch {
    throw storageFailure();
  }
}

// The host samples time again after receiving the committed page. All accounting
// and progress must match exactly; that later host time is not claimed durable.
function assertRecoveryReadSettlement(committedInput, actualInput) {
  try {
    const committed = parseReaderSettlement(committedInput),
      actual = parseReaderSettlement(actualInput);
    if (
      committed.version !== 2 ||
      actual.version !== 2 ||
      committed.rootId !== actual.rootId ||
      committed.observedAt > actual.observedAt ||
      !equalBudget(committed.budget, actual.budget) ||
      committed.ledger.readCount !== actual.ledger.readCount ||
      committed.ledger.sources.length !== actual.ledger.sources.length ||
      committed.ledger.sources.some((source, index) =>
        ['sourceId', 'coveredThrough', 'readComplete'].some(
          (name) => source[name] !== actual.ledger.sources[index][name]
        )
      )
    )
      throw storageFailure();
  } catch {
    throw storageFailure();
  }
}

module.exports = {
  createRecoveryReadSettlement,
  prepareRecoveryReadSettlement,
  assertRecoveryReadSettlement,
  validateRecoveryReadReservation,
};
