'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Entire network and subprocess surface is synthetic; no listener or child.
function fixture(failure) {
  const ca = Buffer.from('synthetic-ca');
  const options = {
    ownedNode: path.resolve('synthetic-node.exe'),
    networkRoot: path.resolve('synthetic-network'),
    caSha256: crypto.createHash('sha256').update(ca).digest('hex'),
    leafSha256: 'a'.repeat(64),
    negativeAddress: '10.1.2.3',
    negativePort: 43210,
  };
  let connections = 0;
  let inspections = 0;
  const modules = {
    'node:fs': {
      realpathSync: { native: (value) => value },
      readFileSync: () => (failure === 'ca' ? Buffer.from('wrong-ca') : ca),
    },
    'node:path': path,
    'node:crypto': crypto,
    'node:dns': {
      promises: {
        lookup: async () => [{ family: 4, address: failure === 'dns' ? '192.0.2.1' : '127.0.0.1' }],
      },
    },
    'node:net': {
      isIPv4: net.isIPv4,
      connect: () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        queueMicrotask(() =>
          failure === 'egress'
            ? socket.emit('connect')
            : socket.emit('error', { code: failure === 'socket-error' ? 'ECONNREFUSED' : 'EACCES' })
        );
        return socket;
      },
    },
    'node:https': {
      request: (requestOptions, receive) => {
        assert.equal(requestOptions.rejectUnauthorized, true);
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () =>
          queueMicrotask(() => {
            const response = new EventEmitter();
            response.destroy = () => {};
            response.statusCode = 200;
            response.socket = {
              remoteAddress: '127.0.0.1',
              authorized: failure !== 'tls',
              getPeerCertificate: () => ({ fingerprint256: options.leafSha256 }),
            };
            receive(response);
            response.emit('data', Buffer.from('N08_SYNTHETIC_TLS_OK'));
            response.emit('end');
          });
        return request;
      },
    },
    'node:child_process': {
      execFile: (_file, _args, settings, done) => {
        assert.equal(settings.timeout, 2000);
        connections += failure === 'baseline-count' ? 2 : 1;
        queueMicrotask(() =>
          done(failure === 'baseline' ? Error('PRIVATE_PROBE_SENTINEL') : null, '1', '')
        );
      },
    },
    './boundary.js': require('../../scripts/context-hosted/shared/boundary.js'),
    './hosted-listener.js': {
      checkHostedListener: () => ({
        pid: 1,
        negativeAddress: options.negativeAddress,
        negativePort: options.negativePort,
        negativeConnections: ++inspections === 3 && failure === 'final-count' ? 2 : connections,
      }),
    },
  };
  const sandbox = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name));
      return modules[name];
    },
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    process: {
      pid: 1,
      platform: 'win32',
      execPath: options.ownedNode,
      env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.resolve(__dirname, '../../scripts/context-hosted/shared/hosted-probes.js'),
      'utf8'
    ),
    sandbox
  );
  return { options, ...sandbox.module.exports };
}

test('shared network probes disclose only fixed stages while retaining TLS and egress assertions', async () => {
  const f = fixture();
  const phases = [];
  const proof = await f.runHostedProbes(f.options, {}, (phase) => phases.push(phase));
  assert.deepEqual(phases, [86, 87, 88, 89, 90, 91, 92, 93, 94]);
  assert.equal(proof.tlsVerified, true);
  assert.equal(proof.nonLoopbackBlocked, true);
  assert.equal(f.isVerifiedNetworkProof(proof), true);
});

test('each network phase rejection is sanitized and cannot produce a verified proof', async () => {
  for (let rejected = 86; rejected <= 94; rejected++) {
    const f = fixture();
    let last;
    await assert.rejects(
      f.runHostedProbes(f.options, {}, (phase) => {
        last = phase;
        if (phase === rejected) throw Error('PRIVATE_PROBE_SENTINEL');
      }),
      /^Error: n08_hosted_probe_rejected$/
    );
    assert.equal(last, rejected);
    assert.equal(f.isVerifiedNetworkProof({}), false);
  }
});

test('real probe assertion failures retain their fixed phase without exposing source errors', async () => {
  for (const [failure, expected] of [
    ['ca', 88],
    ['dns', 89],
    ['tls', 90],
    ['baseline', 91],
    ['baseline-count', 92],
    ['egress', 95],
    ['socket-error', 96],
    ['final-count', 94],
  ]) {
    const f = fixture(failure);
    const phases = [];
    await assert.rejects(
      f.runHostedProbes(f.options, {}, (phase) => phases.push(phase)),
      /^Error: n08_hosted_probe_rejected$/
    );
    assert.equal(phases.at(-1), expected);
  }
});

test('invalid probe observers fail closed before network or subprocess work', async () => {
  for (const observer of [null, {}, [], 0, 'PRIVATE_PROBE_SENTINEL']) {
    const f = fixture();
    await assert.rejects(
      f.runHostedProbes(f.options, {}, observer),
      /^Error: n08_hosted_probe_rejected$/
    );
  }
});
