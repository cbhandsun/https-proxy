'use strict';

const { types } = require('node:util');
const { createRuntimePackage } = require('../../lib/release/layout');
const fail = () => new Error('context_hosted_runtime_lock_rejected');

function data(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== 'string' ||
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      types.isProxy(slot.value)
    )
      throw fail();
    result[key] = slot.value;
  }
  return result;
}
function canonical(value, depth = 0) {
  if (depth > 16) throw fail();
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value) && !types.isProxy(value)) {
    if (value.length > 20000) throw fail();
    return (
      '[' +
      Array.from({ length: value.length }, (_, index) => {
        const slot = Object.getOwnPropertyDescriptor(value, String(index));
        if (!slot || !Object.hasOwn(slot, 'value')) throw fail();
        return canonical(slot.value, depth + 1);
      }).join(',') +
      ']'
    );
  }
  const object = data(value);
  if (Object.keys(object).length > 20000) throw fail();
  return (
    '{' +
    Object.keys(object)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(object[key], depth + 1))
      .join(',') +
    '}'
  );
}
// npm intentionally prunes the source lock. Compare the projected runtime root
// and retained package identities, never the two different lockfile byte hashes.
function validateRuntimeLock(sourcePackage, sourceLock, runtimePackage, runtimeLock) {
  try {
    sourcePackage = data(sourcePackage);
    sourceLock = data(sourceLock);
    runtimePackage = data(runtimePackage);
    runtimeLock = data(runtimeLock);
    canonical(sourcePackage);
    canonical(sourceLock);
    canonical(runtimePackage);
    canonical(runtimeLock);
    const expected = createRuntimePackage(sourcePackage);
    if (
      canonical(runtimePackage) !== canonical(expected) ||
      runtimeLock.lockfileVersion !== sourceLock.lockfileVersion ||
      runtimeLock.name !== expected.name ||
      runtimeLock.version !== expected.version
    )
      throw fail();
    const original = data(sourceLock.packages),
      actual = data(runtimeLock.packages),
      root = data(actual['']);
    if (
      root.name !== expected.name ||
      root.version !== expected.version ||
      canonical(root.dependencies) !== canonical(expected.dependencies) ||
      root.devDependencies ||
      root.scripts ||
      Object.keys(actual).length < 2 ||
      Object.keys(actual).length > Object.keys(original).length
    )
      throw fail();
    for (const name of Object.keys(expected.dependencies))
      if (!Object.hasOwn(actual, 'node_modules/' + name)) throw fail();
    const fields = [
      'name',
      'version',
      'resolved',
      'integrity',
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'engines',
      'os',
      'cpu',
      'link',
    ];
    for (const [name, row] of Object.entries(actual)) {
      if (name === '') continue;
      if (
        !name.startsWith('node_modules/') ||
        name.includes('\\') ||
        name.split('/').some((part) => part === '..' || part === '.')
      )
        throw fail();
      const retained = data(row),
        source = data(original[name]);
      for (const field of fields) {
        if (
          Object.hasOwn(retained, field) !== Object.hasOwn(source, field) ||
          (Object.hasOwn(source, field) && canonical(retained[field]) !== canonical(source[field]))
        )
          throw fail();
      }
    }
    return Object.freeze({
      sourceLockAndRuntimeLockSeparated: true,
      retainedPackages: Object.keys(actual).length - 1,
    });
  } catch {
    throw fail();
  }
}
module.exports = { validateRuntimeLock, data };
