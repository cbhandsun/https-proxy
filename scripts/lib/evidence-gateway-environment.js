'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

const invalid = () => new Error('invalid_gateway_environment');
const unsafeName =
  /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|RUBYLIB|BASH_ENV|ENV|COMSPEC|SHELLOPTS|DOTNET_STARTUP_HOOKS)$/i;

function parseForwardEnvironmentKeys(value) {
  let keys;
  try {
    keys = normalizeCompactionData(value, 4096);
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(keys) ||
    keys.length > 32 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
        unsafeName.test(key)
    ) ||
    new Set(keys.map((key) => key.toUpperCase())).size !== keys.length
  )
    throw invalid();
  return keys;
}

// Only the owner-selected names are inspected. Never copy an entire environment
// or read credential files. Values stay in memory and never enter diagnostics.
function selectEvidenceGatewayEnvironment(value, environment = process.env) {
  const keys = parseForwardEnvironmentKeys(value);
  if (!environment || typeof environment !== 'object' || Array.isArray(environment))
    throw invalid();
  const selected = Object.create(null);
  const names = Object.getOwnPropertyNames(environment);
  let bytes = 0;
  for (const key of keys) {
    const matches = names.filter((name) => name.toUpperCase() === key.toUpperCase());
    if (matches.length !== 1) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(environment, matches[0]);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    const entry = descriptor.value;
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.includes('\u0000') ||
      entry.startsWith('()') ||
      Buffer.byteLength(entry) > 16384 ||
      Buffer.from(entry, 'utf8').toString('utf8') !== entry
    )
      throw invalid();
    bytes += Buffer.byteLength(entry);
    if (bytes > 65536) throw invalid();
    selected[key] = entry;
  }
  return selected;
}

module.exports = { parseForwardEnvironmentKeys, selectEvidenceGatewayEnvironment };
