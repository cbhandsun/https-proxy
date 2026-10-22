'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSameDirectoryLease,
} = require('../../scripts/context-hosted/n09-ipc/same-directory-lease.js');
function fixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n09-lease-simulation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(configDir);
  fs.mkdirSync(runtimeDir);
  const killed = [];
  const operations = {
    startFreshOwnedCase: () => ({ pid: 10 }),
    restartExistingOwnedCase: () => ({ pid: 11 }),
    stopOwnedCase: (handle) => {
      killed.push(handle.pid);
      return true;
    },
    closeOwnedHandle: () => true,
    attestLifecycleIdentity: (handle) => {
      const value = {
        pid: handle.pid,
        manifestSha256: 'a'.repeat(64),
        configDir,
        runtimeDir,
        evidenceLevel: 'lifecycle-identity-only',
      };
      mutate(value);
      return value;
    },
  };
  const lease = createSameDirectoryLease({ ownedRoot: root, operations });
  return { root, runtimeDir, lease, killed, operations };
}
test('private lease retains same directories with distinct new PID and no arbitrary selectors', async (t) => {
  const f = fixture(t);
  const first = await f.lease.startFreshBusinessHost();
  assert.equal((await f.lease.killOwnedJob(first)).treeEmpty, true);
  const next = await f.lease.restartSameBusinessHost(first);
  assert.equal(next.pid, 11);
  assert.equal(first.runtimeDir, next.runtimeDir);
  await f.lease.killOwnedJob(next);
  assert.deepEqual(f.killed, [10, 11]);
});
for (const field of ['pid', 'manifestSha256', 'configDir', 'runtimeDir'])
  test('invalid restarted ' + field + ' closes newly launched handle', async (t) => {
    const f = fixture(t, (value) => {
      if (value.pid === 11)
        value[field] =
          field === 'pid'
            ? 10
            : field === 'manifestSha256'
              ? 'b'.repeat(64)
              : path.join(value[field], 'changed');
    });
    const first = await f.lease.startFreshBusinessHost();
    await f.lease.killOwnedJob(first);
    await assert.rejects(f.lease.restartSameBusinessHost(first), /n09_same_directory_rejected/);
    assert.deepEqual(f.killed, [10, 11]);
  });
test('directory replacement cannot suppress cleanup of a live owned Job', async (t) => {
  const f = fixture(t);
  const first = await f.lease.startFreshBusinessHost();
  fs.renameSync(f.runtimeDir, f.runtimeDir + '-original');
  fs.mkdirSync(f.runtimeDir);
  await assert.rejects(f.lease.killOwnedJob(first), /n09_same_directory_rejected/);
  assert.deepEqual(f.killed, [10]);
});
test('cannot restart a running or unowned lease', async (t) => {
  const f = fixture(t);
  const first = await f.lease.startFreshBusinessHost();
  await assert.rejects(f.lease.restartSameBusinessHost(first), /n09_same_directory_rejected/);
  await f.lease.killOwnedJob(first);
  await assert.rejects(
    f.lease.restartSameBusinessHost({ ...first, pid: 999 }),
    /n09_same_directory_rejected/
  );
});
test('failed Job cleanup is never a successful restart prerequisite', async (t) => {
  const f = fixture(t);
  const first = await f.lease.startFreshBusinessHost();
  // Functions are snapshotted at composition; build another lease with a failing stop.
  const bad = createSameDirectoryLease({
    ownedRoot: f.root,
    operations: { ...f.operations, stopOwnedCase: () => false },
  });
  const owner = await bad.startFreshBusinessHost();
  await assert.rejects(bad.killOwnedJob(owner), /n09_same_directory_rejected/);
  await assert.rejects(bad.restartSameBusinessHost(owner), /n09_same_directory_rejected/);
  await f.lease.killOwnedJob(first);
});

for (const stopBehavior of ['throw', 'false'])
  for (const disposeBehavior of ['success', 'throw'])
    test(`stop ${stopBehavior} still disposes; disposal ${disposeBehavior} never creates tree-empty ACK`, async (t) => {
      const f = fixture(t);
      let closed = 0;
      const bad = createSameDirectoryLease({
        ownedRoot: f.root,
        operations: {
          ...f.operations,
          stopOwnedCase() {
            if (stopBehavior === 'throw') throw new Error('PRIVATE token/path');
            return false;
          },
          closeOwnedHandle() {
            closed++;
            if (disposeBehavior === 'throw' && closed === 1) throw new Error('PRIVATE dispose');
            return true;
          },
        },
      });
      const owner = await bad.startFreshBusinessHost();
      await assert.rejects(bad.killOwnedJob(owner), /^Error: n09_same_directory_rejected$/);
      assert.equal(closed, 1);
      await assert.rejects(
        bad.restartSameBusinessHost(owner),
        /^Error: n09_same_directory_rejected$/
      );
      await bad.close();
      assert.equal(closed, disposeBehavior === 'throw' ? 2 : 1);
      await bad.close();
      assert.equal(closed, disposeBehavior === 'throw' ? 2 : 1);
    });

for (const operation of [
  'startFreshOwnedCase',
  'attestLifecycleIdentity',
  'restartExistingOwnedCase',
  'stopOwnedCase',
  'closeOwnedHandle',
])
  test(`${operation} PRIVATE exception is sanitized without inspecting error fields`, async (t) => {
    const f = fixture(t);
    let accessed = false;
    const privateError = Object.create(null);
    Object.defineProperty(privateError, 'message', {
      get() {
        accessed = true;
        throw new Error('PRIVATE');
      },
    });
    Object.defineProperty(privateError, 'cause', {
      get() {
        accessed = true;
        throw new Error('PRIVATE');
      },
    });
    const bad = createSameDirectoryLease({
      ownedRoot: f.root,
      operations: {
        ...f.operations,
        [operation]() {
          throw privateError;
        },
      },
    });
    let owner;
    if (['startFreshOwnedCase', 'attestLifecycleIdentity'].includes(operation)) {
      await assert.rejects(bad.startFreshBusinessHost(), /^Error: n09_same_directory_rejected$/);
    } else {
      owner = await bad.startFreshBusinessHost();
      if (operation === 'restartExistingOwnedCase') {
        await bad.killOwnedJob(owner);
        await assert.rejects(
          bad.restartSameBusinessHost(owner),
          /^Error: n09_same_directory_rejected$/
        );
      } else if (operation === 'stopOwnedCase') {
        await assert.rejects(bad.killOwnedJob(owner), /^Error: n09_same_directory_rejected$/);
      } else {
        await assert.rejects(bad.close(), /^Error: n09_same_directory_rejected$/);
      }
    }
    assert.equal(accessed, false);
  });

test('close attempts every captured handle even when one disposal fails', async (t) => {
  const f = fixture(t);
  const calls = [];
  const bad = createSameDirectoryLease({
    ownedRoot: f.root,
    operations: {
      ...f.operations,
      closeOwnedHandle(handle) {
        calls.push(handle.pid);
        if (handle.pid === 10 && calls.length === 1) throw new Error('PRIVATE');
        return true;
      },
    },
  });
  const owner = await bad.startFreshBusinessHost();
  await bad.killOwnedJob(owner);
  await bad.restartSameBusinessHost(owner);
  await assert.rejects(bad.close(), /^Error: n09_same_directory_rejected$/);
  assert.deepEqual(calls, [10, 11]);
  await bad.close();
  assert.deepEqual(calls, [10, 11, 10]);
});

for (const field of ['ownedRoot', 'operations'])
  test(`factory ${field} getter rejected without execution`, () => {
    let called = 0;
    const input = {};
    Object.defineProperty(input, field, {
      get() {
        called++;
        throw new Error('PRIVATE');
      },
    });
    assert.throws(() => createSameDirectoryLease(input), /^Error: n09_same_directory_rejected$/);
    assert.equal(called, 0);
  });

for (const target of ['factory', 'operations', 'function'])
  test(`${target} Proxy rejected before any trap`, (t) => {
    const f = fixture(t);
    let trapped = 0;
    const handler = Object.fromEntries(
      ['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'apply'].map((key) => [
        key,
        () => {
          trapped++;
          throw new Error('PRIVATE');
        },
      ])
    );
    let input = { ownedRoot: f.root, operations: f.operations };
    if (target === 'factory') input = new Proxy(input, handler);
    if (target === 'operations') input.operations = new Proxy(f.operations, handler);
    if (target === 'function')
      input.operations = { ...f.operations, stopOwnedCase: new Proxy(() => true, handler) };
    assert.throws(() => createSameDirectoryLease(input), /^Error: n09_same_directory_rejected$/);
    assert.equal(trapped, 0);
  });

test('operations method getter rejected without execution', (t) => {
  const f = fixture(t);
  let called = 0;
  const operations = { ...f.operations };
  Object.defineProperty(operations, 'closeOwnedHandle', {
    get() {
      called++;
      throw new Error('PRIVATE');
    },
  });
  assert.throws(
    () => createSameDirectoryLease({ ownedRoot: f.root, operations }),
    /^Error: n09_same_directory_rejected$/
  );
  assert.equal(called, 0);
});

for (const stopFailure of ['throw', 'false'])
  for (const disposeFailure of ['throw', 'false'])
    test(`rejected attestation retains same handle after stop ${stopFailure} and dispose ${disposeFailure}`, async (t) => {
      const f = fixture(t);
      const captured = { pid: 888 };
      const live = new Set([captured]);
      const closed = [];
      let first = true;
      const bad = createSameDirectoryLease({
        ownedRoot: f.root,
        operations: {
          ...f.operations,
          startFreshOwnedCase() {
            return captured;
          },
          attestLifecycleIdentity() {
            throw new Error('PRIVATE attestation');
          },
          stopOwnedCase(handle) {
            assert.equal(handle, captured);
            if (stopFailure === 'throw') throw new Error('PRIVATE stop');
            return false;
          },
          closeOwnedHandle(handle) {
            assert.equal(handle, captured);
            closed.push(handle);
            if (first) {
              first = false;
              if (disposeFailure === 'throw') throw new Error('PRIVATE dispose');
              return false;
            }
            live.delete(handle);
            return true;
          },
        },
      });
      await assert.rejects(bad.startFreshBusinessHost(), /^Error: n09_same_directory_rejected$/);
      assert.equal(live.size, 1);
      await bad.close();
      assert.equal(live.size, 0);
      assert.deepEqual(closed, [captured, captured]);
      await bad.close();
      assert.equal(closed.length, 2);
    });

test('rejected attestation stays rejected after successful independent stop and disposal', async (t) => {
  const f = fixture(t);
  const events = [];
  const bad = createSameDirectoryLease({
    ownedRoot: f.root,
    operations: {
      ...f.operations,
      attestLifecycleIdentity() {
        events.push('attest');
        throw new Error('PRIVATE');
      },
      stopOwnedCase() {
        events.push('stop');
        return true;
      },
      closeOwnedHandle() {
        events.push('dispose');
        return true;
      },
    },
  });
  await assert.rejects(bad.startFreshBusinessHost(), /^Error: n09_same_directory_rejected$/);
  assert.deepEqual(events, ['attest', 'stop', 'dispose']);
  await bad.close();
  assert.deepEqual(events, ['attest', 'stop', 'dispose']);
});

test('close succeeds without handles and after successful disposal, including repeated close', async (t) => {
  const f = fixture(t);
  await f.lease.close();
  await f.lease.close();
  const disposed = [];
  const lease = createSameDirectoryLease({
    ownedRoot: f.root,
    operations: {
      ...f.operations,
      closeOwnedHandle(handle) {
        disposed.push(handle.pid);
        return true;
      },
    },
  });
  await lease.startFreshBusinessHost();
  await lease.close();
  await lease.close();
  assert.deepEqual(disposed, [10]);
});

for (const failure of ['false', 'throw'])
  test(`close ${failure} fails once and succeeds only after retry disposes retained handle`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    const lease = createSameDirectoryLease({
      ownedRoot: f.root,
      operations: {
        ...f.operations,
        closeOwnedHandle() {
          calls++;
          if (calls === 1) {
            if (failure === 'throw') throw new Error('PRIVATE');
            return false;
          }
          return true;
        },
      },
    });
    await lease.startFreshBusinessHost();
    await assert.rejects(lease.close(), /^Error: n09_same_directory_rejected$/);
    assert.equal(calls, 1);
    await lease.close();
    assert.equal(calls, 2);
    await lease.close();
    assert.equal(calls, 2);
  });
