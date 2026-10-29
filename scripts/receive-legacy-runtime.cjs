'use strict';
const { receiveLegacyRuntime } = require('./lib/legacy-runtime-transfer');
receiveLegacyRuntime(process.env)
  .then(() => {
    process.stdout.write('legacy_582_transfer_verified\n');
  })
  .catch(() => {
    process.stderr.write('legacy_runtime_transfer_refused\n');
    process.exitCode = 1;
  });
