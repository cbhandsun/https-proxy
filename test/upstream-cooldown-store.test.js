const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizePersistedCooldown,
  readPersistedCooldowns,
  writePersistedCooldowns,
} = require('../lib/proxy/upstream-cooldown-store');

const now = Date.UTC(2026, 8, 15, 8, 0, 0);
assert.deepStrictEqual(
  normalizePersistedCooldown(
    {
      profileId: ' workbuddy-official ',
      targetModel: ' deepseek-v4.1-flash ',
      until: now + 60_000,
      source: ' upstream_reset_time ',
    },
    now
  ),
  {
    profileId: 'workbuddy-official',
    targetModel: 'deepseek-v4.1-flash',
    until: now + 60_000,
    source: 'upstream_reset_time',
  }
);
assert.strictEqual(
  normalizePersistedCooldown(
    {
      profileId: 'workbuddy-official',
      targetModel: 'deepseek-v4.1-flash',
      until: now - 1,
    },
    now
  ),
  null
);
assert.strictEqual(
  normalizePersistedCooldown({ profileId: 'workbuddy-official', until: now + 60_000 }, now),
  null
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-upstream-cooldowns-'));
const filePath = path.join(tmpDir, 'upstream-cooldowns.json');
try {
  writePersistedCooldowns(
    [
      {
        profileId: 'workbuddy-official',
        targetModel: 'deepseek-v4.1-flash',
        until: now + 60_000,
        source: 'upstream_reset_time',
      },
      {
        profileId: 'expired',
        targetModel: 'old-model',
        until: now - 1,
      },
    ],
    { filePath, now }
  );
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.cooldowns.length, 1);
  assert.strictEqual(parsed.cooldowns[0].profileId, 'workbuddy-official');
  const restored = readPersistedCooldowns({ filePath, now });
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].targetModel, 'deepseek-v4.1-flash');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('[upstream-cooldown-store.test] ok');
