'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

async function main() {
  const mode = process.argv[2];
  if (mode === 'storage') {
    const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
    const storage = await openContextRecoveryStorage({ directory: process.argv[3] });
    try {
      const inspected = JSON.parse(JSON.stringify(await storage.execute({ operation: 'inspect' })));
      assert.deepEqual(inspected, { records: 0, bytes: 0 });
    } finally {
      await storage.close();
    }
  } else if (mode === 'key') {
    const { createContextRecoveryKeyProtector } = require('../../lib/proxy/context-recovery-key');
    const protector = createContextRecoveryKeyProtector();
    const key = randomBytes(32).toString('base64');
    assert.equal(await protector.unprotect(await protector.protect(key)), key);
  } else throw new Error('invalid_fixture_mode');
  process.stdout.write('{"ok":true,"closed":true}\n');
}

main().catch(() => {
  process.stderr.write('synthetic_worker_fixture_failed\n');
  process.exitCode = 1;
});
