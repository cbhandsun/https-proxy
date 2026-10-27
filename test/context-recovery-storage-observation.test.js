'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRecoveryStorageInventory,
  createRecoveryRootInventory,
  aliasRecoveryStorageInventory,
  observeRecoveryStorageCalls,
} = require('../lib/proxy/context-recovery-storage-inventory');

function fixture(execute = () => Promise.resolve({ revision: 1 })) {
  const service = { execute },
    original = execute;
  const writes = createRecoveryStorageInventory(service);
  const index = createRecoveryRootInventory(service, new Map([['root', {}]]));
  const active = new Set(['root']);
  index.completeDiscovery(index.beforeDiscovery());
  return { service, original, writes, index, active };
}

test('trusted taps preserve receivers, arguments, native promise and thrown error identities', async () => {
  const pending = Promise.resolve({ revision: 1 }),
    cause = Error('private sentinel');
  const calls = [],
    seen = [];
  let throws = false,
    next = pending;
  const f = fixture(function (...args) {
    calls.push({ receiver: this, args });
    if (throws) throw cause;
    return next;
  });
  const tap = observeRecoveryStorageCalls(f.service, (args, result, threw) => {
    seen.push({ args, result, threw });
  });
  const request = { operation: 'load' },
    receiver = {};
  assert.equal(Reflect.apply(f.service.execute, receiver, [request]), pending);
  await pending;
  assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args[0], request);
  assert.equal(seen[0].args[0], request);
  assert.equal(seen[0].result, pending);
  assert.equal(seen[0].threw, false);
  assert.equal(f.index.allActive(f.active), true);
  next = Promise.reject(cause);
  assert.equal(f.service.execute(request), next);
  await assert.rejects(next, (error) => error === cause);
  assert.equal(seen[1].result, next);
  assert.equal(seen[1].threw, false);
  throws = true;
  assert.throws(
    () => f.service.execute(request),
    (error) => error === cause
  );
  assert.equal(seen[2].threw, true);
  assert.equal(seen[2].result, undefined);
  tap.close();
  tap.close();
  assert.equal(f.service.execute, f.original);
});

test('aliases retain the same fence and unknown, outstanding and external writes still invalidate it', () => {
  const f = fixture(),
    alias = { execute: (...args) => f.service.execute(...args) };
  assert.equal(aliasRecoveryStorageInventory(alias, f.service), true);
  const index = createRecoveryRootInventory(alias, new Map([['root', {}]]));
  index.completeDiscovery(index.beforeDiscovery());
  const tap = observeRecoveryStorageCalls(f.service, () => {});
  assert.equal(index.allActive(f.active), true);
  const finish = index.begin('save'),
    done = f.writes.begin('save');
  assert.equal(index.allActive(f.active), false);
  done();
  finish(true);
  assert.equal(index.allActive(f.active), true);
  f.writes.begin('future-operation')();
  assert.equal(index.allActive(f.active), false);
  tap.close();
  assert.equal(index.allActive(f.active), false);
});

test('untrusted, replaced, closed, busy and already observed services cannot acquire provenance', () => {
  let hooks = 0;
  const poison = () => {
    hooks++;
    throw Error('private sentinel');
  };
  assert.equal(observeRecoveryStorageCalls(new Proxy({}, { get: poison }), poison), null);
  for (const mode of ['replace', 'close', 'busy', 'observed']) {
    const f = fixture();
    let tap;
    if (mode === 'replace') f.service.execute = () => {};
    if (mode === 'close') f.writes.close();
    if (mode === 'busy') f.writes.begin('save');
    if (mode === 'observed') tap = observeRecoveryStorageCalls(f.service, () => {});
    assert.throws(() => observeRecoveryStorageCalls(f.service, () => {}));
    tap?.close();
  }
  const f = fixture();
  for (const callback of [
    null,
    {},
    new Proxy(poison, { get: poison }),
    async () => {},
    function* () {},
  ])
    assert.throws(() => observeRecoveryStorageCalls(f.service, callback));
  assert.equal(f.service.execute, f.original);
  assert.equal(hooks, 0);
});

test('observer errors and malformed returns never alter storage results and permanently invalidate the fence', async () => {
  let hooks = 0;
  for (const mode of ['throws', 'object', 'reject', 'thenable']) {
    const pending = Promise.resolve({ revision: 1 }),
      f = fixture(() => pending);
    const tap = observeRecoveryStorageCalls(f.service, () => {
      if (mode === 'throws') throw Error('private sentinel');
      if (mode === 'reject') return Promise.reject(Error('private sentinel'));
      if (mode === 'thenable')
        return Object.defineProperty({}, 'then', {
          get() {
            hooks++;
            return undefined;
          },
        });
      return {};
    });
    assert.equal(f.service.execute({ operation: 'load' }), pending);
    await pending;
    assert.equal(f.index.allActive(f.active), false);
    assert.throws(() => tap.close());
    assert.equal(f.service.execute, f.original);
    assert.throws(() => tap.close());
  }
  assert.equal(hooks, 0);
});

test('foreign method or descriptor changes produce sticky close failure and are never overwritten', () => {
  for (const mode of ['method', 'descriptor', 'accessor']) {
    const f = fixture(),
      tap = observeRecoveryStorageCalls(f.service, () => {});
    const foreign = () => Promise.resolve({ revision: 99 });
    if (mode === 'method') f.service.execute = foreign;
    if (mode === 'descriptor') Object.defineProperty(f.service, 'execute', { enumerable: false });
    if (mode === 'accessor') Object.defineProperty(f.service, 'execute', { get: foreign });
    const slot = Object.getOwnPropertyDescriptor(f.service, 'execute');
    assert.throws(() => tap.close());
    assert.throws(() => tap.close());
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.service, 'execute'), slot);
    assert.equal(f.index.allActive(f.active), false);
  }
});

test('captured wrappers remain transparent after close and restoration failures cannot reenable the fence', async (t) => {
  const pending = Promise.resolve({ revision: 1 });
  const f = fixture(() => pending);
  let observed = 0;
  const tap = observeRecoveryStorageCalls(f.service, () => {
    observed++;
  });
  const captured = f.service.execute;
  tap.close();
  assert.equal(Reflect.apply(captured, f.service, [{ operation: 'load' }]), pending);
  await pending;
  assert.equal(observed, 0);
  assert.equal(f.index.allActive(f.active), true);

  const other = fixture(() => pending);
  const broken = observeRecoveryStorageCalls(other.service, () => {});
  const define = Object.defineProperty;
  t.mock.method(Object, 'defineProperty', (target, name, slot) => {
    if (target === other.service && name === 'execute') throw Error('private sentinel');
    return Reflect.apply(define, Object, [target, name, slot]);
  });
  assert.throws(() => broken.close());
  assert.throws(() => broken.close());
  assert.equal(other.index.allActive(other.active), false);
  assert.equal(other.service.execute({ operation: 'load' }), pending);
  await pending;
});
