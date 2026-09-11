'use strict';

const assert = require('assert');

const { createLazyManagementHandlers } = require('../lib/proxy/lazy-management-handlers');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('defers management module loading until a handler is accessed', () => {
  let loadCount = 0;
  let createCount = 0;
  const expectedHandler = () => 'ok';
  const handlers = createLazyManagementHandlers(
    { marker: 'deps' },
    {
      loadModule() {
        loadCount += 1;
        return {
          createManagementHandlers(deps) {
            createCount += 1;
            assert.deepStrictEqual(deps, { marker: 'deps' });
            return { health: expectedHandler };
          },
        };
      },
    }
  );

  assert.strictEqual(handlers.isInitialized(), false);
  assert.strictEqual(loadCount, 0);
  assert.strictEqual(handlers.health, expectedHandler);
  assert.strictEqual(handlers.isInitialized(), true);
  assert.strictEqual(loadCount, 1);
  assert.strictEqual(createCount, 1);
});

test('reuses the initialized handler aggregate for subsequent accesses', () => {
  let loadCount = 0;
  const handlers = createLazyManagementHandlers(null, {
    loadModule() {
      loadCount += 1;
      return {
        createManagementHandlers() {
          return { first: () => 1, second: () => 2 };
        },
      };
    },
  });

  assert.strictEqual(handlers.first(), 1);
  assert.strictEqual(handlers.second(), 2);
  assert.strictEqual(handlers.initialize().first(), 1);
  assert.strictEqual(loadCount, 1);
});

test('rejects invalid loaders and module exports', () => {
  assert.throws(
    () => createLazyManagementHandlers({}, { loadModule: true }),
    /loadModule to be a function/
  );

  for (const loadedModule of [null, {}, { createManagementHandlers: true }]) {
    const handlers = createLazyManagementHandlers({}, { loadModule: () => loadedModule });
    assert.throws(() => handlers.health, /must export createManagementHandlers/);
    assert.strictEqual(handlers.isInitialized(), false);
  }
});

test('does not cache failed or invalid handler initialization', () => {
  let createCount = 0;
  const handlers = createLazyManagementHandlers(
    {},
    {
      loadModule() {
        return {
          createManagementHandlers() {
            createCount += 1;
            return createCount === 1 ? null : { health: () => 'recovered' };
          },
        };
      },
    }
  );

  assert.throws(() => handlers.health, /must return an object/);
  assert.strictEqual(handlers.health(), 'recovered');
  assert.strictEqual(createCount, 2);
});

test('default loader resolves the production management aggregate', () => {
  const handlers = createLazyManagementHandlers({});
  assert.strictEqual(handlers.isInitialized(), false);
  assert.throws(() => handlers.initialize(), /requires sendJson|Cannot destructure|is required/);
  assert.strictEqual(handlers.isInitialized(), false);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack}\n`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  process.stdout.write(`\n${passed}/${tests.length} lazy management handler tests passed\n`);
}
