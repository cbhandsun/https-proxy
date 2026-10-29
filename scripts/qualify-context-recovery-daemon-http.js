'use strict';

const { runDaemonHttpSettingsMatrix } = require('./lib/context-recovery-daemon-http-matrix');

// Live execution is deliberately available only through an injected, reviewed
// owned-process adapter. This command never starts a process or loads secrets.
async function main() {
  if (process.argv.length !== 2) throw new Error('reviewed_owned_adapter_required');
  const report = await runDaemonHttpSettingsMatrix();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch(() => {
  process.stderr.write('daemon_http_matrix_refused\n');
  process.exitCode = 1;
});
