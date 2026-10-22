'use strict';

const { runBridge, formatBridgeError } = require('./lib/nsis-baseline-transfer');
runBridge(process.env)
  .then(() => {
    process.stdout.write('baseline_bridge_verified\n');
  })
  .catch((error) => {
    process.stderr.write(`${formatBridgeError(error)}\n`);
    process.exitCode = 1;
  });
