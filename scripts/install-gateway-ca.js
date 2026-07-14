#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--ca' && arg !== '--container' && arg !== '--runtime-dir') {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    result[arg.slice(2)] = value;
    index += 1;
  }
  return result;
}

function defaultRuntimeDir(env = process.env, platform = process.platform) {
  if (env.HTTPS_PROXY_RUNTIME_DIR) return path.resolve(env.HTTPS_PROXY_RUNTIME_DIR);
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const installedRuntime = path.join(env.LOCALAPPDATA, 'HTTPS Proxy Manager', '.hpm-runtime');
    if (fs.existsSync(installedRuntime)) return installedRuntime;
  }
  return '';
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const runtimeDir = args['runtime-dir'] || defaultRuntimeDir();
    if (runtimeDir) process.env.PROXY_RUNTIME_DIR = path.resolve(runtimeDir);

    const cert = require('../lib/proxy/cert');
    const { installGatewayCa } = require('../lib/proxy/gateway-ca-trust');
    cert.ensureCert();
    const result = installGatewayCa({
      caPath: args.ca || cert.CA_CERT_FILE,
      container: args.container || process.env.OPENCLAW_GATEWAY_CONTAINER,
    });
    process.stdout.write(
      `[gateway-ca] installed ${result.caPath} into ${result.container}:${result.containerCaPath}\n`
    );
  } catch (error) {
    process.stderr.write(`[gateway-ca] failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { defaultRuntimeDir, parseArgs };
