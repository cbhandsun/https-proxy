'use strict';
Promise.resolve()
  .then(() => require('./nsis-worker-recovery-driver').run(process.argv.slice(2)))
  .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(() => {
    process.stderr.write('nsis_worker_qualification_failed\n');
    process.exitCode = 1;
  });
