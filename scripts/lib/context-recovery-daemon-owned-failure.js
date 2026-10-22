'use strict';

// Only errors created here carry diagnostics. Never inspect errors supplied by
// processes, HTTP peers or injected dependencies (including their getters).
const diagnostics = new WeakMap();
const PRELOAD_PHASES = Object.freeze(['unobserved', 'entered', 'passed', 'failed']);
const CAUSES = Object.freeze([
  'setup',
  'process_start',
  'job_assign',
  'gate_release',
  'rpc_deadline',
  'controller_exit',
  'controller_protocol',
  'controller_pipe',
  'controller_start',
  'controller_cleanup',
  'launch_input',
  'start_rpc',
  'identity_rejected',
  'status_rpc',
  'daemon_exited',
  'readiness_deadline',
  'health_request_failed',
  'ready_health_rejected',
  'config_rejected',
  'credentials_rejected',
  'stop_failed',
  'close_failed',
]);
function ownedFailure(message, cause, cleanupCause = null, preloadPhase) {
  if (
    !['daemon_controller_failed', 'daemon_owned_adapter_failed'].includes(message) ||
    !CAUSES.includes(cause) ||
    (cleanupCause !== null && !CAUSES.includes(cleanupCause)) ||
    (preloadPhase !== undefined && !PRELOAD_PHASES.includes(preloadPhase))
  )
    throw new Error('daemon_diagnostic_rejected');
  const error = new Error(message);
  diagnostics.set(
    error,
    Object.freeze({ cause, cleanupCause, ...(preloadPhase === undefined ? {} : { preloadPhase }) })
  );
  return error;
}
function ownedDiagnostic(error) {
  return diagnostics.get(error) ?? null;
}
module.exports = { CAUSES, PRELOAD_PHASES, ownedFailure, ownedDiagnostic };
