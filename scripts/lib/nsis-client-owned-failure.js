'use strict';
const { types } = require('node:util');
const controllerStages = [
  'admission',
  'launch',
  'forward',
  'eof',
  'natural_exit',
  'job_cleanup',
  'process_cleanup',
  'drain',
  'final_identity',
  'natural_exit_timeout',
  'natural_exit_code',
];
const OWNED_STOP_CODES = Object.freeze(
  [
    ...[
      'timeout',
      'controller_exit',
      'controller_signal',
      'stream',
      'spec',
      'identity',
      'diagnostic_invalid',
      'receipt',
      'rpc',
      'case_identity',
    ],
    ...controllerStages.map((stage) => 'controller_' + stage),
  ].map((code) => 'nsis_owned_stop_' + code)
);
const OWNED_STOP_PHASES = Object.freeze(
  OWNED_STOP_CODES.map(
    (code) => 'restart-stop-' + code.slice('nsis_owned_stop_'.length).replaceAll('_', '-')
  )
);
const failures = new WeakMap();
const invalid = () => new Error('nsis_client_owned_failed');

// Diagnostic provenance only. Forged fields and exception hooks never refine
// a phase, grant success, change a deadline or authorize another launch.
function createOwnedStopFailure(code) {
  if (typeof code !== 'string' || !OWNED_STOP_CODES.includes(code)) throw invalid();
  const error = Object.assign(invalid(), { code });
  failures.set(error, code);
  return error;
}
function ownedStopFailure(error) {
  return failures.get(error) ?? null;
}
function carryOwnedStopFailure(target, source) {
  if (types.isProxy(target) || !types.isNativeError(target)) throw invalid();
  const code = ownedStopFailure(source);
  if (code !== null && !failures.has(target)) failures.set(target, code);
  return target;
}
module.exports = {
  OWNED_STOP_CODES,
  OWNED_STOP_PHASES,
  createOwnedStopFailure,
  ownedStopFailure,
  carryOwnedStopFailure,
};
