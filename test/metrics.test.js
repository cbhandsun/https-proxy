const assert = require('assert');
const {
  createMetrics,
  collectDefaultProcessMetrics,
  formatLabels,
  labelKey,
} = require('../lib/proxy/metrics');

// 1. Module exports
assert.strictEqual(typeof createMetrics, 'function');
assert.strictEqual(typeof collectDefaultProcessMetrics, 'function');
assert.strictEqual(typeof formatLabels, 'function');
assert.strictEqual(typeof labelKey, 'function');
console.log('[metrics.test] exports ok');

// 2. labelKey formatting
assert.strictEqual(labelKey(null), '');
assert.strictEqual(labelKey({}), '');
assert.strictEqual(labelKey({ a: '1', b: '2' }), 'a=1,b=2');
assert.strictEqual(labelKey({ msg: 'with "quote"' }), 'msg=with \\"quote\\"');
assert.strictEqual(labelKey({ path: 'C:\\foo' }), 'path=C:\\\\foo');
console.log('[metrics.test] labelKey ok');

// 3. formatLabels
assert.strictEqual(formatLabels(null), '');
assert.strictEqual(formatLabels({}), '');
assert.strictEqual(formatLabels({ a: '1' }), '{a="1"}');
assert.strictEqual(formatLabels({ a: '1', b: '2' }), '{a="1",b="2"}');
console.log('[metrics.test] formatLabels ok');

// 4. Counter basic
const m = createMetrics();
const c = m.counter('foo_total', 'foo help');
c.inc();
c.inc(5);
c.inc(2, { kind: 'a' });
assert.strictEqual(c.values.get('').count, 6);
assert.strictEqual(c.values.get('kind=a').count, 2);
const sameCounter = m.counter('foo_total');
assert.strictEqual(sameCounter, c);
sameCounter.inc();
assert.strictEqual(c.values.get('').count, 7);
console.log('[metrics.test] counter inc ok');

// 5. Gauge set/inc/dec
const g = m.gauge('bar_size', 'bar help');
g.set(10);
assert.strictEqual(g.values.get('').value, 10);
g.inc();
assert.strictEqual(g.values.get('').value, 11);
g.dec(3);
assert.strictEqual(g.values.get('').value, 8);
g.set(0, { shard: 'a' });
assert.strictEqual(g.values.get('shard=a').value, 0);
console.log('[metrics.test] gauge set/inc/dec ok');

// 6. Histogram observe
const h = m.histogram('latency_seconds', 'latency help');
h.observe(0.01);
h.observe(0.05);
h.observe(0.2);
h.observe(2);
const entry = h.values.get('');
assert.ok(entry);
assert.strictEqual(entry.count, 4);
assert.ok(entry.sum > 0);
const sameHistogram = m.histogram('latency_seconds');
assert.strictEqual(sameHistogram, h);
sameHistogram.observe(0.4);
assert.strictEqual(entry.count, 5);
console.log('[metrics.test] histogram observe ok');

// 7. Render output
const out = m.render();
assert.ok(out.includes('# HELP foo_total foo help'));
assert.ok(out.includes('# TYPE foo_total counter'));
assert.ok(out.includes('foo_total 7'));
assert.ok(out.includes('foo_total{kind="a"} 2'));
assert.ok(out.includes('# TYPE bar_size gauge'));
assert.ok(out.includes('# TYPE latency_seconds histogram'));
assert.ok(out.includes('latency_seconds_count 5'));
assert.ok(out.includes('latency_seconds_sum'));
assert.ok(out.includes('latency_seconds_bucket{le="0.01"}'));
assert.ok(out.includes('latency_seconds_bucket{le="+Inf"}'));
console.log('[metrics.test] render output ok');

// 8. Reset clears all
m.reset();
assert.strictEqual(c.values.size, 0);
assert.strictEqual(g.values.size, 0);
assert.strictEqual(h.values.size, 0);
console.log('[metrics.test] reset ok');

// 9. Default histogram buckets
const h2 = m.histogram('x_seconds', 'x help');
assert.deepStrictEqual(h2.buckets, [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
h2.observe(0.3);
const buckets = h2.values.get('').counts;
// 0.3 <= 0.5 bucket (index 6) but > 0.25 bucket (index 5)
assert.strictEqual(buckets[5], 0, '0.3 not in 0.25 bucket (0.3 > 0.25)');
assert.strictEqual(buckets[6], 1, '0.3 in 0.5 bucket (0.3 <= 0.5)');
assert.strictEqual(buckets[10], 1, '0.3 in +Inf bucket');
assert.strictEqual(h2.values.get('').count, 1);
console.log('[metrics.test] default buckets ok');

// 10. Custom buckets
const h3 = m.histogram('custom', 'x', { buckets: [1, 2, 4] });
h3.observe(0.5);
h3.observe(1.5);
h3.observe(3);
h3.observe(5);
const e3 = h3.values.get('');
assert.strictEqual(e3.counts[0], 1, '0.5 in bucket 1');
assert.strictEqual(e3.counts[1], 2, '0.5 and 1.5 in bucket 2 (cumulative)');
assert.strictEqual(e3.counts[2], 3, '0.5+1.5+3 in bucket 4 (cumulative)');
assert.strictEqual(e3.count, 4);
console.log('[metrics.test] custom buckets cumulative ok');

// 11. Invalid name throws
assert.throws(() => m.counter('1invalid', ''), /Invalid metric name/);
assert.throws(() => m.counter('has space', ''), /Invalid metric name/);
assert.throws(() => m.gauge('foo_total', ''), /Metric type mismatch/);
assert.throws(
  () => m.histogram('custom', 'x', { buckets: [1, 2, 8] }),
  /Histogram bucket mismatch/
);
console.log('[metrics.test] invalid name rejected ok');

// 12. collectDefaultProcessMetrics injects process_* and nodejs_*
const m2 = createMetrics();
const stop = collectDefaultProcessMetrics(m2);
const out2 = m2.render();
assert.ok(out2.includes('process_resident_memory_bytes'));
assert.ok(out2.includes('nodejs_heap_size_total_bytes'));
assert.ok(out2.includes('process_uptime_seconds'));
assert.ok(out2.includes('nodejs_version_info'));
stop();
console.log('[metrics.test] process metrics collected ok');

// 13. Label escaping in render
const c2 = m.counter('escape_test', 'help');
c2.inc(1, { msg: 'line1\nline2' });
const out3 = m.render();
assert.ok(out3.includes('escape_test{msg="line1\\nline2"} 1'));
console.log('[metrics.test] label escape in render ok');

console.log('[metrics.test] ok');
