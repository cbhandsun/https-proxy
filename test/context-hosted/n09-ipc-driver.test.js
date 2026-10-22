'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  runClearAfterAck,
  runDurableSaveOrRevokeAfterAck,
  accounting,
} = require('../../scripts/context-hosted/n09-ipc/driver.js');
function fixture(change = () => {}) {
  const events = [];
  const state = {
    originalSha256: 'a'.repeat(64),
    authorizationSha256: 'b'.repeat(64),
    rootId: 'hbs_' + 'c'.repeat(32),
    expiresAt: 123456789,
    calls: 3,
    returnedBytes: 100,
  };
  const host = (pid) => ({
    pid,
    manifestSha256: 'd'.repeat(64),
    configDir: path.resolve('owned/config'),
    runtimeDir: path.resolve('owned/runtime'),
    isolatedLoopbackSynthetic: true,
    actualBusinessHost: true,
  });
  function result(stage, value) {
    events.push(stage);
    return change(stage, value) ?? value;
  }
  const adapter = {
    startFreshBusinessHost() {
      return result('start', host(100));
    },
    seedThroughBusinessHttp() {
      return result('seed', { ...state });
    },
    readThroughBusinessHttp() {
      return result('read', {
        exactRead: true,
        accounting: { ...state, calls: 4, returnedBytes: 105 },
      });
    },
    getClearCapability() {
      return () =>
        result('clear', { kind: 'host-clear-completed', durableBoundary: 'await-clearAsync' });
    },
    killOwnedJob(owner) {
      return result('kill-' + owner.pid, {
        pid: owner.pid,
        treeEmpty: true,
        shutdownInvoked: false,
        semantics: 'forced_cleanup',
      });
    },
    restartSameBusinessHost() {
      return result('restart', host(101));
    },
    readOldReceiptThroughBusinessHttp() {
      return result('denied', {
        oldReceiptDenied: true,
        originalExposed: false,
        externalToolReplays: 0,
      });
    },
    setCombinationThroughManagement(_owner, combination) {
      events.push('toggle-' + combination);
    },
    close() {
      result('close', true);
    },
  };
  return { adapter, events, state };
}
test('clear ACK precedes forced kill and same-directory restart, then four toggles stay denied', async () => {
  const f = fixture();
  const result = await runClearAfterAck(f.adapter);
  assert.equal(result.n09Complete, false);
  assert.equal(result.saveAckKillQualified, false);
  assert.equal(result.evidenceLevel, 'adapter-orchestration-only');
  assert.equal(result.liveDaemonProved, false);
  assert.equal(result.hostClearBoundaryObserved, false);
  assert.deepEqual(f.events, [
    'start',
    'seed',
    'read',
    'clear',
    'kill-100',
    'restart',
    'denied',
    'toggle-00',
    'denied',
    'toggle-01',
    'denied',
    'toggle-10',
    'denied',
    'toggle-11',
    'denied',
    'kill-101',
    'close',
  ]);
});
for (const input of [null, undefined, [], {}, '', 1])
  test(`empty/invalid adapter ${String(input)}`, async () => {
    await assert.rejects(runClearAfterAck(input), /^Error: n09_ack_kill_failed$/);
  });
for (const [stage, field, value] of [
  ['seed', 'originalSha256', ''],
  ['seed', 'authorizationSha256', 'x'.repeat(65)],
  ['seed', 'rootId', 'hbs_' + 'a'.repeat(33)],
  ['seed', 'expiresAt', 0],
  ['seed', 'calls', Number.MAX_SAFE_INTEGER + 1],
  ['seed', 'returnedBytes', -1],
  ['start', 'configDir', 'relative'],
  ['start', 'runtimeDir', 'x'.repeat(4097)],
  ['start', 'configDir', path.resolve('owned') + '/../../escape'],
  ['restart', 'pid', 100],
  ['restart', 'manifestSha256', 'e'.repeat(64)],
  ['restart', 'configDir', path.resolve('other/config')],
  ['restart', 'runtimeDir', path.resolve('other/runtime')],
  ['read', 'exactRead', false],
  ['clear', 'kind', 'running'],
  ['clear', 'durableBoundary', 'http-finish'],
  ['kill-100', 'treeEmpty', false],
  ['kill-100', 'shutdownInvoked', true],
  ['kill-100', 'pid', 999],
  ['kill-100', 'semantics', 'graceful'],
  ['denied', 'oldReceiptDenied', false],
  ['denied', 'originalExposed', true],
  ['denied', 'externalToolReplays', 1],
])
  test(`rejects ${stage}.${field} invalid boundary`, async () => {
    const f = fixture((at, packet) => {
      if (at === stage) packet[field] = value;
    });
    await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
    if (stage !== 'start')
      assert.equal(
        f.events.some((event) => event.startsWith('kill-')),
        true
      );
  });
test('getter payload is rejected without executing it; owned host still cleaned', async () => {
  let executed = false;
  const f = fixture((at, packet) => {
    if (at === 'seed')
      Object.defineProperty(packet, 'calls', {
        get() {
          executed = true;
          throw new Error('private');
        },
      });
  });
  await assert.rejects(runClearAfterAck(f.adapter), /n09_ack_kill_failed/);
  assert.equal(executed, false);
  assert.equal(f.events.at(-2), 'kill-100');
  assert.equal(f.events.at(-1), 'close');
});
test('method accessor is never executed', async () => {
  let executed = false;
  const f = fixture();
  Object.defineProperty(f.adapter, 'getClearCapability', {
    get() {
      executed = true;
      throw new Error('private');
    },
  });
  await assert.rejects(runClearAfterAck(f.adapter), /n09_ack_kill_failed/);
  assert.equal(executed, false);
  assert.equal(f.events.at(-2), 'kill-100');
  assert.equal(f.events.at(-1), 'close');
});
for (const field of [
  'expiresAt',
  'calls',
  'returnedBytes',
  'originalSha256',
  'authorizationSha256',
  'rootId',
])
  test(`accounting preserves ${field}`, () => {
    const { state } = fixture();
    const next = {
      ...state,
      [field]: typeof state[field] === 'number' ? state[field] - 1 : 'changed',
    };
    assert.throws(() => accounting(state, next), /n09_ack_kill_failed/);
  });
test('accounting permits consumption but not refund or deadline renewal', () => {
  const { state } = fixture();
  accounting(state, { ...state, calls: state.calls + 1, returnedBytes: state.returnedBytes + 1 });
  assert.throws(
    () => accounting(state, { ...state, expiresAt: state.expiresAt + 1 }),
    /n09_ack_kill_failed/
  );
});
test('cleanup failure is terminal even after all assertions pass', async () => {
  const f = fixture((at) => {
    if (at === 'kill-101') throw new Error('secret cleanup text');
  });
  await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
});
test('restart failure does not silently start a fresh unrelated case', async () => {
  const f = fixture((at) => {
    if (at === 'restart') throw new Error('secret');
  });
  await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
  assert.equal(f.events.filter((event) => event === 'start').length, 1);
  assert.equal(f.events.at(-2), 'restart');
  assert.equal(f.events.at(-1), 'close');
});
test('clear failure aborts before restart and cleans the first owner', async () => {
  const f = fixture((at) => {
    if (at === 'clear') throw new Error('private upstream');
  });
  await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
  assert.equal(f.events.includes('restart'), false);
  assert.equal(f.events.at(-2), 'kill-100');
  assert.equal(f.events.at(-1), 'close');
});
test('revoked receipt cannot reappear only on a later toggle', async () => {
  let count = 0;
  const f = fixture((at, value) => {
    if (at === 'denied' && ++count === 4) value.oldReceiptDenied = false;
  });
  await assert.rejects(runClearAfterAck(f.adapter), /n09_ack_kill_failed/);
  assert.equal(f.events.at(-2), 'kill-101');
  assert.equal(f.events.at(-1), 'close');
});
test('missing host save/revoke durable ACK paths fail before seeding', async () => {
  const adapter = { existingHostDurableAckCapability: () => false };
  for (const operation of ['save', 'revoke'])
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(adapter, operation),
      /n09_host_durable_ack_unavailable/
    );
});

for (const stage of ['kill-100', 'kill-101'])
  test(`${stage} throw still invokes independent finally close and preserves failure`, async () => {
    const f = fixture((at) => {
      if (at === stage) throw new Error('PRIVATE stop');
    });
    await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
    assert.equal(f.events.at(-1), 'close');
  });

test('stop and independent close double failure stays a fixed safe failure', async () => {
  const f = fixture((at) => {
    if (at.startsWith('kill-') || at === 'close') throw new Error('PRIVATE');
  });
  await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
  assert.equal(f.events.at(-1), 'close');
});

test('invalid start identity still invokes adapter close', async () => {
  const f = fixture((at, packet) => {
    if (at === 'start') packet.pid = -1;
  });
  await assert.rejects(runClearAfterAck(f.adapter), /^Error: n09_ack_kill_failed$/);
  assert.deepEqual(f.events, ['start', 'close']);
});

test('durable capability private throw never inspects message or cause', async () => {
  let read = 0;
  const privateError = Object.create(null);
  for (const name of ['message', 'cause'])
    Object.defineProperty(privateError, name, {
      get() {
        read++;
        throw new Error('PRIVATE');
      },
    });
  for (const op of ['save', 'revoke'])
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(
        {
          existingHostDurableAckCapability() {
            throw privateError;
          },
        },
        op
      ),
      /^Error: n09_host_durable_ack_unavailable$/
    );
  assert.equal(read, 0);
});

test('durable capability accessor and Proxy boundaries reject without executing traps', async () => {
  let read = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'existingHostDurableAckCapability', {
    get() {
      read++;
      throw new Error('PRIVATE');
    },
  });
  const traps = Object.fromEntries(
    ['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'apply'].map((name) => [
      name,
      () => {
        read++;
        throw new Error('PRIVATE');
      },
    ])
  );
  const proxiedAdapter = new Proxy({}, traps);
  const proxiedCapability = { existingHostDurableAckCapability: new Proxy(() => true, traps) };
  for (const adapter of [accessor, proxiedAdapter, proxiedCapability])
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(adapter, 'save'),
      /^Error: n09_host_durable_ack_unavailable$/
    );
  assert.equal(read, 0);
});

test('durable capability true still reports explicit unwired boundary', async () => {
  await assert.rejects(
    runDurableSaveOrRevokeAfterAck({ existingHostDurableAckCapability: () => true }, 'save'),
    /^Error: n09_save_revoke_host_wiring_not_implemented$/
  );
});
