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
// A fresh isolated N09 owner has three admitted seed/summary requests before
// its first recovery. These cumulative counters classify that failed request
// only; they do not prove why a bound turn omitted private tools.
function recoveryAdmissionFailurePhase(input) {
  try {
    const reply = snapshotOwnData(input);
    if (reply.status !== 200) return 224;
    const body = snapshotOwnData(reply.body);
    const recovery = snapshotOwnData(body.contextRecovery);
    const counters = snapshotOwnData(recovery.counters);
    const response = snapshotOwnData(counters.responses);
    for (const name of [...events, 'bound', 'bindingUnavailable', 'completed']) {
      if (!Number.isSafeInteger(response[name]) || response[name] < 0) return 224;
    }
    if (events.some((name) => response[name] !== 0) || response.completed < 1) return 224;
    if (response.bindingUnavailable > 0) return 200;
    return response.bound >= 4 ? 202 : 210;
  } catch {
    return 224;
  }
}

module.exports = { recoveryFailurePhase, recoveryAdmissionFailurePhase };
