'use strict';
const path = require('node:path');
const { runInstalledEvidenceAcceptance } = require('./lib/installed-evidence-acceptance-runtime');

runInstalledEvidenceAcceptance(
  path.resolve(__dirname, '..'),
  (value) => {
    process.stdout.write(JSON.stringify(value) + '\n');
  },
  process.argv[2] ?? 'run1'
)
  .then((report) => {
    if (!report.passed) process.exitCode = 1;
  })
  .catch(() => {
    process.stderr.write('native_installed_acceptance_preflight_failed\n');
    process.exitCode = 1;
  });
