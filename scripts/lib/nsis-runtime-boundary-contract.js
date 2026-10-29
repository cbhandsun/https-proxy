'use strict';

const path = require('node:path');
const { types } = require('node:util');
const { safePath, verifyInstallation } = require('./nsis-encrypted-contract');
const { verifyInstallationParallel } = require('./nsis-installation-parallel');

const RUNTIME_BOUNDARY_CASES = Object.freeze([
  'defaults-migration',
  'settings-matrix',
  'switch-revoke',
  'reopen-clear',
  'initialization-failure',
  'kill-after-durable-ack',
]);
const REQUEST_KEYS = ['caseId', 'install', 'caseRoot', 'manifestSha256'];
const RECEIPT_KEYS = ['schemaVersion', 'caseId', 'manifestSha256', 'status', 'code'];
const FAILURE_CODES = ['input_rejected', 'identity_mismatch', 'boundary_failed', 'timeout'];
const fail = () => new Error('nsis_runtime_boundary_contract_failed');

function guarded(action) {
  try {
    return action();
  } catch {
    // Filesystem/native parser errors can contain paths or untrusted text.
    throw fail();
  }
}

function exactRecord(input, keys) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) throw fail();
  const result = {};
  for (const key of keys) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    result[key] = slot.value;
  }
  return result;
}

function checkedCase(value) {
  if (typeof value !== 'string' || !RUNTIME_BOUNDARY_CASES.includes(value)) throw fail();
  return value;
}

function checkedHash(value) {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value))
    throw fail();
  return value;
}

function unsafePathCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function checkedPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    !value.isWellFormed() ||
    value !== value.trim() ||
    !path.isAbsolute(value) ||
    (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value)) ||
    /^[\\/]{2}/.test(value) ||
    unsafePathCharacter(value) ||
    value.split(/[\\/]/).some((part) => part === '.' || part === '..') ||
    (process.platform === 'win32' ? value.slice(2) : value).includes(':')
  )
    throw fail();
  return path.resolve(value);
}

function checkedRequest(value) {
  const request = exactRecord(value, REQUEST_KEYS);
  return {
    caseId: checkedCase(request.caseId),
    install: checkedPath(request.install),
    caseRoot: checkedPath(request.caseRoot),
    manifestSha256: checkedHash(request.manifestSha256),
  };
}

// Lexical validation only: no file is created/read and no case is executed.
function parseRuntimeBoundaryArguments(args) {
  return guarded(() => {
    if (
      !Array.isArray(args) ||
      types.isProxy(args) ||
      Object.getPrototypeOf(args) !== Array.prototype
    )
      throw fail();
    const names = Reflect.ownKeys(args);
    if (
      names.length !== 5 ||
      names.some((name) => !['0', '1', '2', '3', 'length'].includes(name)) ||
      Object.getOwnPropertyDescriptor(args, 'length')?.value !== 4
    )
      throw fail();
    const values = [];
    for (const name of ['0', '1', '2', '3']) {
      const slot = Object.getOwnPropertyDescriptor(args, name);
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
      values.push(slot.value);
    }
    return Object.freeze(
      checkedRequest({
        caseId: values[0],
        install: values[1],
        caseRoot: values[2],
        manifestSha256: values[3],
      })
    );
  });
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

// ownedRoot is a trusted controller capability, not proof inferred from CLI.
// Reuses installed-byte verification and physical path/link guards. This is
// read-only preflight, not atomic authorization for future writes/child launch:
// a future runner must revalidate identity/ownership at each mutation boundary.
function verifyBoundaryInstallation(input, ownedRoot, verify) {
  return guarded(() => {
    const request = checkedRequest(input);
    const root = safePath(checkedPath(ownedRoot), true);
    const install = safePath(request.install, true);
    const caseRoot = safePath(request.caseRoot, true);
    if (
      !inside(root, install) ||
      !inside(root, caseRoot) ||
      samePath(install, caseRoot) ||
      inside(install, caseRoot) ||
      inside(caseRoot, install)
    )
      throw fail();
    const installed = verify(install, request.manifestSha256);
    return Object.freeze({ ...request, ...installed, install, caseRoot });
  });
}

function verifyRuntimeBoundaryInstallation(input, ownedRoot) {
  return verifyBoundaryInstallation(input, ownedRoot, verifyInstallation);
}

// Fixed preload-only selection; callers cannot supply a validator or selector.
function verifyRuntimeBoundaryInstallationParallel(input, ownedRoot) {
  return verifyBoundaryInstallation(input, ownedRoot, verifyInstallationParallel);
}

// No case runner exists in this increment. Accept only explicit non-execution
// or sanitized failure receipts; success cannot be manufactured by this API.
function parseRuntimeBoundaryReceipt(input) {
  return guarded(() => {
    const value = exactRecord(input, RECEIPT_KEYS);
    if (
      value.schemaVersion !== 1 ||
      !(
        (value.status === 'not_run' && value.code === 'not_implemented') ||
        (value.status === 'failed' && FAILURE_CODES.includes(value.code))
      )
    )
      throw fail();
    return Object.freeze({
      schemaVersion: 1,
      caseId: checkedCase(value.caseId),
      manifestSha256: checkedHash(value.manifestSha256),
      status: value.status,
      code: value.code,
    });
  });
}

module.exports = {
  RUNTIME_BOUNDARY_CASES,
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallation,
  verifyRuntimeBoundaryInstallationParallel,
  parseRuntimeBoundaryReceipt,
};
