const assert = require('assert');
const path = require('path');

const {
  formatCodexLocalRateLimits,
  prioritizeCodexSessionFiles,
} = require('../lib/proxy/rate-limits');

const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
const reset5h = Math.round((nowMs + 2 * 3600 * 1000) / 1000);
const resetWeek = Math.round((nowMs + 5 * 86400 * 1000) / 1000);
const resetDate = new Date(reset5h * 1000);
const expectedResetDisplay = `${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`;
const limits = formatCodexLocalRateLimits(
  {
    limit_id: 'codex',
    plan_type: 'prolite',
    primary: { used_percent: 30, window_minutes: 300, resets_at: reset5h },
    secondary: { used_percent: 14, window_minutes: 10080, resets_at: resetWeek },
  },
  nowMs
);
assert.deepStrictEqual(
  limits.map((item) => item.window),
  ['5小时', '1周']
);
assert.deepStrictEqual(
  limits.map((item) => item.percent),
  [70, 86]
);
assert.deepStrictEqual(
  limits.map((item) => item.usedPercent),
  [30, 14]
);
assert.strictEqual(limits[0].resetIn, '2h0m');
assert.strictEqual(limits[0].resetDisplay, expectedResetDisplay);
assert.strictEqual(limits[0].planType, 'prolite');

const bounded = formatCodexLocalRateLimits(
  {
    limit_id: 'codex',
    primary: { used_percent: '999', window_minutes: '999999999', resets_at: 'not-a-date' },
    secondary: { used_percent: -20, window_minutes: 0, resets_at: resetWeek },
  },
  nowMs
);
assert.strictEqual(bounded.length, 1);
assert.strictEqual(bounded[0].usedPercent, 100);
assert.strictEqual(bounded[0].remainingPercent, 0);

const current = path.join(
  'sessions',
  'rollout-2026-06-02T00-29-10-019e873c-6f4f-7f31-9826-22cd50aae934.jsonl'
);
const other = path.join(
  'sessions',
  'rollout-2026-06-02T02-41-37-019e87b5-b333-7600-bf25-f00573708191.jsonl'
);
const ordered = prioritizeCodexSessionFiles(
  [other, current],
  '019e873c-6f4f-7f31-9826-22cd50aae934'
);
assert.strictEqual(ordered[0], current);

console.log('[rate-limits.test] ok');
