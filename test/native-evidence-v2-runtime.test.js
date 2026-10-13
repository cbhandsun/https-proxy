'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  nativeEvidenceV2Routes,
  stopNativeEvidenceChild,
} = require('../scripts/lib/native-evidence-v2-runtime');

test('route proof is bounded, fresh-prefix-only and exact official profile/count', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-v2-route-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  const prefix = 'hpm-v2-abcdef123456';
  assert.equal(nativeEvidenceV2Routes(file, prefix, 1).providerRouteVerified, false);
  const row = (id, profileId = 'openai-official') =>
    JSON.stringify({ kind: 'route', reqId: id, profileId });
  fs.writeFileSync(file, row(prefix + '-1') + '\n{partial\n' + row('other-1'));
  assert.equal(nativeEvidenceV2Routes(file, prefix, 1).providerRouteVerified, true);
  assert.equal(nativeEvidenceV2Routes(file, prefix, 2).providerRouteVerified, false);
  for (const body of [
    row(prefix + '-1', 'wrong'),
    row(prefix + '-2'),
    row(prefix + '-0'),
    'x'.repeat(2 * 1024 * 1024 + 1),
  ]) {
    fs.writeFileSync(file, body);
    assert.equal(nativeEvidenceV2Routes(file, prefix, 1).providerRouteVerified, false);
  }
});
test('child termination waits for actual exit, and preserves absent/already exited processes', async () => {
  assert.equal(await stopNativeEvidenceChild(null), true);
  assert.equal(await stopNativeEvidenceChild({ exitCode: 0 }), true);
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = { writable: true, end() {} };
  child.kill = () => setImmediate(() => child.emit('exit'));
  assert.equal(await stopNativeEvidenceChild(child), true);
});
test('CLI cannot implicitly run provider calls or accept retries/extra arms', () => {
  for (const args of [[], ['control'], ['--live', 'retry'], ['--live', 'control', '--retry']]) {
    const r = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../scripts/probe-native-evidence-v2.js'), ...args],
      { encoding: 'utf8' }
    );
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).code, 'native_v2_cli_failed');
  }
});
