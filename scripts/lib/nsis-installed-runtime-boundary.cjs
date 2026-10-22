'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { types } = require('node:util');
const { digest, safePath } = require('./nsis-encrypted-contract');
const {
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallation,
} = require('./nsis-runtime-boundary-contract');
const { runRuntimeBoundaryCase } = require('./nsis-runtime-boundary-cases');
const { exerciseRuntimeReopenRevocation } = require('./nsis-runtime-reopen-assertions');

const fail = () => new Error('nsis_installed_runtime_boundary_failed');
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function exportedMethod(api, name) {
  if (
    !api ||
    typeof api !== 'object' ||
    types.isProxy(api) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(api))
  )
    throw fail();
  const slot = Object.getOwnPropertyDescriptor(api, name);
  if (
    !slot?.enumerable ||
    !Object.hasOwn(slot, 'value') ||
    typeof slot.value !== 'function' ||
    types.isProxy(slot.value)
  )
    throw fail();
  return (...args) => Reflect.apply(slot.value, api, args);
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function run(args, ownedRoot) {
  // Environment/module-cache isolation belongs to a new bundled-Node process.
  // Calling this export from a long-lived runner is deliberately unsupported.
  if (require.main !== module) throw fail();
  const input = parseRuntimeBoundaryArguments(args);
  if (!['defaults-migration', 'initialization-failure', 'reopen-clear'].includes(input.caseId))
    throw fail();
  const installed = verifyRuntimeBoundaryInstallation(input, ownedRoot);
  if (!samePath(fs.realpathSync.native(process.execPath), fs.realpathSync.native(installed.node)))
    throw fail();
  if (Object.keys(require.cache).some((file) => inside(input.install, file))) throw fail();

  const manifest = JSON.parse(
    fs.readFileSync(path.join(input.install, 'release-runtime-manifest.json'), 'utf8')
  );
  const sources = new Map(
    Object.entries(manifest.sourceSha256).map(([name, sha]) => [name.replaceAll('\\', '/'), sha])
  );
  const required = ['lib/proxy/config.js', 'lib/proxy/context-recovery-runtime.js'];
  if (input.caseId === 'reopen-clear') required.push('lib/proxy/context-recovery-storage.js');
  for (const entry of required) {
    if (!sources.has(entry)) throw fail();
  }
  for (const relative of ['config', 'data']) {
    const directory = safePath(path.join(input.caseRoot, relative), true);
    if (fs.readdirSync(directory).length) throw fail();
  }
  // Revalidate immediately before installing the loader guard and executing any
  // product code. The existing contract hashes all declared installed sources.
  verifyRuntimeBoundaryInstallation(input, ownedRoot);
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (...parameters) {
    const resolved = resolve.apply(this, parameters);
    if (typeof resolved !== 'string' || Module.isBuiltin(resolved)) return resolved;
    const file = safePath(resolved);
    if (!inside(input.install, file)) throw fail();
    const relative = path.relative(input.install, file).replaceAll('\\', '/');
    const expected = sources.get(relative);
    if (expected === undefined) {
      // Preserve Node's native dependency semantics. Existing release identity
      // verifies package-lock, not every node_modules byte; report that limit.
      if (!relative.startsWith('node_modules/')) throw fail();
    } else if (digest(file) !== expected) throw fail();
    return resolved;
  };
  try {
    process.env.PROXY_CONFIG_DIR = path.join(input.caseRoot, 'config');
    process.env.PROXY_RUNTIME_DIR = path.join(input.caseRoot, 'data');
    process.env.PROXY_DATA_DIR = '';
    const configApi = require(path.join(input.install, 'lib/proxy/config.js'));
    const runtimeApi = require(path.join(input.install, 'lib/proxy/context-recovery-runtime.js'));
    let result;
    if (input.caseId === 'reopen-clear') {
      const storageApi = require(path.join(input.install, 'lib/proxy/context-recovery-storage.js'));
      const reopened = await exerciseRuntimeReopenRevocation({
        caseRoot: input.caseRoot,
        runtimeApi: {
          createContextRecoveryRuntime: exportedMethod(runtimeApi, 'createContextRecoveryRuntime'),
        },
        storageApi: {
          openContextRecoveryStorage: exportedMethod(storageApi, 'openContextRecoveryStorage'),
        },
      });
      const names = [
        'persistentRuntimeRead',
        'principalRevokeAcknowledged',
        'principalReopenDenied',
        'clearAcknowledged',
        'clearReopenDenied',
        'allOwnersClosed',
      ];
      if (
        reopened.installationQualified !== false ||
        reopened.restartRetention !== false ||
        names.some((name) => reopened.checks[name] !== true)
      )
        throw fail();
      result = {
        complete: true,
        checks: [
          'persistent_runtime_read',
          'principal_revoke_acknowledged',
          'principal_reopen_denied',
          'clear_acknowledged',
          'clear_reopen_denied',
          'all_owners_closed',
        ],
      };
    } else
      result = await runRuntimeBoundaryCase({
        caseId: input.caseId,
        caseRoot: input.caseRoot,
        configApi,
        runtimeApi,
      });
    verifyRuntimeBoundaryInstallation(input, ownedRoot);
    return Object.freeze({
      schemaVersion: 1,
      caseId: input.caseId,
      manifestSha256: installed.manifestSha256,
      scope: 'installed_module_api',
      complete: result.complete,
      dependencyIdentity: 'lock_only',
      checks: result.checks,
    });
  } finally {
    Module._resolveFilename = resolve;
    // Do not restore environment/cache and reuse the process: this entry is
    // intentionally one case per dedicated process, supervised by its caller.
  }
}

async function waitForOwnedParent() {
  const gate = process.env.HPM_NSIS_BOUNDARY_START_GATE;
  if (gate === undefined) return;
  if (gate !== '1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw fail();
  await new Promise((resolve, reject) => {
    let size = 0;
    let valid = true;
    process.stdin.on('data', (bytes) => {
      size += bytes.length;
      if (size > 1 || bytes[0] !== 49) valid = false;
    });
    process.stdin.once('end', () => (valid && size === 1 ? resolve() : reject(fail())));
    process.stdin.once('error', () => reject(fail()));
    process.stdin.resume();
  });
}

if (require.main === module) {
  waitForOwnedParent()
    .then(() => run(process.argv.slice(2), process.env.HPM_NSIS_BOUNDARY_OWNED_ROOT))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => {
      process.stderr.write('nsis_installed_runtime_boundary_failed\n');
      process.exitCode = 1;
    });
}
module.exports = { run };
