'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');

function processFixture(file) {
  const child = fork(path.join(__dirname, file), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let outputBytes = 0;
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
  });
  child.stderr.resume(); // Experimental SQLite warning is not protocol output.
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    messages,
    exited,
    async phase(name) {
      const deadline = performance.now() + 5000;
      while (!messages.some((message) => message.phase === name)) {
        assert.ok(
          !messages.some((message) => /failed/.test(message.phase)),
          `fixture failed (${messages.map((message) => message.phase).join(',')})`
        );
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        assert.ok(performance.now() < deadline, 'fixture phase deadline exceeded');
        await nextTurn();
      }
      return messages.find((message) => message.phase === name);
    },
    async kill() {
      assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      assert.equal(outputBytes, 0);
    },
  };
}

async function publicationInterruption({ transition, boundary, kill, native = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-publication-interior-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  const key = randomBytes(32).toString('base64');
  const writer = processFixture('context-recovery-publication-child.cjs');
  let reader, probe, database, engine;
  try {
    writer.child.send({
      operation: 'initialize',
      file,
      transition,
      boundary,
      ...(native ? { native: true } : { key }),
    });
    const ready = await writer.phase('ready');
    if (native)
      assert.equal(
        writer.messages.filter((message) => message.phase === 'native-opened').length,
        1
      );
    if (boundary === 'commit') {
      reader = processFixture('context-recovery-commit-reader.cjs');
      reader.child.send({ file });
      await reader.phase('reader-held');
      probe = new DatabaseSync(file, { allowExtension: false });
      probe.exec('PRAGMA busy_timeout=0');
      assert.ok(probe.prepare('SELECT revision FROM recovery_state').all().length > 0);
    }
    writer.child.send({ operation: 'advance' });
    let committed;
    if (boundary === 'commit') {
      await writer.phase('commit-entering');
      const deadline = performance.now() + 750;
      while (true) {
        try {
          probe.prepare('SELECT revision FROM recovery_state').all();
        } catch (error) {
          assert.equal(error.code, 'ERR_SQLITE_ERROR');
          assert.equal(error.errcode, 5);
          break;
        }
        assert.ok(performance.now() < deadline, 'actual COMMIT PENDING lock missing');
        await nextTurn();
      }
      assert.ok(fs.statSync(`${file}-journal`).size > 512);
    } else committed = (await writer.phase('commit-durable')).record;
    assert.equal(
      writer.messages.some((message) => message.phase === 'acknowledged'),
      false
    );
    if (kill) await writer.kill();
    if (reader) {
      reader.child.send({ operation: 'release' });
      assert.deepEqual(await reader.exited, { code: 0, signal: null });
    }
    if (!kill) {
      if (boundary === 'ack') writer.child.send({ operation: 'release' });
      committed = (await writer.phase('acknowledged')).record;
      assert.deepEqual(await writer.exited, { code: 0, signal: null });
      assert.equal(writer.messages.filter((message) => message.phase === 'acknowledged').length, 1);
    } else
      assert.equal(
        writer.messages.some((message) => message.phase === 'acknowledged'),
        false
      );
    if (native) {
      // Reopen the same physical directory with the unmodified default worker,
      // production DPAPI protector and independently retained OS anchor.
      engine = await openContextRecoveryStorage({ directory });
      database = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    } else {
      database = new DatabaseSync(file, { allowExtension: false });
      engine = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
    }
    const restored = await engine.execute({ operation: 'load', scope: ready.scope });
    const expected = kill && boundary === 'commit' ? ready.record : committed;
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), expected);
    assert.equal(restored.expiresAt, ready.record.expiresAt);
    if (!(kill && boundary === 'commit')) {
      assert.equal(restored.revision, ready.record.revision + 1);
      assert.equal(
        restored.state.publications.find((item) => item.snapshotId === ready.targetId).state,
        transition
      );
      assert.equal(
        restored.state.root.ledger.sources[0].output,
        'synthetic-publication\r\nélève🙂\u0000'
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(restored.state.root.budget)),
        ready.record.state.root.budget
      );
    }
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
    // The native inspector is a distinct read-only connection. Its busy
    // timeout cannot witness the worker's connection-local setting.
    if (!native) assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 1000);
  } finally {
    await writer.close();
    await reader?.close();
    probe?.close();
    await engine?.close();
    database?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-publication-interior-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { publicationInterruption };
