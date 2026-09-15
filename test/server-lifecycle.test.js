const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  clearProxyPidFile,
  notifyStartupPhase,
  scheduleReadyCallback,
  startProxyServers,
  writeProxyPidFile,
} = require('../lib/proxy/server-lifecycle');

assert.throws(() => startProxyServers(), /requires getRuntimeState/);
const source = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'proxy', 'server-lifecycle.js'),
  'utf8'
);
assert.ok(!source.includes('mgmt_token_hint'), 'startup logs must not expose token fragments');
assert.ok(!source.includes('openai.api_key'), 'startup logs must not print fake or real API keys');
assert.strictEqual(
  (source.match(/writeManagementTokenFile\(MGMT_PORT\)/g) || []).length,
  1,
  'the management token and its ACL must be prepared exactly once by the port owner'
);
assert.ok(
  source.includes('writeProxyPidFile(DATA_DIR)'),
  'proxy pid should be written after all ports listen'
);

const phases = [];
notifyStartupPhase((phase) => phases.push(phase), 'certificate_ready');
notifyStartupPhase(() => {
  throw new Error('observer failures must not block startup');
}, 'servers_created');
notifyStartupPhase(null, 'ports_listening');
assert.deepStrictEqual(phases, ['certificate_ready']);

let scheduledTask = null;
let calls = 0;
scheduleReadyCallback(
  () => {
    calls += 1;
  },
  (task) => {
    scheduledTask = task;
  }
);
assert.strictEqual(calls, 0);
scheduledTask();
assert.strictEqual(calls, 1);
scheduleReadyCallback(null, () => {
  throw new Error('must not schedule');
});

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hpm-server-lifecycle-'));
try {
  assert.strictEqual(writeProxyPidFile(tmpDir, 12345), true);
  const pidFile = path.join(tmpDir, '.proxy.pid');
  assert.strictEqual(fs.readFileSync(pidFile, 'utf8').trim(), '12345');
  assert.strictEqual(clearProxyPidFile(tmpDir, 67890), true);
  assert.strictEqual(fs.readFileSync(pidFile, 'utf8').trim(), '12345');
  assert.strictEqual(clearProxyPidFile(tmpDir, 12345), true);
  assert.strictEqual(fs.existsSync(pidFile), false);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('[server-lifecycle.test] ok');
