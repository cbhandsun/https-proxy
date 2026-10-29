'use strict';
const { CLAUDE_DIAGNOSTIC_POLICY } = require('./claude-context-diagnostic-policy');
const CODEX_DIAGNOSTIC_POLICY = Object.freeze({
  client: 'codex',
  scope: 'staged_codex_enhanced_stop_diagnostic',
  paths: Object.freeze(['/v1/responses', '/v1/responses/compact']),
});
function diagnosticPolicy(client) {
  if (client === 'claude') return CLAUDE_DIAGNOSTIC_POLICY;
  if (client === 'codex') return CODEX_DIAGNOSTIC_POLICY;
  throw new Error('codex_stop_diagnostic_failed');
}
module.exports = { diagnosticPolicy };
