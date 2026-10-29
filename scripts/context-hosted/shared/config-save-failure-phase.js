'use strict';
const { types } = require('node:util');

// Inspect only a bounded own error string; never forward response content.
// These phases classify a rejected save, and never turn it into success.
function configSaveFailurePhase(body) {
  if (!body || typeof body !== 'object' || types.isProxy(body) || Array.isArray(body)) return 200;
  const error = Object.getOwnPropertyDescriptor(body, 'error')?.value;
  if (typeof error !== 'string' || error.length > 16384) return 200;
  if (error.startsWith('Invalid configuration: ')) return 196;
  if (error === 'secret_encryption_failed') return 197;
  if (error === 'secret_decryption_failed') return 198;
  return 199;
}
module.exports = { configSaveFailurePhase };
