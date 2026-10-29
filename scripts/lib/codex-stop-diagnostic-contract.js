'use strict';
const { PHASES } = require('./nsis-installed-client-matrix-contract');
const { OWNED_STOP_CODES } = require('./nsis-client-owned-failure');
const FIELDS = Object.freeze([
  'schemaVersion',
  'scope',
  'diagnosticPassed',
  'failedPhase',
  'failureCode',
  'ownedTreeEmpty',
  'syntheticSocketsClosed',
  'installedQualified',
  'realProvider',
  'retention24hQualified',
  'modelRequests',
  'probesPassed',
  'tlsVerified',
  'nonLoopbackBlocked',
  'listenerOwned',
]);
function getDiagnosticContract(client = 'codex') {
  if (!['codex', 'claude'].includes(client)) throw new Error('codex_stop_receipt_rejected');
  return Object.freeze({
    FIELDS,
    DIAGNOSTIC_PHASES: Object.freeze(
      PHASES.filter(
        (phase) =>
          ['identity', 'listener', 'probes', 'controller', 'cleanup', 'complete'].includes(phase) ||
          phase.startsWith(client + '-enhanced-')
      )
    ),
    OWNED_STOP_CODES: client === 'codex' ? OWNED_STOP_CODES : Object.freeze([]),
    SCOPE:
      client === 'codex'
        ? 'staged_codex_enhanced_stop_diagnostic'
        : 'staged_claude_enhanced_protocol_diagnostic',
  });
}
function parseStagedDiagnosticReceipt(text, client) {
  const contract = getDiagnosticContract(client);

  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) throw Error();
    const value = JSON.parse(text);
    if (
      JSON.stringify(value) + '\n' !== text ||
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',') ||
      value.schemaVersion !== 1 ||
      value.scope !== contract.SCOPE ||
      value.installedQualified !== false ||
      value.realProvider !== false ||
      value.retention24hQualified !== false ||
      value.modelRequests !== 0 ||
      ![
        'diagnosticPassed',
        'ownedTreeEmpty',
        'syntheticSocketsClosed',
        'probesPassed',
        'tlsVerified',
        'nonLoopbackBlocked',
        'listenerOwned',
      ].every((key) => typeof value[key] === 'boolean') ||
      (value.failedPhase !== null && !contract.DIAGNOSTIC_PHASES.includes(value.failedPhase)) ||
      (value.failureCode !== null && !contract.OWNED_STOP_CODES.includes(value.failureCode)) ||
      (value.diagnosticPassed &&
        (value.failedPhase !== null ||
          value.failureCode !== null ||
          ![
            'ownedTreeEmpty',
            'syntheticSocketsClosed',
            'probesPassed',
            'tlsVerified',
            'nonLoopbackBlocked',
            'listenerOwned',
          ].every((key) => value[key] === true))) ||
      (!value.diagnosticPassed && value.failedPhase === null)
    )
      throw Error();
    return value;
  } catch {
    throw new Error('codex_stop_receipt_rejected');
  }
}
function parseDiagnosticReceipt(text) {
  return parseStagedDiagnosticReceipt(text, 'codex');
}
module.exports = {
  ...getDiagnosticContract(),
  getDiagnosticContract,
  parseDiagnosticReceipt,
  parseStagedDiagnosticReceipt,
};
