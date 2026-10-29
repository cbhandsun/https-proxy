'use strict';
const { verifyInstallation, digest } = require('./lib/nsis-encrypted-contract');
const { BASELINE } = require('./lib/context-recovery-legacy-layout');
try {
  if (process.argv.length !== 3) throw Error('invalid');
  const runtime = verifyInstallation(process.argv[2], BASELINE.manifest);
  if (
    runtime.sourceCount !== 582 ||
    digest(runtime.node) !== BASELINE.node ||
    digest(runtime.native) !== BASELINE.native
  )
    throw Error('invalid');
  process.stdout.write('legacy_582_complete_identity_verified\n');
} catch {
  process.stderr.write('legacy_runtime_identity_refused\n');
  process.exitCode = 1;
}
