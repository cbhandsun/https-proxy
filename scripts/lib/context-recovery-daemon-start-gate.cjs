'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallationParallel,
} = require('./nsis-runtime-boundary-contract');

const fail = () => new Error('daemon_start_gate_rejected');

// Synchronous preload: Node cannot enter its actual main module before EOF.
// The controller writes the single byte only after assigning the owned Job.
function readGate(read = fs.readSync) {
  const bytes = Buffer.alloc(2);
  let size = 0;
  for (;;) {
    const count = read(0, bytes, size, bytes.length - size, null);
    if (!Number.isInteger(count) || count < 0 || count > bytes.length - size) throw fail();
    if (count === 0) break;
    size += count;
    if (size > 1 || bytes[0] !== 49) throw fail();
  }
  if (size !== 1 || bytes[0] !== 49) throw fail();
}

function verifyGateIdentity(runtime = process) {
  const env = runtime.env;
  if (
    env.NODE_OPTIONS ||
    env.NODE_PATH ||
    runtime.execArgv.length !== 2 ||
    runtime.execArgv[0] !== '--require' ||
    path.resolve(runtime.execArgv[1]) !== __filename ||
    runtime.argv.length !== 2
  )
    throw fail();
  const input = parseRuntimeBoundaryArguments([
    'settings-matrix',
    env.HPM_DAEMON_OWNED_INSTALL,
    env.HPM_DAEMON_OWNED_CASE_ROOT,
    env.HPM_DAEMON_OWNED_MANIFEST,
  ]);
  const installed = verifyRuntimeBoundaryInstallationParallel(input, env.HPM_DAEMON_OWNED_ROOT);
  const same = (a, b) =>
    runtime.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (
    !same(fs.realpathSync.native(runtime.execPath), fs.realpathSync.native(installed.node)) ||
    !same(runtime.cwd(), installed.install) ||
    !same(path.resolve(runtime.argv[1]), path.join(installed.install, 'openai-proxy.js')) ||
    env.PROXY_CONFIG_DIR !== path.join(input.caseRoot, 'config') ||
    env.PROXY_RUNTIME_DIR !== path.join(input.caseRoot, 'runtime') ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(env.MGMT_TOKEN || '')
  )
    throw fail();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(installed.install, 'release-runtime-manifest.json'), 'utf8')
  );
  if (!Object.hasOwn(manifest.sourceSha256, 'openai-proxy.js')) throw fail();
}

// Node's --require loader uses this parent id. Ordinary imports for offline
// tests do not execute the gate; the fixed controller invocation always does.
if (module.parent?.id === 'internal/preload') {
  try {
    fs.writeSync(2, 'HPM_GATE_ENTERED\n');
    readGate();
    verifyGateIdentity();
    fs.writeSync(2, 'HPM_GATE_PASSED\n');
  } catch {
    fs.writeSync(2, 'HPM_GATE_FAILED\n');
    throw fail();
  }
}

module.exports = { readGate, verifyGateIdentity };
