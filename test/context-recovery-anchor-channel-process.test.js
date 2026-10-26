'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createRecoveryAnchorChannel } = require('../lib/proxy/context-recovery-anchor-channel');

const request = JSON.stringify({ operation: 'read', slot: 'a'.repeat(64) });
const reply = '{"ok":true,"revision":0,"value":null}';
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.cause === undefined;
function fixture(t, mode) {
  const children = [],
    closed = new Set();
  const channel = createRecoveryAnchorChannel(
    { executable: process.execPath, systemRoot: process.env.SystemRoot || 'C:\\Windows' },
    {
      spawnChild(_file, args, options) {
        assert.deepEqual(args, ['--hpm-context-anchor-stream-v1']);
        const child = spawn(
          process.execPath,
          [path.join(__dirname, 'helpers/context-recovery-anchor-stream-child.cjs'), mode],
          options
        );
        children.push(child);
        child.once('close', () => closed.add(child));
        return child;
      },
    }
  );
  t.after(async () => {
    for (const child of children) if (!closed.has(child)) child.kill('SIGKILL');
    await channel.close();
  });
  return { channel, children, closed };
}

test('actual child handles several frames in one process and graceful EOF leaves no owned child', async (t) => {
  const f = fixture(t, 'reply');
  for (let i = 0; i < 4; i++) assert.equal(await f.channel.execute(request), reply);
  assert.equal(f.children.length, 1);
  await f.channel.close();
  assert.equal(f.closed.size, 1);
  assert.equal(f.children[0].exitCode, 0);
});

test('actual malformed output, early exit and stderr reject only after the owned process closes', async (t) => {
  for (const mode of ['partial', 'sequence', 'exit', 'stderr']) {
    const f = fixture(t, mode);
    await assert.rejects(f.channel.execute(request), safe);
    assert.equal(f.closed.size, 1);
    await assert.rejects(f.channel.execute(request), safe);
    assert.equal(f.children.length, 1);
    await f.channel.close();
  }
});

test(
  'actual hanging process is killed at the original native deadline and never retried',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t, 'hang'),
      started = performance.now();
    await assert.rejects(f.channel.execute(request), safe);
    assert.equal(f.closed.size, 1);
    assert.equal(f.children.length, 1);
    assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
    await f.channel.close();
    t.diagnostic(
      JSON.stringify({
        scope: 'owned_native_stream_timeout',
        elapsedMs: Math.round(performance.now() - started),
        childClosed: true,
        retryCount: 0,
      })
    );
  }
);

test('actual cancellation during an in-flight command waits for process termination', async (t) => {
  const f = fixture(t, 'hang');
  const pending = f.channel.execute(request),
    failed = assert.rejects(pending, safe);
  await f.channel.close();
  await failed;
  assert.equal(f.closed.size, 1);
  assert.equal(f.children.length, 1);
});

test(
  'actual idle process ignoring EOF is killed and reaped at the original close deadline',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t, 'idle-hang');
    assert.equal(await f.channel.execute(request), reply);
    await f.channel.close();
    assert.equal(f.closed.size, 1);
    assert.equal(f.children.length, 1);
    assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
  }
);

test('actual unexpected idle process death makes the channel terminal without respawn', async (t) => {
  const f = fixture(t, 'reply');
  assert.equal(await f.channel.execute(request), reply);
  const ended = new Promise((resolve) => f.children[0].once('close', resolve));
  f.children[0].kill('SIGKILL');
  await ended;
  await assert.rejects(f.channel.execute(request), safe);
  assert.equal(f.children.length, 1);
  await f.channel.close();
});

test('actual missing executable fails closed without fallback or retry', async () => {
  const channel = createRecoveryAnchorChannel({
    executable: path.join(__dirname, 'missing-' + randomBytes(16).toString('hex') + '.exe'),
    systemRoot: process.env.SystemRoot || 'C:\\Windows',
  });
  await assert.rejects(channel.execute(request), safe);
  await channel.close();
  await assert.rejects(channel.execute(request), safe);
});

test('channel and native stream pair under the current Windows registry backend, with no portable success substitute', async (t) => {
  if (process.platform !== 'win32') {
    const f = fixture(t, 'sequence');
    await assert.rejects(f.channel.execute(request), safe);
    assert.equal(f.closed.size, 1);
    return;
  }
  const children = [],
    closed = new Set();
  const channel = createRecoveryAnchorChannel(
    {
      executable: path.resolve(__dirname, '../runtime/native/hpm-context-recovery-key.exe'),
      systemRoot: process.env.SystemRoot,
    },
    {
      spawnChild(...args) {
        const child = spawn(...args);
        children.push(child);
        child.once('close', () => closed.add(child));
        return child;
      },
    }
  );
  t.after(async () => {
    for (const child of children) if (!closed.has(child)) child.kill('SIGKILL');
    await channel.close();
  });
  const slot = randomBytes(32).toString('hex'),
    value = randomBytes(29).toString('base64');
  assert.equal(await channel.execute(JSON.stringify({ operation: 'read', slot })), reply);
  assert.deepEqual(
    JSON.parse(
      await channel.execute(
        JSON.stringify({ operation: 'compare', slot, expectedRevision: 0, value })
      )
    ),
    { ok: true, revision: 1, value }
  );
  assert.deepEqual(JSON.parse(await channel.execute(JSON.stringify({ operation: 'read', slot }))), {
    ok: true,
    revision: 1,
    value,
  });
  await assert.rejects(
    channel.execute(JSON.stringify({ operation: 'compare', slot, expectedRevision: 0, value })),
    safe
  );
  assert.equal(children.length, 1);
  assert.equal(closed.size, 1);
  await channel.close();
});
