'use strict';

const { executeLegacyEnrollmentCommand } = require('./context-recovery-enrollment-command');

if (require.main === module) {
  const result = executeLegacyEnrollmentCommand(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
