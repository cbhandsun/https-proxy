'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { prepareEvidenceGateway } = require('./prepare-evidence-gateway');
const {
  captureIsolatedRuntimeSources,
  createIsolatedRuntimeWorkspace,
  prepareIsolatedRuntime,
} = require('../lib/release/isolated-runtime');

async function main() {
  if (process.argv.slice(2).join('\n') !== '--prepare')
    throw new TypeError('Explicit preparation mode required');
  await prepareEvidenceGateway();
  const snapshot = captureIsolatedRuntimeSources(path.resolve(__dirname, '..'));
  const directory = createIsolatedRuntimeWorkspace(snapshot);
  process.stdout.write(JSON.stringify({ phase: 'isolated_runtime_preparing', directory }) + '\n');
  let report;
  try {
    report = { passed: true, ...(await prepareIsolatedRuntime(snapshot, directory)) };
  } catch (problem) {
    report = {
      passed: false,
      directory,
      failureCode:
        typeof problem?.code === 'string' && /^release_isolated_[a-z_]+$/.test(problem.code)
          ? problem.code
          : 'release_isolated_probe_failed',
    };
    process.exitCode = 1;
  }
  fs.writeFileSync(
    path.join(directory, 'isolated-runtime-result.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' }
  );
  process.stdout.write(JSON.stringify(report) + '\n');
}

main().catch(() => {
  process.stdout.write(
    JSON.stringify({ passed: false, failureCode: 'release_isolated_probe_refused' }) + '\n'
  );
  process.exitCode = 1;
});
