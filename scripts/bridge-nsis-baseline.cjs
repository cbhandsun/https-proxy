'use strict';

const { runBridge } = require('./lib/nsis-baseline-transfer');
runBridge(process.env)
  .then(() => {
    process.stdout.write('baseline_bridge_verified\n');
  })
  .catch(() => {
    process.stderr.write('baseline_transfer_refused\n');
    process.exitCode = 1;
  });
