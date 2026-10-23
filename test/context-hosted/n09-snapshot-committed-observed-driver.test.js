'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {
  runCommittedObservedKill,
} = require('../../scripts/context-hosted/n09-snapshot/committed-observed-driver.js');
const bad = { message: 'n09_committed_observed_kill_failed' };
function fixture() {
  const root = path.join(os.tmpdir(), 'n09-observed-pure');
  const first = {
    pid: 100,
    configDir: path.join(root, 'config'),
    runtimeDir: path.join(root, 'runtime'),
    manifestSha256: 'a'.repeat(64),
    isolatedLoopbackSynthetic: true,
    actualBusinessHost: true,
  };
  const original = {
    originalSha256: 'b'.repeat(64),
    authorizationSha256: 'c'.repeat(64),
    rootId: 'hbs_' + 'd'.repeat(32),
    expiresAt: 10000,
    calls: 2,
    returnedBytes: 1024,
  };
  const snapshot = {
    present: true,
    evidenceLevel: 'committed-metadata-only',
    hostDurableAck: false,
    rootId: original.rootId,
    expiresAt: original.expiresAt,
    calls: 2,
    returnedBytes: 1024,
    revision: 5,
  };
  const f = { events: [], first, original, snapshot, closed: 0, kills: 0 };
  f.adapter = {
    startFreshBusinessHost: async () => {
      f.events.push('start');
      return first;
    },
    seedThroughBusinessHttp: async () => {
      f.events.push('business-response');
      return original;
    },
    readCommittedSnapshot: async (owner) => {
      f.events.push(`snapshot:${owner.pid}`);
      return f.snapshot;
    },
    killOwnedJob: async (owner) => {
      f.events.push(`kill:${owner.pid}`);
      f.kills++;
      return {
        pid: owner.pid,
        treeEmpty: true,
        shutdownInvoked: false,
        semantics: 'forced_cleanup',
      };
    },
    restartSameBusinessHost: async () => {
      f.events.push('restart');
      return { ...first, pid: 101 };
    },
    readThroughBusinessHttp: async () => {
      f.events.push('read');
      return {
        exactRead: true,
        externalToolReplays: 0,
        originalExposed: false,
        accounting: original,
      };
    },
    close: async () => {
      f.closed++;
    },
  };
  return f;
}
test('committed observation precedes forced kill, same-directory restart and exact read', async () => {
  const f = fixture();
  const phases = [];
  const result = await runCommittedObservedKill(f.adapter, (phase) => phases.push(phase));
  assert.deepEqual(phases, [101, 102, 103, 104, 105, 106, 107, 108]);
  assert.deepEqual(f.events, [
    'start',
    'business-response',
    'snapshot:100',
    'kill:100',
    'restart',
    'snapshot:101',
    'read',
    'kill:101',
  ]);
  assert.equal(f.closed, 1);
  assert.equal(result.sequence, 'committed-observed-kill');
  for (const key of [
    'liveDaemonProved',
    'hostDurableAckObserved',
    'saveAckKillQualified',
    'revokeAckKillQualified',
    'commitInProgressQualified',
    'n09Complete',
  ])
    assert.equal(result[key], false);
});

test('fixed committed phases retain each rejected step and always close acquired ownership', async () => {
  for (let rejected = 101; rejected <= 108; rejected++) {
    const f = fixture();
    let last;
    await assert.rejects(
      runCommittedObservedKill(f.adapter, (phase) => {
        last = phase;
        if (phase === rejected) throw Error('PRIVATE_PHASE_SENTINEL');
      }),
      bad
    );
    assert.equal(last, rejected);
    assert.equal(f.closed, 1);
    assert.equal(f.kills, rejected === 101 ? 0 : rejected === 105 ? 1 : rejected >= 106 ? 2 : 1);
  }
  for (const observer of [
    null,
    {},
    [],
    'PRIVATE_PHASE_SENTINEL',
    new Proxy(() => {}, {
      apply() {
        throw Error('PRIVATE_PHASE_SENTINEL');
      },
    }),
  ]) {
    const f = fixture();
    await assert.rejects(runCommittedObservedKill(f.adapter, observer), bad);
    assert.equal(f.events.length, 0);
    assert.equal(f.closed, 1);
  }
});
for (const invalid of ['absent', 'ack', 'root', 'revision', 'calls', 'bytes', 'unsafe']) {
  test(`reject ${invalid} snapshot and independently close`, async () => {
    const f = fixture();
    if (invalid === 'absent') f.snapshot.present = false;
    if (invalid === 'ack') f.snapshot.hostDurableAck = true;
    if (invalid === 'root') f.snapshot.rootId = 'PRIVATE';
    if (invalid === 'revision') f.snapshot.revision = 0;
    if (invalid === 'calls') f.snapshot.calls--;
    if (invalid === 'bytes') f.snapshot.returnedBytes--;
    if (invalid === 'unsafe') f.snapshot.calls = Number.MAX_SAFE_INTEGER + 1;
    await assert.rejects(runCommittedObservedKill(f.adapter), bad);
    assert.equal(f.closed, 1);
    assert.equal(f.events.includes('restart'), false);
  });
}
test('same PID restart fails and does not read', async () => {
  const f = fixture();
  f.adapter.restartSameBusinessHost = async () => f.first;
  await assert.rejects(runCommittedObservedKill(f.adapter), bad);
  assert.equal(f.events.includes('read'), false);
  assert.equal(f.closed, 1);
});
test('postrestart budget rollback fails before business read', async () => {
  const f = fixture();
  let reads = 0;
  f.adapter.readCommittedSnapshot = async () => ({
    ...f.snapshot,
    revision: ++reads === 1 ? 5 : 4,
  });
  await assert.rejects(runCommittedObservedKill(f.adapter), bad);
  assert.equal(f.events.includes('read'), false);
  assert.equal(f.closed, 1);
});
test('failed kill still closes owned registry without reading private error', async () => {
  const f = fixture();
  let traps = 0;
  f.adapter.killOwnedJob = async () => {
    throw new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('PRIVATE');
        },
      }
    );
  };
  await assert.rejects(runCommittedObservedKill(f.adapter), bad);
  assert.equal(f.closed, 1);
  assert.equal(traps, 0);
});
test('getters and Proxy identities fail before synthetic seeding', async () => {
  for (const proxy of [false, true]) {
    const f = fixture();
    let traps = 0;
    f.adapter.startFreshBusinessHost = async () =>
      proxy
        ? new Proxy(
            {},
            {
              ownKeys() {
                traps++;
                return [];
              },
            }
          )
        : {
            get pid() {
              traps++;
              return 100;
            },
          };
    await assert.rejects(runCommittedObservedKill(f.adapter), bad);
    assert.equal(traps, 0);
    assert.equal(f.events.includes('business-response'), false);
    assert.equal(f.closed, 1);
  }
});
