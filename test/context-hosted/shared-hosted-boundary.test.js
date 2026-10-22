'use strict';

// Pure/fake-I/O tests only. No sockets, TLS listeners or machine changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createBusinessClient } = require('../../scripts/context-hosted/shared/business-client.js');
const {
  runHostedProbes,
  isVerifiedNetworkProof,
} = require('../../scripts/context-hosted/shared/hosted-probes.js');
const { createOwnedN08Adapter } = require('../../scripts/context-hosted/shared/owned-adapter.js');
const {
  buildHostedController,
} = require('../../scripts/context-hosted/shared/build-hosted-controller.js');
const templates = () => ({
  compact: Buffer.from('{"input":[]}'),
  continuation: Buffer.from('{"input":[]}'),
  ordinary: Buffer.from('{"input":"N08_ORDINARY_REQUEST"}'),
});
function fixture(mode = 'ok') {
  const calls = [];
  const request = (options, callback) => {
    if (mode === 'throw') throw new Error('PRIVATE_MARKER');
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {
      outgoing.destroyed = true;
    };
    outgoing.end = (body) => {
      calls.push({ options, body });
      queueMicrotask(() => {
        const incoming = new EventEmitter();
        incoming.statusCode = mode === 'redirect' ? 302 : 200;
        callback(incoming);
        if (mode === 'error') incoming.emit('error', new Error('PRIVATE_MARKER'));
        else {
          incoming.emit('data', Buffer.alloc(mode === 'large' ? 262145 : 2, 32));
          incoming.emit('end');
        }
      });
    };
    return outgoing;
  };
  return { calls, request };
}
test('business client uses only the owner entry port and fixed route/templates', async () => {
  const f = fixture();
  const client = createBusinessClient(
    { entryPort: 18081, entryKey: 'a'.repeat(32), templates: templates() },
    f.request
  );
  const result = await client('compact');
  assert.equal(result.status, 200);
  assert.equal(result.bytes.length, 2);
  assert.equal(f.calls[0].options.host, '127.0.0.1');
  assert.equal(f.calls[0].options.port, 18081);
  assert.equal(f.calls[0].options.path, '/v1/responses/compact');
  assert.equal(f.calls[0].options.agent, false);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer ' + 'a'.repeat(32));
  await assert.rejects(client('https://outside.invalid'), /n08_business_request_rejected/);
  assert.equal(f.calls.length, 1);
});
test('business client rejects malformed and oversized templates before dispatch', () => {
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from([255]),
    Buffer.from('{bad'),
    Buffer.alloc(262145),
  ]) {
    const f = fixture();
    const bodies = templates();
    bodies.ordinary = bad;
    assert.throws(
      () =>
        createBusinessClient(
          { entryPort: 18081, entryKey: 'a'.repeat(32), templates: bodies },
          f.request
        ),
      /n08_business_request_rejected/
    );
    assert.equal(f.calls.length, 0);
  }
});
for (const mode of ['throw', 'error', 'redirect', 'large'])
  test('business client sanitizes failure without redirects: ' + mode, async () => {
    const f = fixture(mode);
    const client = createBusinessClient(
      { entryPort: 18081, entryKey: 'a'.repeat(32), templates: templates() },
      f.request
    );
    await assert.rejects(client('ordinary'), /^Error: n08_business_request_rejected$/);
    assert.ok(f.calls.length <= 1);
  });
test('arbitrary true booleans cannot become a verified network capability', () => {
  const forged = {
    probesPassed: true,
    tlsVerified: true,
    nonLoopbackBlocked: true,
    listenerOwned: true,
  };
  assert.equal(isVerifiedNetworkProof(forged), false);
  let launched = false;
  assert.throws(
    () =>
      createOwnedN08Adapter({
        manifestSha256: 'a'.repeat(64),
        createSession: () => {
          launched = true;
        },
        scenario: {},
        networkProof: forged,
      }),
    /n08_owned_adapter_rejected/
  );
  assert.equal(launched, false);
});
test('a forged listener lease rejects before any DNS/TLS/egress probe', async () => {
  await assert.rejects(
    runHostedProbes(
      {
        ownedNode: process.execPath,
        networkRoot: path.resolve(os.tmpdir()),
        caSha256: 'a'.repeat(64),
        leafSha256: 'b'.repeat(64),
        negativeAddress: '10.0.0.1',
        negativePort: 18082,
      },
      {}
    ),
    /n08_hosted_probe_rejected/
  );
});
test('controller generation rejects invalid boundary data without reading candidate source', () => {
  for (const value of [null, [], {}, { candidate: 'relative' }])
    assert.throws(() => buildHostedController(value), /n08_hosted_controller_rejected/);
});
