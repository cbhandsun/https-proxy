'use strict';

const {
  parseEvidenceBudgetState,
  budgetFailure,
  evidenceBudgetLimits,
} = require('./context-evidence-budget-state');
const { MAX_READER_RESULT_BYTES } = require('./context-evidence-page');
const budgets = new WeakMap();
const pending = new WeakMap();
const reservations = new WeakMap();

function isContextEvidenceBudget(token) {
  return budgets.has(token);
}

function stateFor(token) {
  const state = budgets.get(token);
  if (!state) throw budgetFailure();
  return state;
}
function counters(value) {
  return {
    version: value.version,
    calls: value.calls,
    returnedBytes: value.returnedBytes,
    successfulReads: value.successfulReads,
  };
}
function restoreContextEvidenceBudget(input) {
  const parsed = parseEvidenceBudgetState(input);
  const token = Object.freeze({});
  budgets.set(token, counters(parsed));
  return token;
}
function createContextEvidenceBudget() {
  return restoreContextEvidenceBudget({
    version: 1,
    calls: 0,
    returnedBytes: 0,
    successfulReads: 0,
  });
}
function createContextEvidenceTaskBudget() {
  return restoreContextEvidenceBudget({
    version: 2,
    calls: 0,
    returnedBytes: 0,
    successfulReads: 0,
  });
}
function exportContextEvidenceBudget(token) {
  return parseEvidenceBudgetState(stateFor(token));
}
function checked(token) {
  const entry = reservations.get(token);
  if (!entry || pending.get(entry.budget) !== entry) throw budgetFailure();
  return entry;
}

// Owner-side write-ahead debit. Mutate the existing object so every previously
// created reader sees the same debit; never replace its captured reference.
function reserveContextEvidenceBudget(budget) {
  const state = stateFor(budget);
  const limits = evidenceBudgetLimits(state.version);
  if (
    pending.has(budget) ||
    state.calls >= limits.maxCalls ||
    state.returnedBytes >= limits.maxBytes
  )
    throw budgetFailure();
  const before = counters(state);
  const reserved = {
    ...before,
    calls: before.calls + 1,
    returnedBytes:
      before.returnedBytes +
      Math.min(MAX_READER_RESULT_BYTES, limits.maxBytes - before.returnedBytes),
  };
  const token = Object.freeze({});
  const entry = { budget, before, reserved, after: counters(before), used: false };
  Object.assign(state, reserved);
  pending.set(budget, entry);
  reservations.set(token, entry);
  return token;
}

// Called only by the tool implementation. Ordinary readers are paused while
// the owner awaits pre-debit/settlement. A reservation admits exactly one call.
function evidenceBudgetReaderState(budget, reservation) {
  const state = stateFor(budget);
  if (reservation === undefined) return pending.has(budget) ? null : state;
  const entry = checked(reservation);
  if (entry.budget !== budget || entry.used) throw budgetFailure();
  entry.used = true;
  return entry.after;
}
function exportContextEvidenceReservation(token) {
  const entry = checked(token);
  const after = parseEvidenceBudgetState(entry.after);
  if (
    !entry.used ||
    after.calls !== entry.reserved.calls ||
    after.returnedBytes < entry.before.returnedBytes ||
    after.returnedBytes > entry.reserved.returnedBytes ||
    after.successfulReads < entry.before.successfulReads ||
    after.successfulReads > entry.before.successfulReads + 1
  )
    throw budgetFailure();
  return after;
}
function settleContextEvidenceReservation(token) {
  const entry = checked(token);
  const after = exportContextEvidenceReservation(token);
  Object.assign(stateFor(entry.budget), counters(after));
  pending.delete(entry.budget);
  reservations.delete(token);
}
function abandonContextEvidenceReservation(token) {
  const entry = checked(token);
  Object.assign(stateFor(entry.budget), entry.reserved);
  pending.delete(entry.budget);
  reservations.delete(token);
}

module.exports = {
  isContextEvidenceBudget,
  createContextEvidenceBudget,
  createContextEvidenceTaskBudget,
  restoreContextEvidenceBudget,
  exportContextEvidenceBudget,
  reserveContextEvidenceBudget,
  evidenceBudgetReaderState,
  exportContextEvidenceReservation,
  settleContextEvidenceReservation,
  abandonContextEvidenceReservation,
};
