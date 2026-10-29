'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');

const filename = require.resolve('../lib/proxy/context-recovery-storage-paths');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);

function fixture(t, secure) {
  const root = fs.mkdtempSync(
    path.join(resolvePhysicalTestTempDirectory(), 'hpm-directory-progress-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} };
  vm.runInNewContext(
    source,
    {
      module,
      require(name) {
        return name === './context-recovery-private-path'
          ? { secureRecoveryStoragePath: secure }
          : localRequire(name);
      },
      Buffer,
      TextDecoder,
      process: { platform: process.platform },
    },
    { filename }
  );
  return { directory: path.join(root, 'store'), create: module.exports.createStoragePaths };
}

test('directory ACL progress brackets the actual private-path operation with fixed metadata', (t) => {
  const events = [];
  const f = fixture(t, (file, kind) => {
    assert.equal(file, f.directory);
    assert.equal(kind, 'directory');
    assert.deepEqual(
      events.map((event) => event.phase),
      ['directory_acl_started']
    );
    assert.deepEqual(fs.readdirSync(file), []);
  });
  const paths = f.create(f.directory, (event) => events.push(event));
  assert.equal(paths.directory, f.directory);
  assert.deepEqual(
    events.map((event) => event.phase),
    ['directory_acl_started', 'directory_acl_finished']
  );
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['elapsedMs', 'phase']);
    assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0);
  }
  assert.ok(events[1].elapsedMs >= events[0].elapsedMs);
});

test('a failed directory ACL never reports completion or leaks its exception', (t) => {
  const phases = [];
  const f = fixture(t, () => {
    throw new Error('PRIVATE_DIRECTORY_SENTINEL');
  });
  assert.throws(() => f.create(f.directory, ({ phase }) => phases.push(phase)), {
    code: 'context_recovery_storage_unavailable',
    message: 'context_recovery_storage_unavailable',
  });
  assert.deepEqual(phases, ['directory_acl_started']);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('directory progress cannot grant admission and observer failures cannot alter ACL execution', (t) => {
  let secured = 0;
  const f = fixture(t, () => secured++);
  const observed = [];
  const paths = f.create(f.directory, ({ phase }) => {
    observed.push(phase);
    throw new Error('PRIVATE_OBSERVER_SENTINEL');
  });
  assert.equal(secured, 1);
  assert.equal(paths.directory, f.directory);
  assert.deepEqual(observed, ['directory_acl_started', 'directory_acl_finished']);
  paths.verify();
});

test('invalid and excessive inputs produce no directory phase or ACL effect', (t) => {
  let secured = 0;
  let hooks = 0;
  const f = fixture(t, () => secured++);
  const phases = [];
  const observe = ({ phase }) => phases.push(phase);
  for (const input of [
    null,
    undefined,
    '',
    'relative',
    path.parse(f.directory).root,
    '\0',
    'x'.repeat(4097),
  ])
    assert.throws(() => f.create(input, observe));
  for (const observer of [
    null,
    {},
    '',
    true,
    new Proxy(
      {},
      {
        ownKeys() {
          hooks++;
          throw new Error('PRIVATE_INPUT_SENTINEL');
        },
      }
    ),
  ])
    assert.throws(() => f.create(f.directory, observer));
  assert.equal(secured, 0);
  assert.equal(hooks, 0);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(phases, []);
});

test('directory observations do not consume custom thenables or leave rejected promises unhandled', async (t) => {
  let hooks = 0;
  let secured = 0;
  const f = fixture(t, () => secured++);
  for (const result of [
    Object.defineProperty({}, 'then', {
      get() {
        hooks++;
        throw new Error('PRIVATE_THEN_SENTINEL');
      },
    }),
    Promise.reject(new Error('PRIVATE_REJECTION_SENTINEL')),
  ]) {
    const paths = f.create(f.directory, () => result);
    paths.verify();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secured, 2);
  assert.equal(hooks, 0);
});
