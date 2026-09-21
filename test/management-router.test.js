const assert = require('assert');

const {
  ROUTES,
  dispatchLocalManagementRoute,
  routeMatches,
} = require('../lib/proxy/management-router');

{
  const route = { method: 'GET', paths: ['/v1/local/auth/rate-limits'], match: 'prefix' };
  assert.strictEqual(
    routeMatches(route, 'GET', '/v1/local/auth/rate-limits?profileId=codex'),
    true
  );
  assert.strictEqual(routeMatches(route, 'GET', '/v1/local/auth/rate-limits/codex'), true);
  assert.strictEqual(routeMatches(route, 'POST', '/v1/local/auth/rate-limits'), false);
  assert.strictEqual(
    routeMatches(
      { method: 'GET', paths: ['/v1/local/usage/report'] },
      'GET',
      '/v1/local/usage/report'
    ),
    true
  );
  assert.strictEqual(
    routeMatches(
      { method: 'GET', paths: ['/v1/local/usage/report'] },
      'GET',
      '/v1/local/usage/report/extra'
    ),
    false
  );
}

{
  const calls = [];
  const req = {};
  const res = {};
  const handled = dispatchLocalManagementRoute({
    method: 'GET',
    pathname: '/v1/local/health',
    req,
    res,
    handlers: {
      health: (nextReq, nextRes) => calls.push([nextReq === req, nextRes === res]),
    },
  });
  assert.strictEqual(handled, true);
  assert.deepStrictEqual(calls, [[true, true]]);
  assert.strictEqual(
    dispatchLocalManagementRoute({
      method: 'GET',
      pathname: '/v1/messages',
      req,
      res,
      handlers: {},
    }),
    false
  );
}

{
  let called = false;
  assert.strictEqual(
    dispatchLocalManagementRoute({
      method: 'POST',
      pathname: '/v1/local/diagnostics/ingress-probe',
      req: {},
      res: {},
      handlers: {
        ingressProbe() {
          called = true;
        },
      },
    }),
    true
  );
  assert.strictEqual(called, true);
}

{
  const calls = [];
  const req = {};
  const res = {};
  assert.strictEqual(
    dispatchLocalManagementRoute({
      method: 'GET',
      pathname: '/v1/local/health',
      req,
      res,
      handlers: {
        handleLocalHealthRequest: (nextReq, nextRes) =>
          calls.push([nextReq === req, nextRes === res]),
      },
    }),
    true
  );
  assert.deepStrictEqual(calls, [[true, true]]);
}

{
  // Regression: a bare '/metrics' alias used to be registered. Because local
  // management dispatch happens before entry authentication, every entry port
  // answered GET /metrics with unauthenticated, CORS-open process metrics.
  const metricsRoute = { method: 'GET', paths: ['/v1/local/metrics', '/local/metrics'] };
  assert.strictEqual(routeMatches(metricsRoute, 'GET', '/v1/local/metrics'), true);
  assert.strictEqual(routeMatches(metricsRoute, 'GET', '/local/metrics'), true);
  assert.strictEqual(
    routeMatches(metricsRoute, 'GET', '/metrics'),
    false,
    'the management router must not expose a bare /metrics alias'
  );

  let metricsHandled = false;
  assert.strictEqual(
    dispatchLocalManagementRoute({
      method: 'GET',
      pathname: '/metrics',
      req: {},
      res: {},
      handlers: {
        metrics() {
          metricsHandled = true;
        },
      },
    }),
    false,
    'bare /metrics must fall through to entry authentication'
  );
  assert.strictEqual(metricsHandled, false);

  assert.strictEqual(
    dispatchLocalManagementRoute({
      method: 'GET',
      pathname: '/v1/local/metrics',
      req: {},
      res: {},
      handlers: {
        metrics() {
          metricsHandled = true;
        },
      },
    }),
    true
  );
  assert.strictEqual(metricsHandled, true);

  const managementPaths = ROUTES.flatMap((route) => route.paths);
  assert.ok(
    managementPaths.every(
      (routePath) => routePath.startsWith('/v1/local/') || routePath.startsWith('/local/')
    ),
    'every management route must stay inside the authenticated management prefixes'
  );
}

assert.throws(
  () =>
    dispatchLocalManagementRoute({
      method: 'GET',
      pathname: '/v1/local/health',
      req: {},
      res: {},
      handlers: {},
    }),
  /Missing local management handler: health/
);

console.log('[management-router.test] ok');
