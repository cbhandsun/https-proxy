'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { normalizeCompactionData } = require('./context-compaction-envelope');

const bindingKey = Symbol('recoveryOfficialCredentialBinding');
const bindings = new WeakMap();
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readCredentialBytes(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    return length === stat.size ? buffer.subarray(0, length) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Only the established credential resolver supplies this path and initial bytes.
// Bounded rereads detect logout/rotation without exposing tokens or file content.
function createRecoveryCredentialFileGuard(file, bytes) {
  if (
    typeof file !== 'string' ||
    !file ||
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > MAX_CREDENTIAL_BYTES
  )
    return () => false;
  const expected = hash(bytes);
  return () => {
    const current = readCredentialBytes(file);
    return current !== null && hash(current) === expected;
  };
}

function createRecoveryWbipcCredentialGuard(file, authInfo) {
  try {
    const raw = Object.getOwnPropertyDescriptor(authInfo, 'raw');
    const bytes = readCredentialBytes(file);
    if (
      !raw ||
      !Object.hasOwn(raw, 'value') ||
      !bytes ||
      fingerprintContextData(JSON.parse(bytes.toString('utf8'))) !==
        fingerprintContextData(raw.value)
    )
      return () => false;
    return createRecoveryCredentialFileGuard(file, bytes);
  } catch {
    return () => false;
  }
}

function credentialData(prepared) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared))
    throw new TypeError('Invalid credential binding');
  const fields = Object.getOwnPropertyDescriptors(prepared);
  const result = {};
  for (const key of ['profile', 'authMode', 'authProvider']) {
    if (!fields[key] || !Object.hasOwn(fields[key], 'value'))
      throw new TypeError('Invalid credential binding');
    result[key] = fields[key].value;
  }
  if (result.authProvider === 'workbuddy') {
    if (!fields.workbuddyAuth || !Object.hasOwn(fields.workbuddyAuth, 'value'))
      throw new TypeError('Invalid credential binding');
    result.workbuddyAuth = fields.workbuddyAuth.value;
  }
  return normalizeCompactionData(result, 2 * 1024 * 1024);
}

function validProvider(data, provider) {
  return (
    data.authMode === 'official-login' &&
    data.authProvider === provider &&
    (provider !== 'workbuddy' ||
      (data.profile?.protocol === 'workbuddy' &&
        !data.profile.apiKey &&
        data.workbuddyAuth?.accessTokenEncrypted === true &&
        !data.workbuddyAuth.accessToken))
  );
}

function bindCredentials(prepared, configuredProfile, guard, provider) {
  try {
    const data = credentialData(prepared);
    if (
      !validProvider(data, provider) ||
      !configuredProfile ||
      typeof guard !== 'function' ||
      guard() !== true
    )
      return prepared;
    const binding = Object.freeze({});
    bindings.set(binding, {
      provider,
      configured: fingerprintContextData(configuredProfile),
      resolved: fingerprintContextData(data),
      guard,
    });
    // Spreads in trusted request normalizers preserve this private Symbol.
    // JSON, inbound headers and body properties cannot manufacture its identity.
    Object.defineProperty(prepared, bindingKey, {
      value: binding,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Failure to qualify optional recovery does not change ordinary forwarding.
  }
  return prepared;
}

function credentialsAllowed(prepared, configuredProfile, provider) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prepared, bindingKey);
    const binding =
      descriptor && Object.hasOwn(descriptor, 'value') && bindings.get(descriptor.value);
    if (!binding || binding.provider !== provider) return false;
    const data = credentialData(prepared);
    return Boolean(
      validProvider(data, provider) &&
      fingerprintContextData(data) === binding.resolved &&
      binding.guard() === true &&
      (configuredProfile === undefined ||
        fingerprintContextData(configuredProfile) === binding.configured)
    );
  } catch {
    return false;
  }
}

const bindRecoveryOfficialCredentials = (prepared, configuredProfile, guard = () => true) =>
  bindCredentials(prepared, configuredProfile, guard, 'openai');
const recoveryOfficialCredentialsAllowed = (prepared, configuredProfile) =>
  credentialsAllowed(prepared, configuredProfile, 'openai');
const bindRecoveryWbipcCredentials = (prepared, configuredProfile, guard) =>
  bindCredentials(prepared, configuredProfile, guard, 'workbuddy');
const recoveryWbipcCredentialsAllowed = (prepared, configuredProfile) =>
  credentialsAllowed(prepared, configuredProfile, 'workbuddy');
function recoveryWbipcCredentialScope(prepared) {
  if (!recoveryWbipcCredentialsAllowed(prepared)) return null;
  return bindings.get(Object.getOwnPropertyDescriptor(prepared, bindingKey).value).resolved;
}

module.exports = {
  bindRecoveryOfficialCredentials,
  recoveryOfficialCredentialsAllowed,
  createRecoveryCredentialFileGuard,
  bindRecoveryWbipcCredentials,
  recoveryWbipcCredentialsAllowed,
  createRecoveryWbipcCredentialGuard,
  recoveryWbipcCredentialScope,
};
