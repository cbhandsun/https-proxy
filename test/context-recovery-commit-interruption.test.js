'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');

const before = { text: 'before🙂', checkpoint: 1 };
const after = { text: 'after🙂', checkpoint: 2 };

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-commit-interior-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  const key = randomBytes(32).toString('base64');
  const scope = 'c'.repeat(64);
  let child;
  let exit;
  let reader;
  let probe;
  let readerExit;
  let database = new DatabaseSync(file, { allowExtension: false });
  let store = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
  try {
    store.execute({
      operation: 'save',
      scope,
      expectedRevision: 0,
      expiresAt: 1000,
      state: before,
    });
    assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 1000);
    store.close();
    database.close();
    store = database = undefined;
    child = fork(path.join(__dirname, 'helpers', 'context-recovery-commit-child.cjs'), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    // Unexpected fixture output fails closed without reproducing its contents.
    let outputBytes = 0;
    child.stdout.on('data', (chunk) => (outputBytes += chunk.length));
    child.stderr.resume(); // Node's experimental SQLite warning is not protocol output.
    const phases = [];
    child.on('message', (message) => phases.push(message?.phase));
    exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    async function waitPhase(phase) {
      const deadline = performance.now() + 5000;
      while (!phases.includes(phase)) {
        if (phase !== 'failed') assert.ok(!phases.includes('failed'), 'child operation failed');
        assert.equal(child.exitCode, null, 'child exited before expected phase');
        assert.equal(child.signalCode, null, 'child was killed before expected phase');
        assert.ok(performance.now() < deadline, 'child phase deadline exceeded');
        await nextTurn();
      }
    }
    child.send({ operation: 'initialize', file, key, scope });
    await waitPhase('ready');
    // The reader must be a separate process: SQLite connections in the same
    // process can share a POSIX SHARED lock and mask the writer's PENDING lock.
    reader = fork(path.join(__dirname, 'helpers', 'context-recovery-commit-reader.cjs'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    readerExit = new Promise((resolve, reject) => {
      reader.once('error', reject);
      reader.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let readerPhase;
    reader.on('message', (message) => (readerPhase = message?.phase));
    reader.send({ file });
    const readerDeadline = performance.now() + 5000;
    while (readerPhase !== 'reader-held') {
      assert.notEqual(readerPhase, 'reader-failed');
      assert.equal(reader.exitCode, null);
      assert.equal(reader.signalCode, null);
      assert.ok(performance.now() < readerDeadline, 'reader lock deadline exceeded');
      await nextTurn();
    }
    probe = new DatabaseSync(file, { allowExtension: false });
    probe.exec('PRAGMA busy_timeout=0');
    function probePending() {
      try {
        probe.prepare('SELECT revision FROM recovery_state').all();
        return false;
      } catch (error) {
        assert.equal(error.code, 'ERR_SQLITE_ERROR');
        assert.equal(error.errcode, 5, 'only SQLITE_BUSY qualifies as the PENDING lock witness');
        return true;
      }
    }
    assert.equal(probePending(), false, 'a held SHARED reader alone must permit another reader');
    async function releaseReader() {
      reader.send({ operation: 'release' });
      assert.deepEqual(await readerExit, { code: 0, signal: null });
    }
    await run({
      child,
      exit,
      phases,
      waitPhase,
      probePending,
      releaseReader,
      async startCommit() {
        child.send({ operation: 'save' });
        await waitPhase('commit-entering');
        // No timeout increase/retry: the production COMMIT retains busy_timeout=1000.
        const deadline = performance.now() + 750;
        while (!probePending()) {
          assert.ok(performance.now() < deadline, 'COMMIT did not acquire a PENDING lock');
          assert.ok(!phases.includes('failed'), 'COMMIT failed before lock witness');
          await nextTurn();
        }
        assert.ok(!phases.includes('acknowledged'), 'blocked COMMIT cannot have acknowledged');
        assert.ok(fs.statSync(`${file}-journal`).size > 512, 'real DELETE rollback journal exists');
      },
      reopen(expected) {
        database = new DatabaseSync(file, { allowExtension: false });
        store = createRecoverySqliteStore({ database, dataKey: key, now: () => 300 });
        const restored = store.execute({ operation: 'load', scope });
        assert.equal(restored.revision, expected.checkpoint);
        assert.equal(restored.expiresAt, 1000);
        assert.deepEqual(JSON.parse(JSON.stringify(restored.state)), expected);
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      },
    });
    assert.equal(outputBytes, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exit) await exit;
    if (reader && reader.exitCode === null && reader.signalCode === null) reader.kill('SIGKILL');
    if (readerExit) await readerExit;
    probe?.close();
    store?.close();
    database?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-commit-interior-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test(
  'SIGKILL during actual SQLite COMMIT lock wait preserves the prior exact checkpoint',
  { timeout: 15000 },
  async () => {
    await fixture(async ({ child, exit, startCommit, phases, releaseReader, reopen }) => {
      await startCommit();
      assert.equal(child.kill('SIGKILL'), true);
      const result = await exit;
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(result.code, null);
      assert.equal(phases.includes('acknowledged'), false);
      assert.equal(phases.includes('failed'), false);
      await releaseReader();
      reopen(before);
    });
  }
);

test(
  'releasing the same COMMIT lock wait permits one acknowledged durable revision',
  { timeout: 15000 },
  async () => {
    await fixture(async ({ exit, startCommit, waitPhase, phases, releaseReader, reopen }) => {
      await startCommit();
      await releaseReader();
      await waitPhase('acknowledged');
      assert.deepEqual(await exit, { code: 0, signal: null });
      assert.equal(phases.filter((phase) => phase === 'acknowledged').length, 1);
      reopen(after);
    });
  }
);

test(
  'a kill before COMMIT cannot qualify as an internal COMMIT interruption',
  { timeout: 15000 },
  async () => {
    await fixture(async ({ child, exit, phases, probePending, releaseReader, reopen }) => {
      assert.equal(probePending(), false);
      assert.equal(phases.includes('commit-entering'), false);
      assert.equal(child.kill('SIGKILL'), true);
      assert.equal((await exit).signal, 'SIGKILL');
      assert.equal(phases.includes('acknowledged'), false);
      await releaseReader();
      reopen(before);
    });
  }
);

test(
  'the unchanged busy deadline rejects blocked COMMIT without a durability ACK',
  { timeout: 15000 },
  async () => {
    await fixture(async ({ exit, startCommit, waitPhase, phases, releaseReader, reopen }) => {
      await startCommit();
      await waitPhase('failed');
      assert.deepEqual(await exit, { code: 39, signal: null });
      assert.equal(phases.includes('acknowledged'), false);
      await releaseReader();
      reopen(before);
    });
  }
);
