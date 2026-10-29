'use strict';
const { runStagedClientDiagnostic } = require('./codex-stop-diagnostic');
function runClaudeContextDiagnostic(args, dependencies) {
  return runStagedClientDiagnostic(args, 'claude', dependencies);
}
module.exports = { runClaudeContextDiagnostic };
