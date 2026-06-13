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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-audit-jsonl-'));
  try {
    const auditFile = path.join(tmpDir, 'audit.jsonl');
    const rotated = auditFile + '.1';
    fs.writeFileSync(auditFile, 'x'.repeat(80), 'utf8');
    assert.strictEqual(await _test.rotateAuditFileIfNeeded(auditFile, 100, 64), true);
    assert.strictEqual(fs.existsSync(rotated), true);
    assert.strictEqual(fs.existsSync(auditFile), false);

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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('[audit.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
