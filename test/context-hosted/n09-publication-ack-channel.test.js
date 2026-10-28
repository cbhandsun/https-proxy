'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { AbortSignal } = globalThis;
const {
  createPublicationAckChannel,
} = require('../../scripts/context-hosted/n09-business/publication-ack-channel');
const {
  createPublicationAckFiles,
} = require('../../scripts/context-hosted/n09-business/publication-observation-files');
const {
  createPublicationAckContract,
} = require('../../scripts/context-hosted/n09-business/publication-ack-contract');
const epoch = 'a'.repeat(32),
  signingKey = 'b'.repeat(64);
const target = (transition = 'prepared') => ({
  generation: 1,
  callOrdinal: 1,
  rootId: 'hbs_' + 'd'.repeat(32),
  expiresAt: 123456,
  expectedRevision: 7,
  transition,
});
async function fixture(t, mode = '') {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-ack-channel-'));
  const child = fork(
    path.join(__dirname, '../helpers/n09-publication-ack-child.cjs'),
    [caseRoot, mode],
    {
      silent: true,
      execArgv: [],
    }
  );
  let channel = null,
    files = null,
    contract = null,
    output = 0;
  child.stdout.on('data', (chunk) => {
    output += chunk.length;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.length;
  });
  t.after(async () => {
    channel?.close();
    files?.close();
    contract?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(caseRoot, { recursive: true, force: true });
    assert.equal(output, 0);
  });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(3000) });
  assert.equal(ready.kind, 'ready');
  const config = { caseRoot, pid: child.pid, epoch, signingKey };
  channel = createPublicationAckChannel(config);
  files = createPublicationAckFiles({
    directory: path.join(caseRoot, 'n09-publication-ack-' + child.pid + '-' + epoch),
    pid: child.pid,
    epoch,
  });
  contract = createPublicationAckContract({ pid: child.pid, epoch, signingKey });
  return { child, channel, files, contract, caseRoot };
}

test('two processes authenticate all five actual blocking boundaries and release only after held', async (t) => {
  for (const transition of [
    'prepared',
    'sending',
    'transport-finished',
    'uncertain',
    'withdrawn',
  ]) {
    await t.test(transition, async (t) => {
      const { child, channel } = await fixture(t);
      const armed = await channel.arm(target(transition));
      assert.equal(armed.holdChallenge, '');
      const returned = once(child, 'message', { signal: AbortSignal.timeout(3000) });
      child.send({ kind: 'ack', transition });
      const held = await channel.waitHeld();
      assert.equal(held.revision, 8);
      assert.equal(
        held.callOrdinal,
        transition === 'sending' ? 3 : transition === 'transport-finished' ? 4 : 2
      );
      assert.match(held.holdChallenge, /^[a-f0-9]{32}$/);
      channel.release();
      const released = await channel.waitReleased();
      assert.equal(released.holdChallenge, held.holdChallenge);
      assert.equal((await returned)[0].kind, 'returned');
      await assert.rejects(channel.arm(target(transition)), /n09_publication_ack_channel_rejected/);
    });
  }
});

test('an authentic release prepared before the held challenge cannot release the blocked host', async (t) => {
  const { child, channel, files, contract } = await fixture(t);
  const armed = await channel.arm(target());
  files.write(
    'release',
    1,
    JSON.stringify(
      contract.signCommand({
        ...armed,
        kind: 'release',
        callOrdinal: 2,
        revision: 8,
        holdChallenge: '0'.repeat(32),
      })
    )
  );
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'ack', transition: 'prepared' });
  await channel.waitHeld();
  assert.equal((await rejected)[0].kind, 'rejected');
});

test('wrong actual ACK revision rejects before publishing held', async (t) => {
  const { child, channel, files } = await fixture(t);
  await channel.arm(target());
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'ack', transition: 'prepared', wrongRevision: true });
  assert.equal((await rejected)[0].kind, 'rejected');
  assert.equal(files.read('held', 1), null);
});

test('a signed reply with another root, challenge or ordinal cannot satisfy the armed client', async (t) => {
  for (const change of [
    { rootId: 'hbs_' + 'f'.repeat(32) },
    { challenge: 'f'.repeat(32) },
    { callOrdinal: 1 },
  ]) {
    await t.test(Object.keys(change)[0], async (t) => {
      const { channel, files, contract } = await fixture(t);
      const armed = await channel.arm(target());
      files.write(
        'held',
        1,
        JSON.stringify(
          contract.signSignal({
            ...armed,
            kind: 'held',
            callOrdinal: 2,
            revision: 8,
            holdChallenge: 'e'.repeat(32),
            ...change,
          })
        )
      );
      await assert.rejects(channel.waitHeld(), /n09_publication_ack_channel_rejected/);
      assert.throws(() => channel.release(), /n09_publication_ack_channel_rejected/);
    });
  }
});

test('release before held and concurrent arm requests fail closed; close never releases the host', async (t) => {
  await t.test('early release', async (t) => {
    const { channel, files } = await fixture(t);
    await channel.arm(target());
    assert.throws(() => channel.release(), /n09_publication_ack_channel_rejected/);
    assert.equal(files.read('release', 1), null);
  });
  await t.test('concurrent arm', async (t) => {
    const { channel, files } = await fixture(t);
    const first = channel.arm(target());
    await assert.rejects(channel.arm(target()), /n09_publication_ack_channel_rejected/);
    await assert.rejects(first, /n09_publication_ack_channel_rejected/);
    assert.equal(files.read('release', 1), null);
  });
  await t.test('close while holding', async (t) => {
    const { child, channel, files } = await fixture(t);
    await channel.arm(target());
    child.send({ kind: 'ack', transition: 'prepared' });
    await channel.waitHeld();
    channel.close();
    channel.close();
    assert.equal(files.read('release', 1), null);
    await assert.rejects(channel.waitReleased(), /n09_publication_ack_channel_rejected/);
  });
});

test('missing held receipt expires the original 750ms witness without writing release', async (t) => {
  const { channel, files } = await fixture(t);
  await channel.arm(target());
  await assert.rejects(channel.waitHeld(), /n09_publication_ack_channel_rejected/);
  assert.equal(files.read('release', 1), null);
  await assert.rejects(channel.waitHeld(), /n09_publication_ack_channel_rejected/);
});

test('the 750ms witness includes time spent publishing its command', async (t) => {
  const { channel } = await fixture(t);
  const original = fs.writeFileSync;
  let delayed = false;
  t.mock.method(fs, 'writeFileSync', function (...args) {
    const result = Reflect.apply(original, fs, args);
    if (!delayed) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 760);
    }
    return result;
  });
  await assert.rejects(channel.arm(target()), /n09_publication_ack_channel_rejected/);
  assert.equal(delayed, true);
});

test('the real blocked child refuses ACK after the fixed five-second hold without release', async (t) => {
  const { child, channel, files } = await fixture(t);
  await channel.arm(target());
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(6500) });
  child.send({ kind: 'ack', transition: 'prepared' });
  await channel.waitHeld();
  assert.equal((await rejected)[0].kind, 'rejected');
  assert.equal(files.read('release', 1), null);
  assert.equal(files.read('released', 1), null);
  const sticky = once(child, 'message', { signal: AbortSignal.timeout(1000) });
  child.send({ kind: 'ack', transition: 'prepared' });
  assert.equal((await sticky)[0].kind, 'rejected');
});

test('time spent writing the released probe cannot extend the host ACK five-second bound', async (t) => {
  const { child, channel } = await fixture(t);
  await channel.arm(target());
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(7000) });
  child.send({ kind: 'ack', transition: 'prepared', slowRelease: true });
  await channel.waitHeld();
  channel.release();
  await assert.rejects(channel.waitReleased(), /n09_publication_ack_channel_rejected/);
  assert.equal((await rejected)[0].kind, 'rejected');
});

test('sending cannot publish a held receipt without the exact preceding prepared ACK', async (t) => {
  const { child, channel, files } = await fixture(t);
  await channel.arm(target('sending'));
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'ack', transition: 'sending', skipPredecessor: true });
  assert.equal((await rejected)[0].kind, 'rejected');
  assert.equal(files.read('held', 1), null);
});

test('signed cancellation handshake releases an async predecessor gate before its separate terminal ACK', async (t) => {
  for (const transition of ['withdrawn', 'uncertain'])
    await t.test(transition, async (t) => {
      const { child, channel, files } = await fixture(t);
      const armed = await channel.armCancellation(target(transition));
      assert.equal(armed.kind, 'armed-cancel');
      const returned = once(child, 'message', { signal: AbortSignal.timeout(3000) });
      child.send({ kind: 'cancel-action', transition });
      const trigger = await channel.waitTriggerHeld();
      assert.equal(trigger.revision, 7);
      assert.equal(trigger.callOrdinal, transition === 'withdrawn' ? 2 : 3);
      assert.equal(files.read('held', 1), null, 'trigger is not the final durable ACK');
      channel.releaseTrigger();
      const held = await channel.waitHeld();
      assert.equal(held.revision, 8);
      assert(held.callOrdinal > trigger.callOrdinal);
      assert.notEqual(held.holdChallenge, trigger.holdChallenge);
      channel.release();
      await channel.waitReleased();
      assert.equal((await returned)[0].kind, 'returned');
    });
});

test('even a full terminal ACK prefix cannot bypass the signed cancellation trigger', async (t) => {
  const { child, channel, files } = await fixture(t);
  await channel.armCancellation(target('uncertain'));
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'cancel-action', transition: 'uncertain', skipTrigger: true });
  assert.equal((await rejected)[0].kind, 'rejected');
  assert.equal(files.read('held', 1), null);
  assert.equal(files.read('trigger-held', 1), null);
});

test('a trigger release signed before the fresh trigger challenge does not release the predecessor', async (t) => {
  const { child, channel, files, contract } = await fixture(t);
  const armed = await channel.armCancellation(target('withdrawn'));
  files.write(
    'trigger-release',
    1,
    JSON.stringify(
      contract.signCommand({
        ...armed,
        kind: 'trigger-release',
        holdChallenge: '0'.repeat(32),
        callOrdinal: 2,
        revision: 7,
      })
    )
  );
  const rejected = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'cancel-action', transition: 'withdrawn' });
  await channel.waitTriggerHeld();
  assert.equal((await rejected)[0].kind, 'rejected');
  assert.equal(files.read('held', 1), null);
});

test('a valid trigger release still waits for the independent server-side cancellation witness', async (t) => {
  const { child, channel } = await fixture(t);
  await channel.armCancellation(target('withdrawn'));
  child.send({ kind: 'cancel-action', transition: 'withdrawn', waitForCancellation: true });
  await channel.waitTriggerHeld();
  channel.releaseTrigger();
  const probed = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'probe-cancel' });
  const [probe] = await probed;
  assert.equal(probe.kind, 'cancel-probe');
  assert(probe.checks > 0);
  assert.equal(probe.state, 'trigger-holding');
  assert.equal(probe.cancelled, false);
  const returned = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send({ kind: 'cancel-observed' });
  await channel.waitHeld();
  channel.release();
  await channel.waitReleased();
  assert.equal((await returned)[0].kind, 'returned');
});

test('cancellation route cannot arm a normal transition or release before a fresh trigger', async (t) => {
  const a = await fixture(t);
  await assert.rejects(
    a.channel.armCancellation(target('prepared')),
    /n09_publication_ack_channel_rejected/
  );
  assert.equal(a.files.read('arm', 1), null);
  const b = await fixture(t);
  await b.channel.armCancellation(target('withdrawn'));
  assert.throws(() => b.channel.releaseTrigger(), /n09_publication_ack_channel_rejected/);
  assert.equal(b.files.read('trigger-release', 1), null);
});

test('the final held signal cannot reuse the trigger challenge even with an authentic signature', async (t) => {
  const { channel, files, contract } = await fixture(t);
  const armed = await channel.armCancellation(target('withdrawn'));
  const trigger = {
    ...armed,
    kind: 'trigger-held',
    callOrdinal: 2,
    holdChallenge: 'e'.repeat(32),
    revision: 7,
  };
  files.write('trigger-held', 1, JSON.stringify(contract.signSignal(trigger)));
  await channel.waitTriggerHeld();
  channel.releaseTrigger();
  files.write(
    'held',
    1,
    JSON.stringify(contract.signSignal({ ...trigger, kind: 'held', callOrdinal: 3, revision: 8 }))
  );
  await assert.rejects(channel.waitHeld(), /n09_publication_ack_channel_rejected/);
});

// This real two-process channel isolates the same event-loop starvation as the
// daemon composition. It does not claim native storage or COMMIT qualification.
for (const mode of ['timer-only', 'observation']) {
  test(`authenticated observation during synchronous ACK hold: ${mode}`, async (t) => {
    const { performance } = require('node:perf_hooks');
    const {
      createPublicationObservationFiles,
    } = require('../../scripts/context-hosted/n09-business/publication-observation-files');
    const {
      createPublicationObservationContract,
    } = require('../../scripts/context-hosted/n09-business/publication-observation-contract');
    const { child, channel, files: ackFiles, caseRoot } = await fixture(t, mode);
    const files = createPublicationObservationFiles({
      directory: path.join(caseRoot, 'n09-publication-' + child.pid + '-' + epoch),
      pid: child.pid,
      epoch,
    });
    const contract = createPublicationObservationContract({ pid: child.pid, epoch, signingKey });
    t.after(() => {
      files.close();
      contract.close();
    });
    async function query(sequence) {
      const challenge = sequence.toString(16).repeat(32);
      files.write(
        'query',
        sequence,
        JSON.stringify(
          contract.signQuery({ version: 1, pid: child.pid, epoch, sequence, challenge })
        )
      );
      const deadline = performance.now() + 750;
      let wire;
      while ((wire = files.read('state', sequence)) === null && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.notEqual(wire, null);
      const state = contract.verifyState(wire);
      assert.equal(state.sequence, sequence);
      assert.equal(state.challenge, challenge);
      return state;
    }
    await channel.arm(target());
    const returned = once(child, 'message', { signal: AbortSignal.timeout(3000) });
    child.send({ kind: 'ack', transition: 'prepared', pendingAfterRelease: true });
    await channel.waitHeld();
    if (mode === 'timer-only') {
      files.write(
        'query',
        1,
        JSON.stringify(
          contract.signQuery({
            version: 1,
            pid: child.pid,
            epoch,
            sequence: 1,
            challenge: '1'.repeat(32),
          })
        )
      );
      const deadline = performance.now() + 750;
      while (performance.now() < deadline) {
        assert.equal(files.read('state', 1), null);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(files.read('state', 1), null);
    } else {
      const held = await query(1);
      assert.equal(held.status, 'completed');
      assert.equal(held.transition, 'prepared');
      assert.equal(held.expectedRevision, 7);
      assert.equal(held.activeCount, 0);
      assert.equal(ackFiles.read('released', 1), null);
    }
    channel.release();
    await channel.waitReleased();
    assert.equal((await returned)[0].kind, 'returned');
    if (mode === 'timer-only') {
      const deadline = performance.now() + 750;
      while (files.read('state', 1) === null && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.notEqual(files.read('state', 1), null);
    }
    const pending = await query(2);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.transition, 'sending');
    assert.equal(pending.expectedRevision, 8);
    assert.equal(pending.activeCount, 1);
  });
}
for (const mode of ['service-throw', 'service-return', 'service-promise', 'service-reentrant']) {
  test(`observation service failure rejects held ACK: ${mode}`, async (t) => {
    const { child, channel, files } = await fixture(t, mode);
    await channel.arm(target());
    const rejected = once(child, 'message', { signal: AbortSignal.timeout(3000) });
    child.send({ kind: 'ack', transition: 'prepared' });
    assert.equal((await rejected)[0].kind, 'rejected');
    assert.equal(files.read('released', 1), null);
  });
}

test('observation service dependencies reject unsafe shapes without invoking user hooks', () => {
  const {
    createPublicationAckHost,
  } = require('../../scripts/context-hosted/n09-business/publication-ack-host');
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw new Error('fixture');
      },
      get() {
        traps++;
        throw new Error('fixture');
      },
    }
  );
  const accessor = Object.defineProperty({ cancellationObserved() {} }, 'serviceObservation', {
    enumerable: true,
    get() {
      traps++;
      throw new Error('fixture');
    },
  });
  for (const dependencies of [
    null,
    [],
    proxy,
    accessor,
    { cancellationObserved() {}, serviceObservation: true },
    { cancellationObserved() {}, serviceObservation: async () => {} },
    { cancellationObserved() {}, serviceObservation: function* () {} },
    { cancellationObserved() {}, serviceObservation: new Proxy(() => {}, {}) },
    { cancellationObserved() {}, serviceObservation() {}, extra: true },
    { serviceObservation() {} },
  ]) {
    assert.throws(
      () =>
        createPublicationAckHost(
          { caseRoot: os.tmpdir(), pid: process.pid, epoch, signingKey },
          {},
          dependencies
        ),
      /n09_publication_ack_host_rejected/
    );
  }
  assert.equal(traps, 0);
});
