const assert = require('assert');

const {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MIN_UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_TIMEOUT_MS,
  resolveUpstreamTimeout,
} = require('../lib/proxy/handlers/upstream-timeout');

assert.strictEqual(DEFAULT_UPSTREAM_TIMEOUT_MS, 120000);

// profile.timeoutMs wins over both the env var and the caller fallback.
assert.strictEqual(
  resolveUpstreamTimeout(
    { timeoutMs: 45000 },
    { fallbackMs: 600000, env: { PROXY_UPSTREAM_TIMEOUT_MS: '90000' } }
  ),
  45000
);

// Env var is the second priority.
assert.strictEqual(
  resolveUpstreamTimeout({}, { fallbackMs: 600000, env: { PROXY_UPSTREAM_TIMEOUT_MS: '90000' } }),
  90000
);

// Caller fallback preserves each entry point's historical default.
assert.strictEqual(resolveUpstreamTimeout({}, { fallbackMs: 600000, env: {} }), 600000);
assert.strictEqual(resolveUpstreamTimeout({}, { env: {} }), DEFAULT_UPSTREAM_TIMEOUT_MS);
assert.strictEqual(resolveUpstreamTimeout(undefined, { env: {} }), DEFAULT_UPSTREAM_TIMEOUT_MS);
assert.strictEqual(resolveUpstreamTimeout(null, { env: {} }), DEFAULT_UPSTREAM_TIMEOUT_MS);

// Invalid profile values fall through instead of producing NaN/0 timeouts.
for (const bad of [0, -1, 'abc', NaN, Infinity, null, undefined]) {
  assert.strictEqual(
    resolveUpstreamTimeout({ timeoutMs: bad }, { fallbackMs: 600000, env: {} }),
    600000,
    'profile timeoutMs=' + String(bad) + ' must fall back'
  );
}

// Bounds are enforced in both directions.
assert.strictEqual(resolveUpstreamTimeout({ timeoutMs: 1 }, { env: {} }), MIN_UPSTREAM_TIMEOUT_MS);
assert.strictEqual(
  resolveUpstreamTimeout({ timeoutMs: 99999999 }, { env: {} }),
  MAX_UPSTREAM_TIMEOUT_MS
);
assert.strictEqual(
  resolveUpstreamTimeout({}, { fallbackMs: 99999999, env: {} }),
  MAX_UPSTREAM_TIMEOUT_MS,
  'the caller fallback must also be bounded'
);
assert.strictEqual(
  resolveUpstreamTimeout({}, { fallbackMs: -5, env: {} }),
  DEFAULT_UPSTREAM_TIMEOUT_MS
);

// String numbers are accepted because profile values come from JSON/user input.
assert.strictEqual(resolveUpstreamTimeout({ timeoutMs: '75000' }, { env: {} }), 75000);

console.log('[upstream-timeout.test] ok');
