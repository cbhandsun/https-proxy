'use strict';
const {
  getDiagnosticContract,
  parseStagedDiagnosticReceipt,
} = require('./codex-stop-diagnostic-contract');
function parseClaudeDiagnosticReceipt(text) {
  return parseStagedDiagnosticReceipt(text, 'claude');
}
module.exports = { ...getDiagnosticContract('claude'), parseClaudeDiagnosticReceipt };
