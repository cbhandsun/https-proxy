'use strict';
const { readGate } = require('./lib/context-recovery-daemon-start-gate.cjs');
async function main() {
  readGate();
  const { runCodexStopDiagnostic } = require('./lib/codex-stop-diagnostic');
  const report = await runCodexStopDiagnostic(process.argv.slice(2));
  // A completed diagnostic can describe failure; its caller must reject false.
  // Keeping this single safe receipt permits the original Job wrapper to prove cleanup first.
  process.stdout.write(JSON.stringify(report) + '\n');
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('codex_stop_diagnostic_failed\n');
    process.exitCode = 1;
  });
module.exports = { main };
