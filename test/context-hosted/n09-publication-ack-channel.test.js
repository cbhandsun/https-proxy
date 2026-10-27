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
async function fixture(t) {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-ack-channel-'));
  const child = fork(path.join(__dirname, '../helpers/n09-publication-ack-child.cjs'), [caseRoot], {
    silent: true,
    execArgv: [],
  });
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
  return { child, channel, files, contract };
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
      assert.equal(held.callOrdinal, 2);
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
