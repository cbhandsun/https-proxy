'use strict';

const { parseOptions, prepareTransfer } = require('./lib/nsis-baseline-transfer');
try {
  const result = prepareTransfer(parseOptions(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write(
    'baseline_transfer_refused; inspect the owned archive transfer-state.json if execution was requested\n'
  );
  process.exitCode = 1;
}
