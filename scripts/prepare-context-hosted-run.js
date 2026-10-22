'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { captureSourceIdentity } = require('./context-hosted/source-identity');
const { buildHostedReviewPlan } = require('./context-hosted/build-plan');
const { verifyPhysicalPath } = require('./context-hosted/shared/build-hosted-controller');
const { validateReleaseDirectory } = require('../lib/release/governance');
const { createRuntimePackage } = require('../lib/release/layout');
const fail = () => new Error('context_hosted_prepare_failed');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function writeNew(file, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const handle = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return sha(bytes);
}
function prepare(scenario) {
  try {
    if (
      process.platform !== 'win32' ||
      !['n08', 'n09'].includes(scenario) ||
      process.execArgv.length !== 0 ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.RUNNER_OS !== 'Windows' ||
      !process.env.RUNNER_TEMP ||
      !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')
    )
      throw fail();
    const candidate = path.resolve(__dirname, '..'),
      sourceSha = process.env.GITHUB_SHA;
    const before = captureSourceIdentity(candidate, sourceSha);
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    verifyPhysicalPath(npmCli, false);
    // Observe the actual release preparation exit, including its production npm
    // install/ci and native builds. Dependency downloads finish before containment.
    const built = spawnSync(process.execPath, [npmCli, 'run', 'release:prepare'], {
      cwd: candidate,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      timeout: 1200000,
    });
    if (built.error || built.signal || built.status !== 0) throw fail();
    const identity = captureSourceIdentity(candidate, sourceSha);
    if (identity.sourceIdentity !== before.sourceIdentity) throw fail();
    const tempRoot = path.resolve(process.env.RUNNER_TEMP);
    verifyPhysicalPath(tempRoot, true);
    const ownedRoot = path.join(tempRoot, 'hpm-context-' + scenario);
    fs.mkdirSync(ownedRoot);
    verifyPhysicalPath(ownedRoot, true);
    const staged = path.join(candidate, 'dist/staging/runtime');
    const packageDocument = JSON.parse(
      fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')
    );
    if (
      !validateReleaseDirectory(staged, createRuntimePackage(packageDocument).dependencies, {
        requireExecutable: false,
      }).ok
    )
      throw fail();
    const payload = path.join(ownedRoot, 'payload');
    fs.cpSync(staged, payload, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const manifestBytes = fs.readFileSync(path.join(payload, 'release-runtime-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (
      manifest.schemaVersion !== 2 ||
      manifest.nodeSha256 !== sha(fs.readFileSync(process.execPath))
    )
      throw fail();
    const buildReceiptSha256 = writeNew(path.join(ownedRoot, 'build-and-npm.json'), {
      phase: 'build_and_npm_ready',
      buildCompleted: true,
      npmCompleted: true,
      sourceSha,
      sourceIdentity: identity.sourceIdentity,
      sourcePackageLockSha256: sha(fs.readFileSync(path.join(candidate, 'package-lock.json'))),
      manifestSha256: sha(manifestBytes),
      nodeSha256: manifest.nodeSha256,
    });
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (item) =>
          item &&
          item.family === 'IPv4' &&
          !item.internal &&
          /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address)
      )
      .map((item) => item.address)
      .sort();
    if (addresses.length === 0) throw fail();
    const plan = buildHostedReviewPlan({
      scenario,
      candidate,
      ownedRoot,
      identity,
      buildReceiptSha256,
      negativeAddress: addresses[0],
    });
    const receipt = {
      schemaVersion: 1,
      scenario,
      sourceSha,
      planSha256: plan.planSha256,
      buildReceiptSha256,
    };
    writeNew(path.join(ownedRoot, 'prepared-run.json'), receipt);
    return Object.freeze({
      ...receipt,
      phase: 'prepared_only',
      networkExecuted: false,
      daemonExecuted: false,
    });
  } catch {
    throw fail();
  }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw fail();
    process.stdout.write(JSON.stringify(prepare(process.argv[2])) + '\n');
  } catch {
    process.stderr.write('context_hosted_prepare_failed\n');
    process.exitCode = 1;
  }
}
module.exports = { prepare };
