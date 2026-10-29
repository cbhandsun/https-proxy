'use strict';
// Pure EventEmitter transport regressions. Never launches PowerShell or daemon.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  startLifecycleChannel,
} = require('../../scripts/context-hosted/n09-ipc/lifecycle-channel.js');
function fixture() {
  const root = path.resolve('owned-pure');
  const options = {
    ownedRoot: root,
    install: path.join(root, 'install'),
    manifestSha256: 'a'.repeat(64),
  };
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let ended = false;
  let request;
  child.stdin.end = () => {
    if (!ended) {
      ended = true;
      queueMicrotask(() => child.emit('close', 0, null));
    }
  };
  child.stdin.write = (text, callback) => {
    request = JSON.parse(text);
    callback?.();
    return true;
  };
  child.kill = () => true;
  const channel = startLifecycleChannel(options, 'd'.repeat(64), () => child);
  return {
    channel,
    child,
    get request() {
      return request;
    },
  };
}
for (const wire of [
  '{"v":1,"v":1,"id":1,"op":"status","ok":true,"status":{"alive":true,"credentialsPrivate":true,"preloadPhase":"passed"}}\n',
  '{"v":1,"id":2,"op":"status","ok":true,"status":{"alive":true,"credentialsPrivate":true,"preloadPhase":"passed"}}\n',
  '{"v":1,"id":1,"op":"status","ok":true,"status":{"alive":true,"credentialsPrivate":true,"preloadPhase":"passed"},"PRIVATE":1}\n',
  '{}\n{}\n',
  'x'.repeat(16385),
])
  test('malformed/duplicate/mismatched/oversize response drains and closes without native text', async () => {
    const f = fixture();
    const result = f.channel.exchange({ op: 'status', leaseId: 'b'.repeat(32) });
    f.child.stdout.emit('data', Buffer.from(wire));
    await assert.rejects(result, /^Error: n09_lifecycle_transport_failed$/);
    await assert.rejects(f.channel.close(), /^Error: n09_lifecycle_transport_failed$/);
  });
test('valid fragmented response and orderly EOF close are supported', async () => {
  const f = fixture();
  const result = f.channel.exchange({ op: 'status', leaseId: 'b'.repeat(32) });
  f.child.stdout.emit('data', Buffer.from('{"v":1,"id":1,"op":"status",'));
  f.child.stdout.emit(
    'data',
    Buffer.from(
      '"ok":true,"status":{"alive":true,"credentialsPrivate":true,"preloadPhase":"passed"}}\n'
    )
  );
  assert.equal((await result).status.preloadPhase, 'passed');
  assert.equal(await f.channel.close(), true);
});
test('non-UTF8 bytes reject without native exception exposure', async () => {
  const f = fixture();
  const result = f.channel.exchange({ op: 'status', leaseId: 'b'.repeat(32) });
  f.child.stdout.emit('data', Buffer.from([255, 10]));
  await assert.rejects(result, /^Error: n09_lifecycle_transport_failed$/);
  await assert.rejects(f.channel.close(), /^Error: n09_lifecycle_transport_failed$/);
});
test('stderr, unsolicited output and child error abort pending request and clean exit', async () => {
  for (const surface of ['stderr', 'stdout', 'child']) {
    const f = fixture();
    const result = f.channel.exchange({ op: 'status', leaseId: 'b'.repeat(32) });
    if (surface === 'child') f.child.emit('error', new Error('PRIVATE-native-error'));
    else f.child[surface].emit('data', Buffer.from(surface === 'stdout' ? 'PRIVATE\n' : 'PRIVATE'));
    await assert.rejects(result, /^Error: n09_lifecycle_transport_failed$/);
    await assert.rejects(f.channel.close(), /^Error: n09_lifecycle_transport_failed$/);
  }
});
test('request getter/Proxy/function Proxy boundaries never execute traps', async () => {
  const f = fixture();
  let trapped = 0;
  const input = {};
  Object.defineProperty(input, 'op', {
    get() {
      trapped++;
      throw new Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        trapped++;
        throw new Error('PRIVATE');
      },
    }
  );
  await assert.rejects(f.channel.exchange(input), /^Error: n09_lifecycle_transport_failed$/);
  await assert.rejects(f.channel.exchange(proxy), /^Error: n09_lifecycle_transport_failed$/);
  assert.equal(trapped, 0);
  await f.channel.close();
});
test('request schema has no program/path/token/port selectors', async () => {
  const f = fixture();
  for (const selector of ['program', 'path', 'token', 'port'])
    await assert.rejects(
      f.channel.exchange({ op: 'start', [selector]: 'PRIVATE' }),
      /^Error: n09_lifecycle_transport_failed$/
    );
  await f.channel.close();
});
