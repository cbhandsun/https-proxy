const assert = require('assert');
const { createRuntimeMetrics } = require('../lib/proxy/runtime-metrics');

const { metricsInstance, startupPhaseGauge } = createRuntimeMetrics();
startupPhaseGauge.set(1.25, { phase: 'management_listening' });
metricsInstance.counter('proxy_requests_total').inc();
metricsInstance.histogram('proxy_request_duration_seconds').observe(0.5);
const output = metricsInstance.render();

assert.match(output, /proxy_startup_phase_seconds\{phase="management_listening"\} 1\.25/);
assert.match(output, /proxy_requests_total 1/);
assert.match(output, /proxy_request_duration_seconds_count 1/);
assert.deepStrictEqual(
  metricsInstance.histogram('proxy_request_duration_seconds').buckets,
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
);

console.log('[runtime-metrics.test] ok');
