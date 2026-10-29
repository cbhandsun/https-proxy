'use strict';
const { readGate } = require('./context-recovery-daemon-start-gate.cjs');
try {
  readGate();
  const { runLegacyWorkerLayoutQualification } = require('./context-recovery-legacy-layout');
  const receipt = runLegacyWorkerLayoutQualification(process.argv.slice(2));
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch {
  process.stderr.write('installed_legacy_582_failed\n');
  process.exitCode = 1;
}
