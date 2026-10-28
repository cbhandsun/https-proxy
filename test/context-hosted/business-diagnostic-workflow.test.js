'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('business diagnostic reuses the pinned bounded executor and cannot replace the formal gated chain', () => {
  const source = fs.readFileSync(
    path.join(root, '.github/workflows/context-business-boundary-diagnostic.yml'),
    'utf8'
  );
  const formal = fs.readFileSync(
    path.join(root, '.github/workflows/windows-context-recovery-hosted.yml'),
    'utf8'
  );
  for (const command of [
    'node scripts/prepare-context-hosted-run.js $env:SCENARIO',
    './scripts/qualify-context-hosted.ps1 -Case $env:SCENARIO',
  ]) {
    assert.ok(source.includes(command));
    assert.ok(formal.includes(command));
  }
  assert.match(source, /scenario: \[n08, n09, n09-sending-ack, n09-finished-ack\]/);
  assert.ok(source.includes('ref: ${{ github.sha }}'));
  assert.ok(source.includes('persist-credentials: false'));
  assert.ok(source.includes('contents: read'));
  assert.ok(source.includes('no qualification or publication is granted'));
  assert.doesNotMatch(
    source,
    /secrets\.|upload-artifact|continue-on-error|NODE_TLS_REJECT_UNAUTHORIZED|workflow_call/
  );
  assert.match(formal, /context-recovery:\s+needs: source-gates/);
  assert.ok(formal.includes('npm run verify'));
  assert.ok(formal.includes('npm audit --audit-level=high'));
});
