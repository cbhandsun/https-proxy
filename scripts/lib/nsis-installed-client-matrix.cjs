'use strict';

const { readGate } = require('./context-recovery-daemon-start-gate.cjs');
async function main() {
  readGate();
  const { runInstalledClientMatrix } = require('./nsis-installed-client-matrix');
  const receipt = await runInstalledClientMatrix(process.argv.slice(2));
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
main().catch(() => {
  process.stderr.write('installed_client_matrix_failed\n');
  process.exitCode = 1;
});
