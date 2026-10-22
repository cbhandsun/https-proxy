'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safePath, child } = require('./nsis-encrypted-contract');
const fail = () => new Error('installation_parallel_failed');

// Optional isolated harness API. No serial caller or daemon gate is switched.
function verifyInstallationParallel(install, expected, start = spawnSync) {
  try {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw fail();
    install = safePath(install, true);
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR'])
      if (process.env[name]) env[name] = process.env[name];
    const result = start(
      process.execPath,
      [path.join(__dirname, 'nsis-installation-parallel-supervisor.js')],
      {
        cwd: __dirname,
        env,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        input: JSON.stringify({ install, manifestSha256: expected }),
        maxBuffer: 8192,
        timeout: 15000,
      }
    );
    if (
      result.error ||
      result.status !== 0 ||
      result.signal !== null ||
      result.stderr !== '' ||
      typeof result.stdout !== 'string'
    )
      throw fail();
    const reply = JSON.parse(result.stdout);
    if (
      !reply ||
      !Number.isSafeInteger(reply.sourceCount) ||
      reply.sourceCount < 1 ||
      reply.sourceCount > 4096 ||
      result.stdout !== JSON.stringify({ v: 1, ok: true, sourceCount: reply.sourceCount }) + '\n'
    )
      throw fail();
    safePath(install, true);
    return {
      manifestSha256: expected,
      sourceCount: reply.sourceCount,
      native: child(install, 'runtime/native/hpm-context-recovery-key.exe'),
      node: child(install, 'runtime/node/node.exe'),
    };
  } catch {
    throw fail();
  }
}
module.exports = { verifyInstallationParallel };
