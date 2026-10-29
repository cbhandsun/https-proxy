'use strict';
try {
  if (process.argv.length !== 2) throw new Error();
  const { readCoverageIoReceipt } = require('./lib/coverage-io-capture');
  const { requiredCoverageIoWindows } = require('./lib/coverage-io-windows');
  for (const windowId of requiredCoverageIoWindows()) readCoverageIoReceipt(process.env, windowId);
  process.stdout.write('coverage_io_receipt_verified\n');
} catch {
  process.stderr.write('coverage_io_receipt_failed\n');
  process.exitCode = 1;
}
