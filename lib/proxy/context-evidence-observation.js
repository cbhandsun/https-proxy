'use strict';

// Session-owned provenance on reader results; never supplied by a model.
const CONTEXT_EVIDENCE_OBSERVATION_RESERVE_BYTES = 96;
const tagContextEvidenceResult = (result) => ({
  ...result,
  observation: 'client_reported',
  verification: 'not_verified',
});
module.exports = { tagContextEvidenceResult, CONTEXT_EVIDENCE_OBSERVATION_RESERVE_BYTES };
