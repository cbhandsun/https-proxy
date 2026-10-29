'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  safePath,
  child,
  digest,
  verifyInstallation,
} = require('../../scripts/lib/nsis-encrypted-contract');
const NAMES = Object.freeze([
  'server-shutdown',
  'stopping-admission',
  'context-recovery-storage',
  'context-recovery-storage-sqlite',
  'context-recovery-sessions',
  'context-recovery-storage-contract',
]);
const fail = () => new Error('installed_publication_runtime_rejected');
let installed;

// This selector belongs only to the fixed process fixtures. No product startup
// path reads these variables. An incomplete/invalid selection cannot fall back.
function selectPublicationRuntime(runtime = process) {
  try {
    const directory = runtime.env.HPM_INSTALLED_PUBLICATION_RUNTIME;
    const pin = runtime.env.HPM_INSTALLED_PUBLICATION_MANIFEST;
    if (directory === undefined && pin === undefined) return null;
    if (
      runtime.platform !== 'win32' ||
      runtime.env.CI !== 'true' ||
      runtime.env.GITHUB_ACTIONS !== 'true' ||
      runtime.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      runtime.env.RUNNER_OS !== 'Windows' ||
      typeof runtime.env.RUNNER_TEMP !== 'string' ||
      directory !== path.join(runtime.env.RUNNER_TEMP, 'hpm-installed-clients', 'payload') ||
      typeof pin !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pin)
    )
      throw fail();
    safePath(directory, true);
    if (runtime === process && installed) {
      if (installed.directory !== directory || installed.pin !== pin) throw fail();
      return installed;
    }
    const identity = verifyInstallation(directory, pin);
    if (fs.realpathSync.native(runtime.execPath).toLowerCase() !== identity.node.toLowerCase())
      throw fail();
    const selected = { directory, pin, identity };
    if (runtime === process) installed = selected;
    return selected;
  } catch {
    throw fail();
  }
}

function publicationModule(name) {
  try {
    if (!NAMES.includes(name)) throw fail();
    const selected = selectPublicationRuntime();
    if (!selected) return require(path.join(__dirname, '../../lib/proxy', name + '.js'));
    const manifest = child(selected.directory, 'release-runtime-manifest.json');
    if (digest(manifest) !== selected.pin) throw fail();
    const document = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const relative = 'lib/proxy/' + name + '.js';
    const file = child(selected.directory, relative);
    if (digest(file) !== document.sourceSha256[relative]) throw fail();
    return require(file);
  } catch {
    throw fail();
  }
}

module.exports = { publicationModule, selectPublicationRuntime };
