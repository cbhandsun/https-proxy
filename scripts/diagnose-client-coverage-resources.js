'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { clientCoverageResourceArguments } = require('./lib/client-coverage-resource-command');

function main() {
  if (
    process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.argv.length !== 3 ||
    !['1', '4'].includes(process.argv[2])
  )
    throw new Error();
  const concurrency = Number(process.argv[2]);
  const root = path.resolve(__dirname, '..');
  const command = require('../package.json').scripts['test:client:coverage'];
  const args = clientCoverageResourceArguments(command, concurrency);
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/c8/bin/c8.js'), ...args],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: 'inherit',
    }
  );
  const passed = !result.error && result.signal === null && result.status === 0;
  process.stdout.write(
    JSON.stringify({
      scope: 'client-coverage-resource-diagnostic',
      concurrency,
      elapsedMs: Math.round(performance.now() - started),
      passed,
      qualificationGranted: false,
    }) + '\n'
  );
  process.exitCode = passed ? 0 : 1;
}

try {
  main();
} catch {
  process.stderr.write('client_coverage_resource_probe_failed\n');
  process.exitCode = 1;
}
