'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'),
  path = require('node:path');
const {
  installPublicationStorageObserver,
} = require('../../scripts/context-hosted/n09-business/publication-storage-observer');
const contract = require('../../lib/proxy/context-recovery-storage-contract');
const names = [
  'Scan',
  'SourcePages',
  'ReaderSettlement',
  'ReferenceWrites',
  'ReferenceStates',
  'ReferenceAdmission',
  'ReferenceScan',
  'ReadSettlement',
];
const directory = path.join(os.tmpdir(), 'n09-observer-only');
function request(revision, publications = []) {
  return {
    operation: 'save-reference-state',
    scope: 'a'.repeat(64),
    expectedRevision: revision,
    reference: { metadata: { rootId: 'hbs_' + 'b'.repeat(32), expiresAt: 1000 }, publications },
  };
}
function setup(t, flags = true) {
  const calls = [];
  let next;
  const service = {
    execute(...args) {
      calls.push({ receiver: this, args });
      return next ?? Promise.resolve({ revision: args[0].expectedRevision + 1 });
    },
    close() {},
  };
  const original = service.execute;
  if (flags) for (const name of names) contract['declareRecovery' + name](original);
  let opened, opening;
  const exports = {
    openContextRecoveryStorage(...args) {
      opened = { receiver: this, args };
      opening = Promise.resolve(service);
      return opening;
    },
  };
  const constructor = exports.openContextRecoveryStorage;
  const observer = installPublicationStorageObserver({
    storageExports: exports,
    storageContract: contract,
    expectedDirectory: directory,
  });
  let expectedCloseFailure = false;
  t.after(() => {
    if (expectedCloseFailure) assert.throws(() => observer.close());
    else observer.close();
  });
  return {
    service,
    calls,
    exports,
    observer,
    constructor,
    expectCloseFailure() {
      expectedCloseFailure = true;
    },
    original,
    setNext(value) {
      next = value;
    },
    getOpened: () => opened,
    getOpening: () => opening,
  };
}

test('constructor, actual service, requests, receivers and native promise identities are preserved with exact capability forwarding', async (t) => {
  const f = setup(t);
  const options = { directory, onStartup() {} },
    receiver = {};
  const opening = Reflect.apply(f.exports.openContextRecoveryStorage, receiver, [options]);
  assert.equal(opening, f.getOpening());
  assert.equal(await opening, f.service);
  assert.equal(f.getOpened().receiver, receiver);
  assert.equal(f.getOpened().args[0], options);
  for (const name of names)
    assert.equal(contract['supportsRecovery' + name](f.service.execute), true);
  const first = request(0),
    pending = Promise.resolve({ revision: 1 });
  f.setNext(pending);
  assert.equal(f.service.execute(first), pending);
  await pending;
  assert.equal(f.calls[0].receiver, f.service);
  assert.equal(f.calls[0].args[0], first);
  let done;
  const second = new Promise((resolve) => {
    done = resolve;
  });
  f.setNext(second);
  const next = request(1, [{ snapshotId: 'snapshot', state: 'prepared' }]);
  assert.equal(f.service.execute(next), second);
  assert.deepEqual(f.observer.inspect(), {
    generation: 1,
    callOrdinal: 2,
    activeCount: 1,
    operation: 'save-reference-state',
    transition: 'prepared',
    rootId: 'hbs_' + 'b'.repeat(32),
    expiresAt: 1000,
    expectedRevision: 1,
    status: 'pending',
  });
  done({ revision: 2 });
  await second;
  assert.equal(f.observer.inspect().status, 'completed');
  f.setNext(undefined);
  await f.service.execute(request(2, [{ snapshotId: 'snapshot', state: 'withdrawn' }]));
  assert.equal(
    f.observer.inspect().transition,
    'withdrawn',
    'compensation is never mislabeled prepared'
  );
  f.observer.close();
  assert.equal(f.service.execute, f.original);
  assert.equal(f.exports.openContextRecoveryStorage, f.constructor);
  assert.throws(() => f.observer.inspect());
});

test('unsupported capabilities are never fabricated and another directory stays untouched', async (t) => {
  const f = setup(t, false);
  await f.exports.openContextRecoveryStorage({ directory: directory + '-other' });
  assert.equal(f.service.execute, f.original);
  await f.exports.openContextRecoveryStorage({ directory });
  for (const name of names)
    assert.equal(contract['supportsRecovery' + name](f.service.execute), false);
});

test('parallel commands are ambiguous rather than permission to select a convenient publication', async (t) => {
  const f = setup(t);
  await f.exports.openContextRecoveryStorage({ directory });
  await f.service.execute(request(0));
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.setNext(pending);
  f.service.execute(request(1, [{ snapshotId: 'one', state: 'prepared' }]));
  f.service.execute({ operation: 'inspect' });
  assert.equal(f.observer.inspect().status, 'ambiguous');
  assert.equal(f.observer.inspect().activeCount, 2);
  release({ revision: 2 });
  await pending;
});

test('rejection and malformed data poison observation without changing the original result or executing metadata accessors', async (t) => {
  const f = setup(t);
  await f.exports.openContextRecoveryStorage({ directory });
  let touched = 0;
  const bad = Object.defineProperty(request(0), 'reference', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const pending = Promise.resolve({ revision: 1 });
  f.setNext(pending);
  assert.equal(f.service.execute(bad), pending);
  await pending;
  assert.equal(f.observer.inspect().status, 'failed');
  assert.equal(touched, 0);
  const other = setup(t);
  await other.exports.openContextRecoveryStorage({ directory });
  const cause = Error('PRIVATE');
  const rejected = Promise.reject(cause);
  other.setNext(rejected);
  assert.equal(other.service.execute(request(0)), rejected);
  await assert.rejects(rejected, (error) => error === cause);
  assert.equal(other.observer.inspect().status, 'failed');
});

test('backend overrides at the selected constructor fail before dispatch and tampered restoration never succeeds', async (t) => {
  const f = setup(t);
  assert.throws(() => f.exports.openContextRecoveryStorage({ directory, WorkerType() {} }));
  assert.equal(f.getOpened(), undefined);
  const other = setup(t);
  await other.exports.openContextRecoveryStorage({ directory });
  other.service.execute = () => {};
  assert.throws(() => other.observer.close());
  assert.throws(() => other.observer.close());
  assert.equal(other.exports.openContextRecoveryStorage, other.constructor);
  // The tampering is the expected cleanup failure for this fixture.
  other.expectCloseFailure();
});
