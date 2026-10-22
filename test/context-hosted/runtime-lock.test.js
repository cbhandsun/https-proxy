'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRuntimeLock } = require('../../scripts/context-hosted/runtime-lock');
function fixture() {
  const sourcePackage = {
    name: 'synthetic',
    version: '1.0.0',
    hpm: { releaseRuntimeDependencies: ['prod'] },
    dependencies: { prod: '1.0.0' },
    devDependencies: { dev: '2.0.0' },
  };
  const prod = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/prod/-/prod-1.0.0.tgz',
    integrity: 'sha512-SYNTHETIC',
  };
  const sourceLock = {
    name: 'synthetic',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'synthetic',
        version: '1.0.0',
        dependencies: { prod: '1.0.0' },
        devDependencies: { dev: '2.0.0' },
      },
      'node_modules/prod': prod,
      'node_modules/dev': { version: '2.0.0', dev: true },
    },
  };
  const runtimePackage = {
    name: 'synthetic',
    version: '1.0.0',
    private: true,
    dependencies: { prod: '1.0.0' },
  };
  const runtimeLock = {
    name: 'synthetic',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'synthetic', version: '1.0.0', dependencies: { prod: '1.0.0' } },
      'node_modules/prod': { ...prod },
    },
  };
  return [sourcePackage, sourceLock, runtimePackage, runtimeLock];
}
test('pruned runtime lock passes while remaining different from the verified source lock', () => {
  const args = fixture();
  assert.notEqual(JSON.stringify(args[1]), JSON.stringify(args[3]));
  assert.deepEqual(validateRuntimeLock(...args), {
    sourceLockAndRuntimeLockSeparated: true,
    retainedPackages: 1,
  });
});
test('runtime lock rejects missing packages, altered integrity, injected package, source-only dev root and wrong dependency', () => {
  const cases = [
    (lock) => {
      delete lock.packages['node_modules/prod'];
    },
    (lock) => {
      lock.packages['node_modules/prod'].integrity = 'sha512-ALTERED';
    },
    (lock) => {
      lock.packages['node_modules/unknown'] = { version: '1' };
    },
    (lock) => {
      lock.packages[''].devDependencies = { dev: '2.0.0' };
    },
    (lock) => {
      lock.packages[''].dependencies.prod = '9.0.0';
    },
    (lock) => {
      lock.packages['node_modules/../prod'] = { version: '1' };
    },
  ];
  for (const mutate of cases) {
    const args = fixture();
    mutate(args[3]);
    assert.throws(
      () => validateRuntimeLock(...args),
      /^Error: context_hosted_runtime_lock_rejected$/
    );
  }
});
test('lock boundary rejects null, arrays, proxy, nested accessor and excessive depth before executing properties', () => {
  let touched = 0;
  for (const value of [
    null,
    [],
    new Proxy(
      {},
      {
        ownKeys() {
          touched++;
          return [];
        },
      }
    ),
    {
      hpm: Object.defineProperty({}, 'releaseRuntimeDependencies', {
        enumerable: true,
        get() {
          touched++;
          return [];
        },
      }),
    },
  ]) {
    const args = fixture();
    args[0] = value;
    assert.throws(() => validateRuntimeLock(...args));
  }
  assert.equal(touched, 0);
  const args = fixture();
  let deep = {};
  args[3].extra = deep;
  for (let index = 0; index < 20; index++) {
    deep.next = {};
    deep = deep.next;
  }
  assert.throws(() => validateRuntimeLock(...args));
});
