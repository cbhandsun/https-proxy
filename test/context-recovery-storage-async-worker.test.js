'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' && error.message === error.code;

test(
  'default worker serializes eight exact revisions, drains close and reopens original expiry with real Windows backend',
  { timeout: 60000 },
  async (t) => {
    const temporary = fs.realpathSync.native(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporary, 'hpm-native-async-worker-'));
    let storage;
    t.after(async () => {
      await storage?.close().catch(() => {});
      assert.equal(fs.realpathSync.native(directory), directory);
      assert.equal(path.dirname(directory), temporary);
      fs.rmSync(directory, { recursive: true, force: true });
    });
    if (process.platform !== 'win32') {
      await assert.rejects(openContextRecoveryStorage({ directory }), safe);
      return; // Unsupported-OS refusal, never a replacement for Windows evidence.
    }
    storage = await openContextRecoveryStorage({ directory });
    const expiresAt = Date.now() + 60000,
      scope = 'a'.repeat(64);
    const pending = Array.from({ length: 8 }, (_, index) =>
      storage.execute({
        operation: 'save',
        scope,
        expectedRevision: index,
        expiresAt,
        state: { fixture: 'offline synthetic', turn: index },
      })
    );
    const closing = storage.close();
    assert.deepEqual(
      (await Promise.all(pending)).map((receipt) => [
        Object.getPrototypeOf(receipt),
        Reflect.ownKeys(receipt),
        receipt.revision,
      ]),
      Array.from({ length: 8 }, (_, index) => [null, ['revision'], index + 1])
    );
    await closing;
    const failures = [];
    storage = await openContextRecoveryStorage({
      directory,
      onFailure: (value) => failures.push(value),
    });
    await assert.rejects(
      storage.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt,
        state: { fixture: 'rejected-stale' },
      }),
      safe
    );
    assert.deepEqual(failures, [
      { operation: 'save', phase: 'engine-execute', cleanupFailed: false },
    ]);
    const record = await storage.execute({ operation: 'load', scope });
    assert.equal(record.revision, 8);
    assert.equal(record.expiresAt, expiresAt);
    assert.deepEqual(JSON.parse(JSON.stringify(record.state)), {
      fixture: 'offline synthetic',
      turn: 7,
    });
    await storage.close();
    t.diagnostic('default_async_worker_dpapi_anchor_eight_exact_revisions_reopen_verified');
  }
);
