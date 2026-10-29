'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readGate } = require('./context-recovery-daemon-start-gate.cjs');
try {
  readGate();
  if (process.argv.length !== 2) throw new Error('refused');
  const root = path.resolve(__dirname, '../..');
  const result = spawnSync(
    process.execPath,
    [
      '--require',
      path.join(root, 'test/helpers/physical-test-temp.cjs'),
      '--test',
      '--test-concurrency=1',
      ...[
        'client-context-target',
        'context-recovery-codex-summary',
        'context-recovery-publication-interruption',
      ].map((name) => path.join(root, 'test', name + '.test.js')),
    ],
    { cwd: root, stdio: 'inherit' }
  );
  process.exitCode =
    result.error || result.signal || !Number.isInteger(result.status) ? 1 : result.status;
} catch {
  process.stderr.write('persistent_io_schema_tests_failed\n');
  process.exitCode = 1;
}
