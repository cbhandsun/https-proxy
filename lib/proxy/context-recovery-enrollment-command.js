'use strict';

const { types } = require('node:util');
const { storageDirectory } = require('./context-recovery-storage-paths');
const { storageFailure } = require('./context-recovery-storage-contract');

function argumentsList(input) {
  if (
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  )
    throw storageFailure();
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  if (![3, 5].includes(length) || Reflect.ownKeys(input).length !== length + 1)
    throw storageFailure();
  const output = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 4096 ||
      /[\0\r\n]/.test(descriptor.value)
    )
      throw storageFailure();
    output.push(descriptor.value);
  }
  return output;
}

function parseLegacyEnrollmentArguments(input) {
  const args = argumentsList(input);
  const mode = args[0];
  if (
    args[1] !== '--directory' ||
    !['preview', 'enroll'].includes(mode) ||
    (mode === 'preview' && args.length !== 3) ||
    (mode === 'enroll' &&
      (args.length !== 5 || args[3] !== '--fingerprint' || !/^[a-f0-9]{64}$/.test(args[4])))
  )
    throw storageFailure();
  const directory = storageDirectory(args[2]);
  return Object.freeze({
    mode,
    input: Object.freeze(
      mode === 'preview' ? { directory } : { directory, expectedFingerprint: args[4] }
    ),
  });
}

// Offline operator boundary only. Normal startup and worker messages cannot
// invoke this command. Never print the directory, original, key or raw errors.
function executeLegacyEnrollmentCommand(args, run) {
  try {
    const request = parseLegacyEnrollmentArguments(args);
    const owner =
      run ?? require('./context-recovery-anchor-legacy-owner').runLegacyAnchorEnrollment;
    if (typeof owner !== 'function' || types.isProxy(owner) || types.isAsyncFunction(owner))
      throw storageFailure();
    const result = owner(request.input);
    // Validate own data descriptors before serializing a trusted owner's result.
    if (
      !result ||
      typeof result !== 'object' ||
      types.isProxy(result) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(result))
    )
      throw storageFailure();
    const keys =
      request.mode === 'preview'
        ? ['fingerprint', 'storeId', 'scopeCount', 'maxTime']
        : ['enrolled'];
    if (Reflect.ownKeys(result).length !== keys.length) throw storageFailure();
    const values = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw storageFailure();
      values[key] = descriptor.value;
    }
    if (request.mode === 'enroll') {
      if (values.enrolled !== true) throw storageFailure();
      return Object.freeze({ exitCode: 0, stdout: '{"enrolled":true}\n', stderr: '' });
    }
    if (
      typeof values.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(values.fingerprint) ||
      typeof values.storeId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(values.storeId) ||
      !Number.isSafeInteger(values.scopeCount) ||
      values.scopeCount < 0 ||
      values.scopeCount > 256 ||
      !Number.isSafeInteger(values.maxTime) ||
      values.maxTime < 0
    )
      throw storageFailure();
    return Object.freeze({
      exitCode: 0,
      stdout:
        JSON.stringify({
          fingerprint: values.fingerprint,
          scopeCount: values.scopeCount,
          maxTime: values.maxTime,
        }) + '\n',
      stderr: '',
    });
  } catch {
    return Object.freeze({
      exitCode: 1,
      stdout: '',
      stderr: 'context_recovery_enrollment_failed\n',
    });
  }
}

module.exports = { parseLegacyEnrollmentArguments, executeLegacyEnrollmentCommand };
