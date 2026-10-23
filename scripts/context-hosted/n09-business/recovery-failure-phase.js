'use strict';
const { snapshotOwnData } = require('../shared/boundary');
const events = Object.freeze([
  'httpPreparationFailed',
  'httpRunFailed',
  'httpEncodingFailed',
  'httpPrepareFailed',
  'httpSendingFailed',
  'httpPublishingFailed',
  'httpFinishFailed',
]);

// Called only after a failed HTTP recovery, never between a durable ACK and kill.
// The health reply stays local; only one finite stage may leave this boundary.
function recoveryFailurePhase(input) {
  try {
    const reply = snapshotOwnData(input);
    if (reply.status !== 200) return 224;
    const body = snapshotOwnData(reply.body);
    const recovery = snapshotOwnData(body.contextRecovery);
    const counters = snapshotOwnData(recovery.counters);
    const response = snapshotOwnData(counters.responses);
    const active = [];
    for (const [index, name] of events.entries()) {
      const value = response[name];
      if (!Number.isSafeInteger(value) || value < 0) return 224;
      if (value > 0) active.push(217 + index);
    }
    return active.length === 1 ? active[0] : 224;
  } catch {
    return 224;
  }
}
module.exports = { recoveryFailurePhase };
