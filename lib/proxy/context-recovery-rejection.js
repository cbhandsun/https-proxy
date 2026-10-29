'use strict';

const blockedAdmission = new Set([
  'context_recovery_busy',
  'context_recovery_storage_unavailable',
  'context_recovery_binding_changed',
  'context_recovery_scope_unavailable',
  'context_recovery_source_conflict',
  'context_recovery_ambiguous',
  'context_recovery_disabled',
  'context_binding_conflict',
  'context_binding_unavailable',
  'context_binding_ancestor_unavailable',
  'invalid_recovery_results',
]);
const ordinaryControls = new Set([
  'context_recovery_controls_unsupported',
  'context_recovery_tools_unsupported',
  'context_recovery_tool_collision',
]);

function failureCode(result) {
  if (!result || typeof result !== 'object') return undefined;
  const ok = Object.getOwnPropertyDescriptor(result, 'ok');
  const code = Object.getOwnPropertyDescriptor(result, 'code');
  return ok?.value === false && typeof code?.value === 'string' ? code.value : undefined;
}

// Contention or unavailable authenticated state is not an unobserved request.
// Ordinary forwarding could omit private results required by its ancestor.
function blocksRecoveryAdmission(result) {
  return blockedAdmission.has(failureCode(result));
}

function permitsOrdinaryRecoveryControls(result) {
  return ordinaryControls.has(failureCode(result));
}

module.exports = { blocksRecoveryAdmission, permitsOrdinaryRecoveryControls };
