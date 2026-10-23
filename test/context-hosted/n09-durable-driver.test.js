'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { discoverTestFiles } = require('../../lib/test-discovery');
const { runDurableSaveOrRevokeAfterAck } = require('../../scripts/context-hosted/n09-ipc/driver');

function fixture(operation, change = () => {}) {
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
    actualBusinessHost: true,
    isolatedLoopbackSynthetic: true,
  });
  const result = (name, value) => {
    events.push(name);
    return change(name, value) ?? value;
  };
  const adapter = {
    existingHostDurableAckCapability(op) {
      assert.equal(op, operation);
      return async (owner) =>
        result('ack', {
          kind: 'host-' + operation + '-completed',
          durableBoundary: operation === 'save' ? 'await-reference-save' : 'await-revokeAsync',
          pid: owner.pid,
          accounting: { ...state },
        });
    },
    startFreshBusinessHost: () => result('start', host(100)),
    seedThroughBusinessHttp: () => result('seed', { ...state }),
    readThroughBusinessHttp: () =>
      result('read', { exactRead: true, externalToolReplays: 0, accounting: { ...state } }),
    killOwnedJob: (owner) =>
      result('kill-' + owner.pid, {
        pid: owner.pid,
        treeEmpty: true,
        shutdownInvoked: false,
        semantics: 'forced_cleanup',
      }),
    restartSameBusinessHost: () => result('restart', host(101)),
    setCombinationThroughManagement: (_owner, combination) => result('toggle-' + combination),
    readOldReceiptThroughBusinessHttp: () =>
      result('denied', { oldReceiptDenied: true, originalExposed: false, externalToolReplays: 0 }),
    close: () => result('close'),
  };
  return { adapter, events, state };
}

for (const operation of ['save', 'revoke']) {
  test(`${operation} orchestration validates host ACK before forced kill without granting live qualification`, async () => {
    const f = fixture(operation);
    const receipt = await runDurableSaveOrRevokeAfterAck(f.adapter, operation);
    const after =
      operation === 'save'
        ? ['read']
        : ['denied', ...['00', '01', '10', '11'].flatMap((c) => ['toggle-' + c, 'denied'])];
    assert.deepEqual(f.events, [
      'start',
      'seed',
      'read',
      'ack',
      'kill-100',
      'restart',
      ...after,
      'kill-101',
      'close',
    ]);
    assert.equal(receipt.operation, operation);
    assert.equal(receipt.evidenceLevel, 'adapter-orchestration-only');
    for (const key of [
      'liveDaemonProved',
      'hostDurableAckObserved',
      'saveAckKillQualified',
      'revokeAckKillQualified',
      'n09Complete',
    ])
      assert.equal(receipt[key], false);
  });

  for (const [stage, field, value] of [
    ['ack', 'kind', 'committed-metadata-only'],
    ['ack', 'durableBoundary', 'http-finish'],
    ['ack', 'pid', 99],
    ['ack', 'accounting', { calls: 3 }],
    ['restart', 'pid', 100],
    ['restart', 'manifestSha256', 'e'.repeat(64)],
    ['kill-100', 'treeEmpty', false],
    ['kill-100', 'shutdownInvoked', true],
    ['read', 'externalToolReplays', 1],
  ])
    test(`${operation} rejects ${stage}.${field} and independently closes`, async () => {
      const f = fixture(operation, (name, packet) => {
        if (name === stage) packet[field] = value;
      });
      await assert.rejects(
        runDurableSaveOrRevokeAfterAck(f.adapter, operation),
        /^Error: n09_ack_kill_failed$/
      );
      assert.equal(f.events.at(-1), 'close');
      if (stage === 'ack') assert.ok(!f.events.includes('restart'));
    });

  test(`${operation} waits for ACK resolution and closes after rejected acknowledgement`, async () => {
    const f = fixture(operation);
    let rejectAck;
    f.adapter.existingHostDurableAckCapability = () => () =>
      new Promise((_resolve, reject) => {
        rejectAck = reject;
      });
    const pending = runDurableSaveOrRevokeAfterAck(f.adapter, operation);
    void pending.catch(() => {});
    for (let turn = 0; turn < 20 && !rejectAck; turn++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof rejectAck, 'function');
    assert.deepEqual(f.events, ['start', 'seed', 'read']);
    rejectAck(new Error('PRIVATE'));
    await assert.rejects(pending, /^Error: n09_ack_kill_failed$/);
    assert.deepEqual(f.events.slice(-2), ['kill-100', 'close']);
  });
}

test('save read after restart cannot reduce acknowledged accounting or change original identity', async () => {
  for (const change of [
    { calls: 2 },
    { returnedBytes: 99 },
    { expiresAt: 123456790 },
    { originalSha256: 'e'.repeat(64) },
  ]) {
    let reads = 0;
    const f = fixture('save', (name, packet) => {
      if (name === 'read' && ++reads === 2) Object.assign(packet.accounting, change);
    });
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(f.adapter, 'save'),
      /^Error: n09_ack_kill_failed$/
    );
    assert.equal(f.events.at(-1), 'close');
  }
});

test('unavailable and hostile callable capabilities fail before any host start', async () => {
  let traps = 0;
  const hostile = new Proxy(() => {}, {
    apply() {
      traps++;
      throw new Error('PRIVATE');
    },
    get() {
      traps++;
      throw new Error('PRIVATE');
    },
  });
  for (const capability of [null, undefined, false, {}, [], 'save', hostile]) {
    const f = fixture('save');
    f.adapter.existingHostDurableAckCapability = () => capability;
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(f.adapter, 'save'),
      /^Error: n09_host_durable_ack_unavailable$/
    );
    assert.deepEqual(f.events, []);
  }
  assert.equal(traps, 0);
});

test('ACK getters never execute and missing, extreme or decreasing accounting cannot trigger restart', async () => {
  for (const mutate of [
    (ack) =>
      Object.defineProperty(ack, 'pid', {
        get() {
          throw new Error('PRIVATE');
        },
      }),
    (ack) => {
      delete ack.accounting;
    },
    (ack) => {
      ack.extra = 'PRIVATE';
    },
    (ack) => {
      ack.accounting.calls = Number.MAX_SAFE_INTEGER + 1;
    },
    (ack) => {
      ack.accounting.returnedBytes = -1;
    },
    (ack) => {
      ack.accounting.authorizationSha256 = 'e'.repeat(64);
    },
  ]) {
    const f = fixture('save', (name, packet) => {
      if (name === 'ack') mutate(packet);
    });
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(f.adapter, 'save'),
      /^Error: n09_ack_kill_failed$/
    );
    assert.ok(!f.events.includes('restart'));
    assert.equal(f.events.at(-1), 'close');
  }
});

for (const stage of ['start', 'seed', 'ack', 'kill-100', 'restart', 'kill-101', 'close'])
  test(`save ${stage} failure preserves safe failure and independent cleanup`, async () => {
    const f = fixture('save', (name) => {
      if (name === stage) throw new Error('PRIVATE');
    });
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(f.adapter, 'save'),
      /^Error: n09_ack_kill_failed$/
    );
    assert.equal(f.events.at(-1), 'close');
  });

test('revoke denial remains mandatory after every toggle', async () => {
  for (let deniedAt = 1; deniedAt <= 5; deniedAt++) {
    let denied = 0;
    const f = fixture('revoke', (name, packet) => {
      if (name === 'denied' && ++denied === deniedAt) packet.oldReceiptDenied = false;
    });
    await assert.rejects(
      runDurableSaveOrRevokeAfterAck(f.adapter, 'revoke'),
      /^Error: n09_ack_kill_failed$/
    );
    assert.equal(denied, deniedAt);
    assert.equal(f.events.at(-1), 'close');
  }
});

test('durable driver regression is included in unified test discovery', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '../..')).includes(
      'test/context-hosted/n09-durable-driver.test.js'
    )
  );
});
