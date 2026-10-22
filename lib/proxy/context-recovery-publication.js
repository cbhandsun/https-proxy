'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

const methods = {
  prepare: ['completeAsync', 'complete'],
  public: ['completePublicAsync', 'completeAsync', 'complete'],
  observed: ['completeObservedAsync', 'complete'],
  compaction: ['completeCompactionAsync', 'completeCompaction'],
  sending: ['startPublicationAsync'],
  finished: ['finishPublicationAsync'],
  withdraw: ['withdrawAsync', 'withdraw'],
  abort: ['abortAsync', 'abort'],
};
function publicationFailure() {
  return new Error('Recovery publication unavailable');
}

// A resolved Promise object is not an acknowledgement. Neither executable
// thenables nor accessor methods/results are assimilated or invoked.
async function invokeRecoveryPublication(session, action, args = []) {
  const names =
    typeof action === 'string' && Object.hasOwn(methods, action) ? methods[action] : null;
  if (!names) throw publicationFailure();
  let selected, name;
  for (const candidate of names) {
    const slot = session && Object.getOwnPropertyDescriptor(session, candidate);
    if (!slot) continue;
    if (typeof slot.value !== 'function') throw publicationFailure();
    selected = slot.value;
    name = candidate;
    break;
  }
  if (!selected) {
    if (action === 'sending' || action === 'finished') return { ok: true };
    throw publicationFailure();
  }
  try {
    const pending = selected.apply(session, args);
    const raw = nativeReaderPromise(pending) ? await pending : pending;
    if (raw === undefined && ['withdraw', 'abort'].includes(name)) return { ok: true };
    const value = normalizeCompactionData(raw, 4096);
    if (!value || Array.isArray(value) || value.ok !== true) throw publicationFailure();
    return { ok: true };
  } catch {
    throw publicationFailure();
  }
}

module.exports = { invokeRecoveryPublication };
