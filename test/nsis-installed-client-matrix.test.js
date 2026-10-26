'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runInstalledClientMatrix,
  createBusinessHandler,
} = require('../scripts/lib/nsis-installed-client-matrix');
const {
  parseInstalledClientMatrixArguments,
  createMatrixPhaseWriter,
} = require('../scripts/lib/nsis-installed-client-matrix-contract');
function fixture(t, broken) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-matrix-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = [
    root,
    path.join(root, 'payload'),
    'a'.repeat(64),
    path.join(root, 'n08-hosted-network'),
    ...['b', 'c', 'd', 'e'].map((v) => v.repeat(64)),
  ];
  const calls = [],
    phases = [];
  let handle, token, options;
  const dependencies = {
    verify: () => ({
      candidate: root,
      powershellExecutable: path.join(root, 'pwsh.exe'),
      node: path.join(root, 'payload/runtime/node/node.exe'),
    }),
    phaseWriter: () => (phase, failed) => {
      phases.push({ phase, failed });
    },
    address: () => '10.0.0.1',
    listener: async (input) => {
      handle = input;
      return {
        inspect: () => ({ negativePort: 10245 }),
        close: async () => {
          calls.push('listener-close');
          return broken !== 'listener-close';
        },
      };
    },
    probes: async () => {
      if (broken === 'probes') throw Error('private');
      return {
        probesPassed: true,
        tlsVerified: true,
        nonLoopbackBlocked: true,
        listenerOwned: true,
      };
    },
    controller: () => ({
      close: async () => {
        calls.push('channel-close');
        return true;
      },
    }),
    adapter: (_input, _channel, getToken) => ({
      launch: async (request) => {
        calls.push(request.label);
        token = getToken();
        return {
          stopNaturally: async () => {
            calls.push('natural-stop');
            if (broken === 'stop') throw Error('PRIVATE_NATURAL_EXIT_FAILED');
            return {
              treeEmpty: broken !== 'natural-tree',
              cleanupSemantics: broken === 'natural-forced' ? 'forced_cleanup' : 'natural_exit',
              exitCode: broken === 'natural-nonzero' ? 1 : 0,
              ...(broken === 'natural-extra' ? { detail: 'PRIVATE_DETAIL' } : {}),
            };
          },
          stop: async () => {
            calls.push('forced-stop');
            return true;
          },
        };
      },
      verifyOwnedIdentity: () => true,
      close: async () => {
        calls.push('adapter-close');
        return broken !== 'adapter-close';
      },
    }),
    verifyBinary: () => broken !== 'binary',
    drain: async (options, { owner }) => {
      assert.equal(options.model, 'hpm-installed-' + options.client);
      const receipt = await owner.stopNaturally();
      return {
        ...receipt,
        httpTransportDrainQualified: broken !== 'drain-false',
        sseTransportDrainQualified: broken !== 'sse-false',
      };
    },
    runCase: async (input) => {
      options = input;
      assert.equal(input.token, token);
      assert.match(token, /^[A-Za-z0-9_-]{32}$/);
      input.onPhase(input.client + '-' + input.mode + '-cli');
      if (broken === 'case') throw Error('private');
      let observed = false,
        delivered = false;
      input.active.current = {
        client: input.client,
        mode: input.mode,
        upstreamToken: 'synthetic-upstream',
        observe: async () => {
          observed = true;
        },
        upstream: {
          respond() {
            assert.equal(observed, input.mode === 'default');
            return {
              statusCode: 200,
              contentType: 'text/event-stream; charset=utf-8',
              wire: Buffer.from('synthetic'),
            };
          },
        },
      };
      await handle.onBusinessRequest({
        path: input.client === 'codex' ? '/v1/responses' : '/v1/messages',
        authorization: input.client === 'codex' ? 'Bearer synthetic-upstream' : undefined,
        apiKey: input.client === 'claude' ? 'synthetic-upstream' : undefined,
        bytes: Buffer.from('{}'),
        response: {
          destroyed: false,
          writeHead() {},
          end() {
            delivered = true;
          },
          destroy() {},
        },
      });
      assert.equal(delivered, true);
      const drain = () =>
        input.onReadyToStop(
          { client: input.client, mode: input.mode, model: 'hpm-installed-' + input.client },
          async () => {}
        );
      if (broken !== 'drain-missing') await drain();
      if (broken === 'drain-duplicate') await drain();
      input.active.current = null;
      return {
        client: input.client,
        mode: input.mode,
        compactions: 3,
        exactFinalAnswer: true,
        defaultZeroRecovery: input.mode === 'default',
        privateRead: input.mode === 'enhanced',
        publicGeneration: input.mode === 'enhanced',
        restartRetention: true,
      };
    },
  };
  return { args, dependencies, calls, phases, getOptions: () => options };
}

test('matrix composes four fresh daemon cases, real token factory and observed default upstream requests', async (t) => {
  const f = fixture(t);
  const receipt = await runInstalledClientMatrix(f.args, f.dependencies);
  assert.equal(receipt.schemaVersion, 6);
  assert.equal(receipt.daemonNaturalExitQualified, true);
  assert.equal(receipt.httpTransportDrainQualified, true);
  assert.equal(receipt.sseTransportDrainQualified, true);
  assert.equal(receipt.websocketDrainQualified, false);
  assert.equal(receipt.syntheticClientQualified, true);
  assert.equal(receipt.realProviderQualified, false);
  assert.equal(receipt.retention24hQualified, false);
  assert.equal(receipt.realModelRequests, 0);
  assert.deepEqual(
    receipt.cases.map((item) => [item.client, item.mode]),
    [
      ['codex', 'default'],
      ['codex', 'enhanced'],
      ['claude', 'default'],
      ['claude', 'enhanced'],
    ]
  );
  assert.deepEqual(f.calls, [
    '00',
    'natural-stop',
    '01',
    'natural-stop',
    '10',
    'natural-stop',
    '11',
    'natural-stop',
    'adapter-close',
    'listener-close',
  ]);
  assert.deepEqual(f.phases.at(-1), { phase: 'complete', failed: false });
});

test('matrix cannot start the next client case before independent natural-exit acknowledgement', async (t) => {
  const f = fixture(t);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const original = f.dependencies.adapter;
  f.dependencies.adapter = (...args) => {
    const adapter = original(...args);
    const launch = adapter.launch;
    adapter.launch = async (input) => {
      const owner = await launch(input);
      const stop = owner.stopNaturally;
      owner.stopNaturally = async () => {
        if (input.label === '00') await pending;
        return stop();
      };
      return owner;
    };
    return adapter;
  };
  const running = runInstalledClientMatrix(f.args, f.dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ['00']);
  assert.deepEqual(f.phases.at(-1), { phase: 'codex-default-stop', failed: false });
  release();
  assert.equal((await running).daemonNaturalExitQualified, true);
  assert.equal(f.calls.filter((call) => call === 'natural-stop').length, 4);
});
for (const mode of [
  'probes',
  'binary',
  'case',
  'stop',
  'adapter-close',
  'listener-close',
  'natural-tree',
  'natural-forced',
  'natural-nonzero',
  'natural-extra',
  'drain-false',
  'sse-false',
  'drain-missing',
  'drain-duplicate',
])
  test('matrix rejects ' + mode + ' while attempting all available cleanup', async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(runInstalledClientMatrix(f.args, f.dependencies), {
      message: 'installed_client_matrix_failed',
    });
    assert.ok(f.calls.includes('listener-close'));
    if (mode !== 'probes') assert.ok(f.calls.includes('adapter-close'));
    assert.equal(f.phases.at(-1).failed, true);
    if (mode === 'case') assert.equal(f.phases.at(-1).phase, 'codex-default-cli');
    if (mode === 'case') {
      assert.ok(f.calls.includes('forced-stop'));
      assert.equal(f.calls.includes('natural-stop'), false);
    }
    if (mode === 'stop' || mode.startsWith('natural-')) {
      assert.equal(f.calls.filter((call) => call === 'natural-stop').length, 1);
      assert.equal(f.calls.includes('01'), false);
      assert.equal(f.phases.at(-1).phase, 'codex-default-stop');
    }
  });

test('business authentication, malformed input and observer failure never produce wire', async () => {
  for (const mode of ['auth', 'json', 'observe']) {
    let rejected = false,
      delivered = false,
      destroyed = false;
    const active = {
      current: {
        client: 'claude',
        mode: 'default',
        upstreamToken: 'synthetic',
        observe: async () => {
          if (mode === 'observe') throw Error('private');
        },
        upstream: {
          respond() {
            assert.fail('must not dispatch');
          },
        },
      },
    };
    const handler = createBusinessHandler(active, () => {
      rejected = true;
    });
    await handler.respond({
      path: '/v1/messages',
      apiKey: mode === 'auth' ? 'wrong' : 'synthetic',
      bytes: Buffer.from(mode === 'json' ? '{' : '{}'),
      response: {
        end() {
          delivered = true;
        },
        destroy() {
          destroyed = true;
        },
      },
    });
    assert.equal(rejected, true);
    assert.equal(delivered, false);
    assert.equal(destroyed, true);
    assert.equal(handler.inspect().pending, 0);
  }
});

test('held synthetic replies require a native true acknowledgement and unchanged case ownership', async () => {
  let traps = 0;
  const hostile = Object.defineProperty({}, 'then', {
    get() {
      traps++;
      throw Error('PRIVATE_THEN');
    },
  });
  for (const beforeReply of [
    () => false,
    () => null,
    () => undefined,
    () => hostile,
    new Proxy(() => {
      traps++;
    }, {}),
  ]) {
    let rejected = 0,
      delivered = 0;
    const active = {
      current: {
        client: 'codex',
        mode: 'enhanced',
        upstreamToken: 'synthetic',
        beforeReply,
        upstream: {
          respond: () => ({
            statusCode: 200,
            wire: Buffer.from('synthetic'),
            contentType: 'application/json; charset=utf-8',
          }),
        },
      },
    };
    const handler = createBusinessHandler(active, () => {
      rejected++;
    });
    await handler.respond({
      path: '/v1/responses',
      authorization: 'Bearer synthetic',
      bytes: Buffer.from('{}'),
      response: {
        destroyed: false,
        destroy() {},
        writeHead() {
          delivered++;
        },
        end() {
          delivered++;
        },
      },
    });
    assert.equal(rejected, 1);
    assert.equal(delivered, 0);
    assert.equal(handler.inspect().pending, 0);
  }
  assert.equal(traps, 0);
  let delivered = false,
    rejected = false;
  const active = {
    current: {
      client: 'codex',
      mode: 'enhanced',
      upstreamToken: 'synthetic',
      beforeReply: async () => {
        active.current = null;
        return true;
      },
      upstream: {
        respond: () => ({
          statusCode: 200,
          wire: Buffer.from('synthetic'),
          contentType: 'application/json; charset=utf-8',
        }),
      },
    },
  };
  const handler = createBusinessHandler(active, () => {
    rejected = true;
  });
  await handler.respond({
    path: '/v1/responses',
    authorization: 'Bearer synthetic',
    bytes: Buffer.from('{}'),
    response: {
      destroyed: false,
      destroy() {},
      writeHead() {
        delivered = true;
      },
      end() {
        delivered = true;
      },
    },
  });
  assert.equal(rejected, true);
  assert.equal(delivered, false);
});

test('argument and phase boundaries reject malformed input and disclose only finite safe phases', (t) => {
  const f = fixture(t);
  assert.equal(parseInstalledClientMatrixArguments(f.args).ownedRoot, f.args[0]);
  for (const args of [
    [],
    [...f.args, 'extra'],
    f.args.map((v, i) => (i === 7 ? 'bad' : v)),
    f.args.map((v, i) => (i === 1 ? path.join(f.args[0], 'other') : v)),
  ])
    assert.throws(() => parseInstalledClientMatrixArguments(args));
  const writer = createMatrixPhaseWriter(f.args[0]);
  writer('identity');
  writer('claude-enhanced-http-drain-public_response', true);
  writer('claude-default-cli-seed', true);
  writer('claude-enhanced-cli-compact-3', true);
  writer('claude-enhanced-cli-between-2', true);
  writer('codex-enhanced-cli-final', true);
  writer('claude-enhanced-cli', true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.args[0], 'matrix-phase.json'))), {
    schemaVersion: 1,
    phase: 'claude-enhanced-cli',
    failed: true,
  });
  assert.throws(() => writer('private-input'));
});
