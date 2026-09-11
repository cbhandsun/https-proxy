'use strict';

const { createMetrics, collectDefaultProcessMetrics } = require('./metrics');

function createRuntimeMetrics() {
  const metricsInstance = createMetrics();
  collectDefaultProcessMetrics(metricsInstance);
  const startupPhaseGauge = metricsInstance.gauge(
    'proxy_startup_phase_seconds',
    'Elapsed startup time when each initialization phase completed'
  );
  metricsInstance.counter('proxy_requests_total', 'Total number of proxy requests received');
  metricsInstance.counter('proxy_errors_total', 'Total number of proxy request errors');
  metricsInstance.counter('proxy_config_reloads_total', 'Total number of config hot-reloads');
  metricsInstance.counter('proxy_route_cache_total', 'Route resolution cache events');
  metricsInstance.histogram('proxy_request_duration_seconds', 'Proxy request duration in seconds', {
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  });
  metricsInstance.gauge(
    'proxy_active_profile_id',
    'Currently active profile id (set to 1 for whichever is active)'
  );
  return { metricsInstance, startupPhaseGauge };
}

module.exports = { createRuntimeMetrics };
