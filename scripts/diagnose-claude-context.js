'use strict';
const { readGate } = require('./lib/context-recovery-daemon-start-gate.cjs');
async function main() {
  readGate();
  const { runClaudeContextDiagnostic } = require('./lib/claude-context-diagnostic');
  const report = await runClaudeContextDiagnostic(process.argv.slice(2));
  process.stdout.write(JSON.stringify(report) + '\n');
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('claude_context_diagnostic_failed\n');
    process.exitCode = 1;
  });
module.exports = { main };
