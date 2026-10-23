'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Pure composition fixtures: never load a native worker, listener or controller.
function fixture(cleanupFails = false, listenerFails = false) {
  const root = path.resolve('synthetic-owned-root');
  let created = 0;
  let closed = 0;
  const listener = { inspect: () => ({}), close: async () => !listenerFails };
  const adapter = () => {
    const index = created++;
    return {
      onBusinessRequest() {},
      bindVerifiedNetworkProof() {},
      inspectBusinessEvidence: () => ({
        seeded: true,
        validatedReadCount: index === 2 ? 2 : 1,
        publicGenerationCount: index === 2 ? 2 : 1,
        externalToolExecutions: 1,
        clearAckCount: index === 1 ? 1 : 0,
        saveAckCount: index === 2 ? 1 : 0,
        revokeAckCount: index === 3 ? 1 : 0,
      }),
      close: async () => {
        closed++;
        if (cleanupFails) throw Error('PRIVATE_PHASE_SENTINEL');
      },
    };
  };
  const copy = () => ({ copyPins: {}, outputRoot: root });
  const modules = {
    'node:fs': { realpathSync: { native: (value) => value } },
    'node:path': path,
    'node:crypto': require('node:crypto'),
    '../shared/boundary.js': require('../../scripts/context-hosted/shared/boundary.js'),
    '../shared/hosted-listener.js': { createHostedListener: async () => listener },
    '../shared/hosted-probes.js': { runHostedProbes: async () => ({}) },
    '../shared/build-hosted-controller.js': {
      buildHostedController: copy,
      verifyPhysicalPath() {},
    },
    '../n09-business/business-adapter.js': { createN09BusinessAdapter: adapter },
    '../n09-snapshot/committed-observed-driver.js': {
      runCommittedObservedKill: async () => ({}),
    },
    '../n09-ipc/driver.js': {
      runClearAfterAck: async () => ({}),
      runDurableSaveOrRevokeAfterAck: async () => ({}),
    },
    './hosted-lifecycle.js': {
      buildHostedLifecycle: copy,
      createHostedLifecycleSpawn: () => () => {},
    },
    '../n09-ack/bootstrap-controller': { buildN09AckController: copy },
  };
  const load = (name) => {
    assert.ok(Object.hasOwn(modules, name), 'Unexpected dependency');
    return modules[name];
  };
  load.cache = {};
  const sandbox = {
    require: load,
    module: { exports: {} },
    process: {
      env: {},
      execArgv: [],
      execPath: path.join(root, 'payload/runtime/node/node.exe'),
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.resolve(__dirname, '../../scripts/context-hosted/n09/composition.js'),
      'utf8'
    ),
    sandbox
  );
  return {
    run: sandbox.module.exports.composeHostedN09,
    closed: () => closed,
    options: {
      candidate: root,
      ownedRoot: root,
      manifestSha256: 'a'.repeat(64),
      controllerPins: {},
      lifecyclePins: {},
      loadedPins: { [path.join(root, 'fixture.js')]: 'b'.repeat(64) },
      networkRoot: path.join(root, 'n08-hosted-network'),
      caSha256: 'c'.repeat(64),
      leafSha256: 'd'.repeat(64),
      negativeAddress: '10.1.2.3',
    },
  };
}

test('N09 composition reports fixed phases and retains all four business cases', async () => {
  const f = fixture();
  const phases = [];
  const result = await f.run(f.options, (phase) => phases.push(phase));
  assert.deepEqual(phases, [73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84]);
  assert.equal(result.cleanup.adaptersClosed, 4);
  assert.equal(result.cleanup.listenerClosed, true);
  assert.equal(result.n09Complete, false);
});

test('N09 phase failures retain their stage, sanitize errors and close acquired adapters', async () => {
  for (let rejected = 73; rejected <= 83; rejected++) {
    const f = fixture();
    let last;
    await assert.rejects(
      f.run(f.options, (phase) => {
        last = phase;
        if (phase === rejected) throw Error('PRIVATE_PHASE_SENTINEL');
      }),
      /^Error: n09_hosted_composition_rejected$/
    );
    assert.equal(last, rejected);
    assert.equal(f.closed(), rejected <= 74 ? 0 : rejected <= 81 ? 1 : rejected === 82 ? 2 : 3);
  }
});

test('N09 cleanup failures distinguish fixed resource classes and attempt every adapter', async () => {
  for (const [adapterFails, listenerFails, expected] of [
    [true, false, 98],
    [false, true, 99],
    [true, true, 100],
  ]) {
    const f = fixture(adapterFails, listenerFails);
    const phases = [];
    await assert.rejects(
      f.run(f.options, (phase) => phases.push(phase)),
      /^Error: n09_hosted_composition_rejected$/
    );
    assert.equal(phases.at(-1), expected);
    assert.equal(f.closed(), 4);
  }
});

test('N09 rejects invalid phase observers before acquiring resources', async () => {
  for (const observer of [null, {}, [], 0, 'PRIVATE_PHASE_SENTINEL']) {
    const f = fixture();
    await assert.rejects(f.run(f.options, observer), /^Error: n09_hosted_composition_rejected$/);
    assert.equal(f.closed(), 0);
  }
});
