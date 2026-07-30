const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _test } = require('../lib/proxy/audit');

(async () => {
  const compacted = _test.compactAuditValue({
    text: 'x'.repeat(200000),
    nested: { keep: '<script>alert(1)</script>' },
  });
  assert.ok(compacted.text.endsWith('...[truncated]'));
  assert.strictEqual(compacted.nested.keep, '<script>alert(1)</script>');
  assert.deepStrictEqual(
    _test.compactAuditValue({
      authorization: 'Bearer secret',
      nested: { apiKey: 'sk-secret', 'x-api-key': 'x-secret', safe: 'visible' },
    }),
    {
      authorization: '[redacted]',
      nested: { apiKey: '[redacted]', 'x-api-key': '[redacted]', safe: 'visible' },
    }
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-audit-jsonl-'));
  try {
    _test.resetSecuredPathCache();
    const auditFile = path.join(tmpDir, 'audit.jsonl');
    const rotated = auditFile + '.1';
    fs.writeFileSync(auditFile, 'x'.repeat(80), 'utf8');
    assert.strictEqual(await _test.rotateAuditFileIfNeeded(auditFile, 100, 64), true);
    assert.strictEqual(fs.existsSync(rotated), true);
    assert.strictEqual(fs.existsSync(auditFile), false);
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpDir, 0o755);
      await _test.ensurePrivateAuditDirectory(tmpDir);
      assert.strictEqual(fs.statSync(tmpDir).mode & 0o777, 0o700);
      fs.chmodSync(tmpDir, 0o755);
      await _test.ensurePrivateAuditDirectoryOnce(tmpDir);
      fs.chmodSync(tmpDir, 0o755);
      await _test.ensurePrivateAuditDirectoryOnce(tmpDir);
      assert.strictEqual(
        fs.statSync(tmpDir).mode & 0o777,
        0o755,
        'cached audit directories must not be re-secured for every record'
      );
      assert.strictEqual(fs.statSync(rotated).mode & 0o777, 0o600);
      fs.writeFileSync(auditFile, 'audit', { mode: 0o644 });
      await _test.ensurePrivateAuditFile(auditFile);
      assert.strictEqual(fs.statSync(auditFile).mode & 0o777, 0o600);
      fs.chmodSync(auditFile, 0o644);
      _test.ensurePrivateAuditFileSync(auditFile);
      assert.strictEqual(fs.statSync(auditFile).mode & 0o777, 0o600);
      fs.chmodSync(tmpDir, 0o755);
      _test.ensurePrivateAuditDirectorySync(tmpDir);
      assert.strictEqual(fs.statSync(tmpDir).mode & 0o777, 0o700);
    }

    fs.writeFileSync(
      auditFile,
      [
        JSON.stringify({ id: 'a', index: 1 }),
        'not json',
        JSON.stringify({ id: 'b', index: 2 }),
        JSON.stringify({ id: 'c', index: 3 }),
      ].join('\n') + '\n',
      'utf8'
    );
    assert.deepStrictEqual(
      _test.readAuditRecordsFromFile(auditFile, 2).map((item) => item.id),
      ['c', 'b']
    );

    let releaseWrite;
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const delayedWrite = _test.enqueueAuditOperation(async () => {
      await writeGate;
      fs.appendFileSync(auditFile, 'pending-write\n', 'utf8');
    });
    const queuedClear = _test.enqueueAuditOperation(async () => {
      fs.writeFileSync(auditFile, '', 'utf8');
    });
    assert.ok(_test.getPendingOperationCount() >= 2);
    releaseWrite();
    await Promise.all([delayedWrite, queuedClear]);
    assert.strictEqual(fs.readFileSync(auditFile, 'utf8'), '');

    await assert.rejects(
      _test.enqueueAuditOperation(async () => {
        throw new Error('expected queue failure');
      }),
      /expected queue failure/
    );
    await _test.enqueueAuditOperation(async () => {
      fs.writeFileSync(auditFile, 'queue-recovered', 'utf8');
    });
    assert.strictEqual(fs.readFileSync(auditFile, 'utf8'), 'queue-recovered');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('[audit.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
