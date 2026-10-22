'use strict';

const path = require('node:path');
const { runGenericModelAcceptance } = require('./lib/generic-evidence-acceptance-runtime');

if (require.main === module) {
  runGenericModelAcceptance(
    path.resolve(__dirname, '..'),
    (state) => process.stdout.write(JSON.stringify(state) + '\n'),
    { name: process.argv[2] }
  )
    .then((result) => {
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch(() => {
      process.stderr.write('generic_acceptance_start_failed\n');
      process.exitCode = 1;
    });
}
