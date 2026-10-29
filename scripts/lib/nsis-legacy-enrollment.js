'use strict';

const { isDeepStrictEqual } = require('node:util');
const { fail } = require('./nsis-encrypted-contract');

// Only used with a newly seeded synthetic legacy store on the disposable
// installer runner. Fingerprints and native replies never enter the receipt.
function assertLegacyEnrollment({ command, directory, inventory, evidence }) {
  const before = inventory();
  const initial = evidence();
  const preview = command(['preview', '--directory', directory]);
  if (
    preview.exitCode !== 0 ||
    preview.stderr !== '' ||
    typeof preview.stdout !== 'string' ||
    preview.stdout.length > 512
  )
    throw fail();
  const metadata = JSON.parse(preview.stdout);
  if (
    !metadata ||
    Object.keys(metadata).sort().join(',') !== 'fingerprint,maxTime,scopeCount' ||
    typeof metadata.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(metadata.fingerprint) ||
    metadata.scopeCount !== 1 ||
    !Number.isSafeInteger(metadata.maxTime) ||
    metadata.maxTime < 0
  )
    throw fail();
  const inspected = evidence();
  if (
    inspected.nativeCalls !== initial.nativeCalls + 1 ||
    inspected.anchorWrites !== initial.anchorWrites ||
    !isDeepStrictEqual(inventory(), before)
  )
    throw fail();
  const result = command([
    'enroll',
    '--directory',
    directory,
    '--fingerprint',
    metadata.fingerprint,
  ]);
  const enrolled = evidence();
  if (
    result.exitCode !== 0 ||
    result.stderr !== '' ||
    result.stdout !== '{"enrolled":true}\n' ||
    enrolled.nativeCalls !== initial.nativeCalls + 2 ||
    enrolled.anchorWrites !== initial.anchorWrites + 1 ||
    !isDeepStrictEqual(inventory(), before)
  )
    throw fail();
}

module.exports = { assertLegacyEnrollment };
