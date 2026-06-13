const assert = require('assert');

const { dispatchLocalManagementRoute, routeMatches } = require('../lib/proxy/management-router');

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
