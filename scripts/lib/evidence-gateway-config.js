'use strict';

const path = require('node:path');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { parseForwardEnvironmentKeys } = require('./evidence-gateway-environment');

// Keep owner-input validation independent of the transport and SDK imports.
function parseEvidenceGatewayArguments(value) {
  const args = normalizeCompactionData(value, 32768);
  if (
    !Array.isArray(args) ||
    args.length > 130 ||
    args.some(
      (arg) =>
        typeof arg !== 'string' ||
        arg.length > 8192 ||
        Array.from(arg).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    )
  )
    throw new Error('invalid_gateway_configuration');
  let offset = 0;
  const options = {};
  const environmentKeys = [];
  while (offset < args.length && args[offset] !== '--') {
    const flag = args[offset];
    const value = args[offset + 1];
    if (flag === '--offload-bytes' && options.offloadThresholdBytes === undefined) {
      if (!/^[1-9]\d{0,6}$/.test(value ?? '')) throw new Error('invalid_gateway_configuration');
      const threshold = Number(value);
      if (threshold < 1024 || threshold > 1024 * 1024)
        throw new Error('invalid_gateway_configuration');
      options.offloadThresholdBytes = threshold;
    } else if (flag === '--forward-env') {
      environmentKeys.push(value);
    } else throw new Error('invalid_gateway_configuration');
    offset += 2;
  }
  parseForwardEnvironmentKeys(environmentKeys);
  const command = args[offset + 1];
  if (
    args[offset] !== '--' ||
    !command ||
    command.startsWith('-') ||
    /[;&|<>`]/.test(command) ||
    /\.(?:bat|cmd|ps1)$/i.test(command) ||
    /^(?:cmd|powershell|pwsh|bash|sh)(?:\.exe)?$/i.test(path.basename(command))
  )
    throw new Error('invalid_gateway_configuration');
  return {
    command,
    args: args.slice(offset + 2),
    options,
    ...(environmentKeys.length ? { environmentKeys } : {}),
  };
}

module.exports = { parseEvidenceGatewayArguments };
