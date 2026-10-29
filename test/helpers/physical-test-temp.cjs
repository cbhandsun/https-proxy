'use strict';

// Test-process placement only: retain every production path guard. Hosted
// Windows TEMP can contain an 8.3 alias even when the physical directory is safe.
const { resolvePhysicalTestTempDirectory } = require('../../lib/test-runtime');
const directory = resolvePhysicalTestTempDirectory();
for (const key of Object.keys(process.env)) {
  if (['TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase())) delete process.env[key];
}
process.env.TEMP = directory;
process.env.TMP = directory;
process.env.TMPDIR = directory;
