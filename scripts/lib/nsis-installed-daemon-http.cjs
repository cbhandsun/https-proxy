'use strict';

const { readGate } = require('./context-recovery-daemon-start-gate.cjs');
const { runInstalledDaemonHttp } = require('./nsis-installed-daemon-http');

async function main() {
  // The hosted runner assigns the entire driver/controller tree before release.
  readGate();
  const receipt = await runInstalledDaemonHttp(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
main().catch(() => {
  process.stderr.write('installed_daemon_http_failed\n');
  process.exitCode = 1;
});
