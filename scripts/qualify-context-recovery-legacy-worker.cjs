'use strict';

const { runLegacyWorkerLayoutQualification } = require('./lib/context-recovery-legacy-layout');

let stage = 0;
try {
  const receipt = runLegacyWorkerLayoutQualification(process.argv.slice(2), {
    onProgress(progress) {
      stage = progress.stage;
      process.stdout.write(
        JSON.stringify({ scope: 'legacy_worker_layout_stage', ...progress }) + '\n'
      );
    },
  });
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, passed: false, stage }) + '\n');
  process.stderr.write('context_recovery_legacy_layout_failed\n');
  process.exitCode = 1;
}
