'use strict';
try {
  if (process.argv.length !== 2) throw new Error();
  require('./lib/coverage-io-capture').readCoverageIoReceipt();
  process.stdout.write('coverage_io_receipt_verified\n');
} catch {
  process.stderr.write('coverage_io_receipt_failed\n');
  process.exitCode = 1;
}
