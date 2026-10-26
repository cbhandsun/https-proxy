'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { types } = require('node:util');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const failure = () => new Error('encrypted_proxy_fixture_preparation_failed');
const script = [
  "const fs = require('node:fs'), path = require('node:path');",
  'const { encryptConfigSecretsForStorage } = require(process.argv[1]);',
  "const config = JSON.parse(fs.readFileSync(0, 'utf8'));",
  "fs.writeFileSync(path.join(process.env.PROXY_CONFIG_DIR, 'proxy.config.json'), JSON.stringify(encryptConfigSecretsForStorage(config)));",
].join('\n');

// Fixture credentials must be prepared in the same isolated user/key domain as
// the proxy, including when the unchanged protector selects AES-v2 fallback.
// Never load crypto in the parent's real home or forward child diagnostics.
function prepareEncryptedProxyFixtureConfig(config, environment, execute = spawnSync) {
  try {
    if (
      !environment ||
      types.isProxy(environment) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(environment)) ||
      typeof execute !== 'function' ||
      types.isProxy(execute) ||
      types.isAsyncFunction(execute) ||
      types.isGeneratorFunction(execute)
    )
      throw failure();
    const env = Object.create(null);
    for (const name of Reflect.ownKeys(environment)) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, name);
      if (
        typeof name !== 'string' ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' ||
        /[\0=]/.test(name) ||
        descriptor.value.includes('\0')
      )
        throw failure();
      env[name] = descriptor.value;
    }
    if (typeof env.PROXY_CONFIG_DIR !== 'string' || !path.isAbsolute(env.PROXY_CONFIG_DIR))
      throw failure();
    const value = normalizeCompactionData(config, 65536);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
    const input = JSON.stringify(value);
    const result = execute(
      process.execPath,
      ['-e', script, path.resolve(__dirname, '../../lib/proxy/config.js')],
      {
        env,
        input,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 65536,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    if (!result || types.isProxy(result) || result.error || result.signal || result.status !== 0)
      throw failure();
  } catch {
    throw failure();
  }
}

module.exports = { prepareEncryptedProxyFixtureConfig };
