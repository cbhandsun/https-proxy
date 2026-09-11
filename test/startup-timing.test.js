const assert = require('assert');
const { createStartupTiming } = require('../lib/proxy/startup-timing');

let current = 1_000_000_000n;
const timing = createStartupTiming({ now: () => current });
current += 250_000_000n;
assert.strictEqual(timing.mark('config_loaded'), 0.25);
current += 250_000_000n;
assert.strictEqual(timing.mark('config_loaded'), 0.25, 'phase marks must be idempotent');
assert.deepStrictEqual(timing.snapshot(), { config_loaded: 0.25 });

const observations = [];
timing.observe({
  set(value, labels) {
    observations.push({ value, labels });
  },
});
assert.deepStrictEqual(observations, [{ value: 0.25, labels: { phase: 'config_loaded' } }]);
assert.throws(() => timing.mark('../secret'), /Invalid startup phase/);
assert.throws(() => timing.observe(null), /requires a gauge/);
assert.throws(
  () => createStartupTiming({ now: () => Date.now() }),
  /must return bigint nanoseconds/
);

console.log('[startup-timing.test] ok');
