'use strict';
try {
  if (process.argv.length !== 2) throw new Error();
  const { readCoverageIoReceipt } = require('./lib/coverage-io-capture');
  readCoverageIoReceipt();
  if (process.env.HPM_COVERAGE_IO_STAGE === 'client')
    readCoverageIoReceipt(process.env, 'publication-graceful-http');
  process.stdout.write('coverage_io_receipt_verified\n');
} catch {
  process.stderr.write('coverage_io_receipt_failed\n');
  process.exitCode = 1;
}
