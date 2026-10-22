'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { digest, safePath } = require('./nsis-encrypted-contract');
const {
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallation,
} = require('./nsis-runtime-boundary-contract');
const { combinations, runSettingsCombination } = require('./nsis-settings-matrix-case');
const fail = () => new Error('nsis_settings_matrix_failed');
const same = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
async function main(args) {
  if (require.main !== module || args.length !== 4 || !combinations.includes(args[0])) throw fail();
  if (
    process.env.HPM_NSIS_BOUNDARY_START_GATE !== '1' ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH
  )
    throw fail();
  await new Promise((resolve, reject) => {
    let count = 0,
      valid = true;
    process.stdin.on('data', (bytes) => {
      count += bytes.length;
      if (count > 1 || bytes[0] !== 49) valid = false;
    });
    process.stdin.once('end', () => (valid && count === 1 ? resolve() : reject(fail())));
    process.stdin.once('error', () => reject(fail()));
    process.stdin.resume();
  });
  const input = parseRuntimeBoundaryArguments(['settings-matrix', ...args.slice(1)]);
  const verify = () =>
    verifyRuntimeBoundaryInstallation(input, process.env.HPM_NSIS_BOUNDARY_OWNED_ROOT);
  const installed = verify();
  if (!same(fs.realpathSync.native(process.execPath), fs.realpathSync.native(installed.node)))
    throw fail();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(input.install, 'release-runtime-manifest.json'), 'utf8')
  );
  const sources = new Map(
    Object.entries(manifest.sourceSha256).map(([name, sha]) => [name.replaceAll('\\', '/'), sha])
  );
  const entry = 'lib/proxy/context-recovery-runtime.js';
  if (!sources.has(entry) || Object.keys(require.cache).some((file) => inside(input.install, file)))
    throw fail();
  for (const key of Object.keys(process.env)) if (key.startsWith('PROXY_')) delete process.env[key];
  process.env.PROXY_CONFIG_DIR = path.join(input.caseRoot, 'config');
  process.env.PROXY_RUNTIME_DIR = path.join(input.caseRoot, 'data');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (...parameters) {
    const resolved = resolve.apply(this, parameters);
    if (typeof resolved !== 'string' || Module.isBuiltin(resolved)) return resolved;
    const file = safePath(resolved);
    if (!inside(input.install, file)) throw fail();
    const relative = path.relative(input.install, file).replaceAll('\\', '/');
    const expected = sources.get(relative);
    if (expected === undefined ? !relative.startsWith('node_modules/') : digest(file) !== expected)
      throw fail();
    return resolved;
  };
  try {
    verify();
    const runtimeApi = require(path.join(input.install, entry));
    const result = await runSettingsCombination({
      combination: args[0],
      caseRoot: input.caseRoot,
      runtimeApi,
    });
    verify();
    return {
      schemaVersion: 1,
      combination: result.combination,
      manifestSha256: installed.manifestSha256,
      scope: 'verified_payload_module_api',
      dependencyIdentity: 'lock_only',
      checks: result.checks,
      restartRetention: false,
    };
  } finally {
    Module._resolveFilename = resolve;
  }
}
if (require.main === module)
  main(process.argv.slice(2))
    .then((value) => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(() => {
      process.stderr.write('nsis_settings_matrix_failed\n');
      process.exitCode = 1;
    });
module.exports = { main };
