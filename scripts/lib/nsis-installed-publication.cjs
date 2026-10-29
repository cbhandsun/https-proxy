'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readGate } = require('./context-recovery-daemon-start-gate.cjs');
const { selectPublicationRuntime } = require('../../test/helpers/publication-runtime.cjs');
const { parseInstalledPublicationTap } = require('./nsis-installed-publication-tap');
const fail = () => new Error('installed_publication_suite_failed');

function main() {
  readGate();
  if (process.argv.length !== 2) throw fail();
  const selected = selectPublicationRuntime();
  if (!selected) throw fail();
  const candidate = path.resolve(__dirname, '../..');
  const args = [
    '--require',
    path.join(candidate, 'test/helpers/physical-test-temp.cjs'),
    '--require',
    path.join(candidate, 'test/helpers/publication-runtime-required.cjs'),
    '--test',
    '--test-concurrency=1',
    path.join(candidate, 'test/context-recovery-native-publication-interruption.test.js'),
    path.join(candidate, 'test/context-recovery-native-graceful-http.test.js'),
  ];
  // Fixed original suites. Their per-case 15s, ready/HTTP 5s, actual COMMIT
  // witness 750ms and natural exit 4s remain inside the existing 240s owned Job.
  const result = spawnSync(selected.identity.node, args, {
    cwd: selected.directory,
    env: process.env,
    encoding: 'utf8',
    timeout: 230000,
    maxBuffer: 1048576,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || result.signal !== null) throw fail();
  const suite = parseInstalledPublicationTap(result.stdout);
  // Raw TAP and subprocess errors never become an installation receipt.
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      scope: 'installed_payload_publication_interior',
      passed: true,
      manifestSha256: selected.pin,
      ...suite,
      defaultWorkerQualified: true,
      daemonQualified: false,
      retention24hQualified: false,
      realModelRequests: 0,
    }) + '\n'
  );
}
try {
  main();
} catch {
  process.stderr.write('installed_publication_suite_failed\n');
  process.exitCode = 1;
}
