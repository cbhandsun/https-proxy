'use strict';
// Pure driver/observer fixtures. No process, product or network execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createN08PhaseObserver } = require('../../scripts/context-hosted/n08/phase-observer.js');
const { runN08Driver } = require('../../scripts/context-hosted/n08/observed-driver.js');
const { ack } = require('../../scripts/context-hosted/n08/observed-boundary.js');

function fixture() {
  let next = 0;
  const cases = new Map(),
    events = [];
  const receipt = (owner, stage) => {
    const value = cases.get(owner.nonce);
    return ack(owner, value.barrier, value.mutation, stage);
  };
  const wire = (status, body) => ({ status, bytes: Buffer.from(JSON.stringify(body)) });
  const snapshot = () => ({
    rootId: 'hbs_' + 'a'.repeat(32),
    expiresAt: 10000,
    readerCalls: 1,
    readerBytes: 100,
  });
  const adapter = {
    startCase(value) {
      const owner = {
        pid: ++next,
        nonce: next.toString(16).padStart(32, '0'),
        manifestSha256: 'a'.repeat(64),
      };
      cases.set(owner.nonce, value);
      return owner;
    },
    beginRecovery: (owner) => receipt(owner, 'recovery-started'),
    waitUpstreamHold: (owner) => receipt(owner, 'upstream-response-held'),
    applyMutation: (owner) => receipt(owner, 'mutation-applied'),
    probeAdmissions: () => ({
      enhanced: wire(503, { error: { code: 'context_recovery_unavailable' } }),
      ordinary: wire(200, {
        id: 'n08-ordinary-default',
        object: 'response',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'N08_ORDINARY_DEFAULT_OK' }] },
        ],
      }),
      enhancedPrivateDispatchDelta: 0,
      oldRootPrivateRequestDelta: 0,
      enhancedDefaultDispatchDelta: 0,
      ordinaryDefaultDispatchDelta: 1,
    }),
    releaseUpstreamHold: (owner) => receipt(owner, 'response-released'),
    observeWithdrawal: (owner) => ({
      response: wire(502, { error: { code: 'context_recovery_failed' } }),
      ownerStatus: { ...owner, alive: true },
      externalToolReplays: 0,
      oldRootPrivateRequestDelta: 0,
      inFlightDefaultDispatchDelta: 0,
      before: snapshot(),
      after: snapshot(),
    }),
    stop(owner) {
      events.push('stop');
      return receipt(owner, 'tree-empty');
    },
    closeSession(session) {
      events.push('close-' + session);
      return true;
    },
  };
  return { adapter, events };
}

test('N08 observer accepts only fixed phase codes and discloses no supplied failure details', () => {
  const phases = [],
    observe = createN08PhaseObserver((value) => phases.push(value));
  for (const value of [71, 86, 96, ...Array.from({ length: 61 }, (_, i) => i + 140)])
    observe(value);
  for (const value of [
    undefined,
    null,
    {},
    [],
    '140',
    NaN,
    Infinity,
    -1,
    72,
    85,
    97,
    130,
    139,
    201,
    Number.MAX_SAFE_INTEGER,
  ])
    assert.throws(() => observe(value), /^Error: n08_phase_observer_rejected$/);
  assert.equal(phases.length, 64);
  assert.throws(
    () =>
      createN08PhaseObserver(() => {
        throw new Error('PRIVATE_SENTINEL');
      })(140),
    /^Error: n08_phase_observer_rejected$/
  );
  let traps = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      traps++;
      throw new Error('PRIVATE_SENTINEL');
    },
  });
  for (const value of [null, {}, [], 1, proxy, async () => {}, function* () {}])
    assert.throws(() => createN08PhaseObserver(value), /^Error: n08_phase_observer_rejected$/);
  assert.equal(traps, 0);
});

test('N08 driver reports business stages in order for all six original cases', async () => {
  const f = fixture(),
    phases = [];
  const result = await runN08Driver(f.adapter, (value) => phases.push(value));
  assert.equal(result.cases.length, 6);
  assert.deepEqual(phases, [
    ...Array(3).fill([153, 154, 155, 156, 157, 158, 159]).flat(),
    160,
    ...Array(3).fill([153, 154, 155, 156, 157, 158, 159]).flat(),
    160,
  ]);
  assert.equal(f.events.filter((value) => value === 'stop').length, 6);
  assert.deepEqual(
    f.events.filter((value) => value.startsWith('close')),
    ['close-0', 'close-1']
  );
});

test('N08 observer failure at every business or cleanup stage preserves stop and independent session cleanup', async () => {
  for (let failedPhase = 153; failedPhase <= 160; failedPhase++) {
    const f = fixture();
    await assert.rejects(
      runN08Driver(f.adapter, (phase) => {
        if (phase === failedPhase) throw new Error('PRIVATE_SENTINEL');
      }),
      /^Error: n08_driver_rejected$/
    );
    assert.ok(f.events.includes('stop'));
    assert.equal(f.events.at(-1), 'close-0');
  }
});

test('N08 failures retain their business phase while both cleanup operations still execute', async () => {
  const f = fixture(),
    phases = [];
  f.adapter.probeAdmissions = () => {
    throw new Error('PRIVATE_SENTINEL');
  };
  await assert.rejects(
    runN08Driver(f.adapter, (value) => phases.push(value)),
    /^Error: n08_driver_rejected$/
  );
  assert.equal(phases.at(-1), 156);
  assert.deepEqual(f.events, ['stop', 'close-0']);
});

function scenarioFixture(observer, secondStatus = 200, initialConfig) {
  const filename = path.resolve(__dirname, '../../scripts/context-hosted/n08/business-scenario.js');
  const localRequire = createRequire(filename),
    loaded = { exports: {} };
  const nonce = 'a'.repeat(32),
    requests = [];
  let sends = 0,
    config = initialConfig
      ? { ...globalThis.structuredClone(initialConfig), _revision: 'r1' }
      : { _revision: 'r1', appSettings: {} };
  const reply = (output) => ({
    status: 200,
    bytes: Buffer.from(JSON.stringify({ object: 'response', status: 'completed', output })),
  });
  const text = (value) => ({ type: 'message', content: [{ type: 'output_text', text: value }] });
  const factory = vm.runInThisContext(
    `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  factory(
    (name) => {
      if (name === '../shared/business-client.js')
        return {
          createBusinessClient: () => async () => {
            sends++;
            if (sends === 1)
              return reply([
                {
                  type: 'function_call',
                  name: 'n08_original',
                  call_id: 'n08_original_' + nonce,
                  arguments: '{}',
                },
              ]);
            if (sends === 2) return { ...reply([text('synthetic-seeded')]), status: secondStatus };
            return reply([
              text(
                '<!-- hpm-codex-summary:hcr1_' + 'b'.repeat(48) + '_' + 'c'.repeat(64) + '_1 -->'
              ),
            ]);
          },
        };
      if (name === '../n09-snapshot/readonly-snapshot.js')
        return { createDurableSnapshotReader: () => ({}) };
      return localRequire(name);
    },
    loaded,
    loaded.exports
  );
  const value = {
    identity: { nonce },
    owner: {
      identity: { pid: 101, entryPort: 18081, runtimeDir: path.resolve('synthetic-runtime') },
      isAlive: async () => true,
      async request(input) {
        requests.push(input.method + ' ' + input.route);
        if (input.method === 'POST') {
          config = { ...input.body, _revision: 'r2' };
          return { status: 200, body: { ok: true, revision: 'r2' } };
        }
        if (input.route === '/v1/local/config') return { status: 200, body: config };
        return {
          status: 200,
          body: { pid: 101, contextRecovery: { appliedEnabled: true, storage: 'persistent' } },
        };
      },
    },
  };
  return {
    scenario: loaded.exports.createBusinessScenario(
      { ownedRoot: path.resolve('synthetic-owned') },
      observer
    ),
    value,
    requests,
  };
}

test('N08 management, seed and snapshot phases retain all original requests and checks', async () => {
  const phases = [],
    f = scenarioFixture((phase) => phases.push(phase));
  const result = await f.scenario.configureAndSeed(f.value);
  assert.deepEqual(phases, [145, 146, 147, 148, 149, 150, 151, 152]);
  assert.deepEqual(f.requests, [
    'GET /v1/local/config',
    'POST /v1/local/config',
    'GET /v1/local/config',
    'GET /v1/local/health',
  ]);
  assert.equal(result.state.externalToolExecutions, 1);
  assert.equal(result.state.phase, 'ready');
});

test('N08 synthetic save from product defaults satisfies the real configuration validator', async () => {
  const { DEFAULT_CONFIG } = require('../../lib/proxy/config');
  const { validateConfig } = require('../../lib/proxy/validator');
  const f = scenarioFixture(undefined, 200, DEFAULT_CONFIG);
  const request = f.value.owner.request;
  let checked = 0;
  f.value.owner.request = async (input) => {
    if (input.method === 'POST') {
      const result = validateConfig(input.body);
      assert.equal(result.valid, true, result.errors.join(','));
      checked++;
    }
    return request(input);
  };
  await f.scenario.configureAndSeed(f.value);
  assert.equal(checked, 1);
});

test('N08 config save distinguishes deadline, transport, HTTP and receipt failure before readback', async () => {
  for (const [kind, expected] of [
    ['deadline', 185],
    ['transport', 186],
    ['http', 170],
    ['body', 188],
  ]) {
    const phases = [];
    const f = scenarioFixture((phase) => phases.push(phase));
    const request = f.value.owner.request;
    f.value.owner.request = async (input) => {
      if (input.method !== 'POST') return request(input);
      if (kind === 'deadline')
        throw Object.assign(new Error('PRIVATE'), { code: 'HPM_DAEMON_HTTP_DEADLINE' });
      if (kind === 'transport') throw new Error('PRIVATE');
      if (kind === 'http') return { status: 503, body: { secret: 'PRIVATE' } };
      return { status: 200, body: { ok: false, secret: 'PRIVATE' } };
    };
    await assert.rejects(
      f.scenario.configureAndSeed(f.value),
      /^Error: n08_business_scenario_rejected$/
    );
    assert.deepEqual(phases, [145, 146, ...(kind === 'http' ? [187] : []), expected]);
  }
});

test('N08 observer failure at every seed stage prevents later phases and stays fixed', async () => {
  for (let failed = 145; failed <= 152; failed++) {
    const phases = [],
      f = scenarioFixture((phase) => {
        phases.push(phase);
        if (phase === failed) throw new Error('PRIVATE_SENTINEL');
      });
    await assert.rejects(
      f.scenario.configureAndSeed(f.value),
      /^Error: n08_phase_observer_rejected$/
    );
    assert.equal(phases.at(-1), failed);
  }
});

test('N08 HTTP 400 save reports only a fixed cause and never continues or repeats writes', async () => {
  for (const [body, expected] of [
    [{ error: 'Invalid configuration: PRIVATE_SENTINEL' }, 196],
    [{ error: 'secret_encryption_failed' }, 197],
    [{ error: 'secret_decryption_failed' }, 198],
    [{ error: 'PRIVATE_SENTINEL' }, 199],
    [null, 200],
  ]) {
    const phases = [],
      f = scenarioFixture((phase) => phases.push(phase));
    const request = f.value.owner.request;
    let writes = 0;
    f.value.owner.request = async (input) => {
      if (input.method !== 'POST') return request(input);
      writes++;
      return { status: 400, body };
    };
    await assert.rejects(
      f.scenario.configureAndSeed(f.value),
      /^Error: n08_business_scenario_rejected$/
    );
    assert.deepEqual(phases, [145, 146, 187, 162, expected]);
    assert.equal(writes, 1);
    assert.deepEqual(f.requests, ['GET /v1/local/config']);
  }
});

test('N08 rejected tool-result HTTP status emits only its fixed phase and stops before summary', async () => {
  for (const [status, expected] of [
    [400, 162],
    [401, 163],
    [403, 164],
    [409, 165],
    [413, 166],
    [429, 167],
    [500, 168],
    [502, 169],
    [503, 170],
    [504, 171],
    [418, 172],
  ]) {
    const phases = [];
    const f = scenarioFixture((phase) => phases.push(phase), status);
    await assert.rejects(
      f.scenario.configureAndSeed(f.value),
      /^Error: n08_business_scenario_rejected$/
    );
    assert.equal(phases.at(-1), expected);
    assert.equal(phases.includes(151), false);
  }
});
