'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  performN09DurableCommand,
} = require('../../scripts/context-hosted/n09-ack/durable-command');
const safe = (error) => error.message === 'n09_host_ack_rejected' && !error.cause;
const command = {
  pid: 123,
  operation: 'save',
  rootId: 'hbs_' + 'a'.repeat(32),
  expiresAt: 1000,
  minRevision: 1,
};
const receipt = (extra = {}) => ({
  version: 1,
  pid: 123,
  epoch: 'b'.repeat(32),
  sequence: 1,
  kind: 'host-save-completed',
  durableBoundary: 'await-reference-save',
  rootId: command.rootId,
  expiresAt: 1000,
  revision: 2,
  calls: 2,
  returnedBytes: 123,
  revisionSource: 'validated-reference-save',
  evidenceLevel: 'observer-boundary-only',
  liveDaemonProved: false,
  ...extra,
});
function fixture() {
  let now = 0;
  const events = [];
  let armedReads = 0,
    receiptReads = 0;
  const client = {
    submit(value) {
      events.push(['submit', value]);
    },
    readArmed() {
      events.push(['armed']);
      return ++armedReads >= 2;
    },
    readReceipt() {
      events.push(['receipt']);
      return ++receiptReads >= 2 ? receipt() : null;
    },
    close() {
      events.push(['close']);
    },
  };
  const hooks = {
    client,
    startSave() {
      events.push(['start']);
    },
  };
  const timing = {
    now: () => now,
    pause: async () => {
      events.push(['wait']);
      now += 10;
    },
  };
  return {
    events,
    hooks,
    timing,
    advance: (value) => {
      now += value;
    },
  };
}

test('save starts real work only after armed and returns actual receipt without close or extra I/O', async () => {
  const f = fixture();
  const value = await performN09DurableCommand(command, f.hooks, f.timing);
  assert.equal(value.calls, 2);
  assert.deepEqual(
    f.events.map(([name]) => name),
    ['submit', 'armed', 'wait', 'armed', 'start', 'receipt', 'wait', 'receipt']
  );
  assert.equal(f.events[0][1].operation, 'arm-save');
  assert.equal(value.liveDaemonProved, false);
});

test('revoke never starts HTTP or checks armed and preserves the last validated save revision', async () => {
  const f = fixture();
  f.hooks.client.readReceipt = () =>
    receipt({ kind: 'host-revoke-completed', durableBoundary: 'await-revokeAsync', revision: 1 });
  const value = await performN09DurableCommand(
    { ...command, operation: 'revoke' },
    f.hooks,
    f.timing
  );
  assert.equal(value.revision, 1);
  assert.deepEqual(
    f.events.map(([name]) => name),
    ['submit']
  );
  assert.equal(f.events[0][1].operation, 'revoke-bound-root');
});

test('armed and final wait share one deadline without retries or a renewed budget', async () => {
  const f = fixture();
  let polls = 0;
  f.hooks.client.readArmed = () => ++polls === 3;
  f.hooks.client.readReceipt = () => null;
  f.timing.pause = async () => {
    f.advance(6000);
  };
  await assert.rejects(performN09DurableCommand(command, f.hooks, f.timing), safe);
  assert.equal(polls, 3);
  assert.deepEqual(
    f.events.map(([name]) => name),
    ['submit', 'start']
  );
});

test('invalid identity, revision, kind or claimed live qualification can never become a final ACK', async () => {
  for (const extra of [
    { pid: 124 },
    { rootId: 'hbs_' + 'f'.repeat(32) },
    { expiresAt: 1001 },
    { revision: 1 },
    { kind: 'host-revoke-completed' },
    { liveDaemonProved: true },
    { calls: -1 },
  ]) {
    const f = fixture();
    f.hooks.client.readReceipt = () => receipt(extra);
    await assert.rejects(performN09DurableCommand(command, f.hooks, f.timing), safe);
  }
});

test('invalid sync methods, unknown getters, async work and unsafe pause results fail without executing traps', async () => {
  let hits = 0;
  const hostile = Object.defineProperty({}, 'then', {
    get() {
      hits++;
      throw new Error('private');
    },
  });
  const f = fixture();
  f.timing.pause = () => hostile;
  await assert.rejects(performN09DurableCommand(command, f.hooks, f.timing), safe);
  const g = fixture();
  g.hooks.startSave = async () => {
    hits++;
    throw new Error('private');
  };
  await assert.rejects(performN09DurableCommand(command, g.hooks, g.timing), safe);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        hits++;
        return [];
      },
    }
  );
  await assert.rejects(performN09DurableCommand(proxy, fixture().hooks), safe);
  assert.equal(hits, 0);
});

test('unexpected rejected native start results are consumed and backward/nonfinite clocks fail closed', async () => {
  const f = fixture();
  f.hooks.startSave = () => Promise.reject(new Error('private'));
  await assert.rejects(performN09DurableCommand(command, f.hooks, f.timing), safe);
  await new Promise((resolve) => setImmediate(resolve));
  for (const values of [
    [1, 0],
    [0, NaN],
    [0, Infinity],
  ]) {
    const g = fixture();
    g.timing.now = () => values.shift();
    await assert.rejects(performN09DurableCommand(command, g.hooks, g.timing), safe);
  }
});
