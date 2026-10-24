'use strict';
async function main() {
  require('./context-recovery-daemon-start-gate.cjs').readGate();
  const receipt = await require('./nsis-native-control-probe').run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
main().catch(() => {
  process.stderr.write('native_control_probe_failed\n');
  process.exitCode = 1;
});
