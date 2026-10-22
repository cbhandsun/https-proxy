'use strict';

// Counts come only from the authorized branch view, never the shared ledger.
// Pending outputs, policy refusals and capacity losses all lack retained bytes;
// these counts cannot assert completeness of an unobserved conversation.
function projectContextEvidenceCoverage(observedCalls, availableSources, maximum = 128) {
  if (
    ![128, 1024].includes(maximum) ||
    !Number.isSafeInteger(observedCalls) ||
    observedCalls < 0 ||
    observedCalls > maximum ||
    !Number.isSafeInteger(availableSources) ||
    availableSources < 0 ||
    availableSources > observedCalls
  )
    throw new TypeError('invalid_context_evidence_coverage');
  return {
    scope: 'observed_calls_on_branch',
    state:
      observedCalls === 0
        ? 'no_observed_calls'
        : availableSources === observedCalls
          ? 'complete_for_observed_calls'
          : 'incomplete_or_pending',
    observedCalls,
    availableSources,
    unavailableOrPendingCalls: observedCalls - availableSources,
  };
}

module.exports = { projectContextEvidenceCoverage };
