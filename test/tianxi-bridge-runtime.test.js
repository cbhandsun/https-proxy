'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AbortController } = globalThis;
const { createTianxiBridgeRuntime } = require('../lib/proxy/tianxi-bridge-runtime');

function createRuntime(options = {}) {
  const calls = {
    direct: [],
    http: [],
  };
  const runtime = createTianxiBridgeRuntime({
    env: options.env || {},
    getTianxiOfficialBridgeUrl:
      options.getTianxiOfficialBridgeUrl || (() => 'http://127.0.0.1:49305/v1/responses'),
    makeRequest:
      options.makeRequest ||
      (async (url, requestOptions, body) => {
        calls.http.push({ url, requestOptions, body });
        return {
          statusCode: 200,
          body: JSON.stringify({
            frames: [
              { type: 'task_output', data: { content_type: 'text', content: 'http-ok' } },
              { type: 'task_status', data: { status: 'COMPLETED' } },
            ],
          }),
        };
      }),
    createDirectRuntime:
      options.createDirectRuntime ||
      ((directOptions) => ({
        name: 'test-direct',
        async sendResponses(payload, context) {
          calls.direct.push({ payload, directOptions, context });
          return {
            frames: [
              { type: 'task_output', data: { content_type: 'text', content: 'direct-ok' } },
              { type: 'task_status', data: { status: 'COMPLETED' } },
            ],
          };
        },
      })),
  });
  return { calls, runtime };
}

test('Tianxi official profiles use local tac-server runtime automatically', async () => {
  const { calls, runtime } = createRuntime();
  const controller = new AbortController();
  const result = await runtime.callTianxiOfficialBridge(
    { model: 'super', input: 'SECRET user prompt' },
    {
      id: 'tianxi-official',
      protocol: 'tianxi',
      authMode: 'official-login',
      timeoutMs: 1234,
    },
    { signal: controller.signal }
  );

  assert.equal(result.bridgeUrl, 'tianxi://tac-server');
  assert.equal(result.mode, 'direct');
  assert.equal(result.frames[0].data.content, 'direct-ok');
  assert.equal(calls.direct.length, 1);
  assert.equal(calls.direct[0].directOptions.timeoutMs, 1234);
  assert.equal(calls.direct[0].context.signal, controller.signal);
  assert.equal(calls.http.length, 0);
});

test('Tianxi runtime honors explicit bridgeUrl unless direct is requested', async () => {
  const { calls, runtime } = createRuntime({
    getTianxiOfficialBridgeUrl: () => 'http://127.0.0.1:49306/v1/responses',
  });
  const controller = new AbortController();
  const result = await runtime.callTianxiOfficialBridge(
    { model: 'super', input: 'hello' },
    {
      id: 'tianxi-official',
      protocol: 'tianxi',
      bridgeUrl: 'http://127.0.0.1:49306',
    },
    { signal: controller.signal }
  );

  assert.equal(result.bridgeUrl, 'http://127.0.0.1:49306/v1/responses');
  assert.equal(result.frames[0].data.content, 'http-ok');
  assert.equal(calls.direct.length, 0);
  assert.equal(calls.http.length, 1);
  assert.equal(calls.http[0].requestOptions.signal, controller.signal);
});

test('Tianxi HTTP bridge rejects unrelated 2xx JSON without leaking request data', async () => {
  const { runtime } = createRuntime({
    env: { HPM_TIANXI_DIRECT: '0' },
    makeRequest: async () => ({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: 'SECRET bridge diagnostic sat-secret-token',
      }),
    }),
  });

  await assert.rejects(
    () =>
      runtime.callTianxiOfficialBridge(
        { model: 'super', input: 'SECRET user prompt' },
        {
          id: 'tianxi-official',
          protocol: 'tianxi',
        }
      ),
    (error) => {
      assert.equal(error.code, 'tianxi_bridge_invalid_response');
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /Invalid Tianxi bridge response payload/);
      assert.equal(String(error.message).includes('SECRET'), false);
      assert.equal(String(error.message).includes('sat-secret-token'), false);
      return true;
    }
  );
});

test('Tianxi HTTP bridge preserves explicit empty frames response', async () => {
  const { runtime } = createRuntime({
    env: { HPM_TIANXI_DIRECT: '0' },
    makeRequest: async () => ({
      statusCode: 200,
      body: JSON.stringify({ frames: [] }),
    }),
  });

  const result = await runtime.callTianxiOfficialBridge(
    { model: 'super', input: 'hello' },
    {
      id: 'tianxi-official',
      protocol: 'tianxi',
    }
  );

  assert.deepEqual(result.frames, []);
  assert.deepEqual(result.raw, { frames: [] });
});

test('Tianxi direct runtime can be disabled for HTTP bridge compatibility', async () => {
  const { calls, runtime } = createRuntime({
    env: { HPM_TIANXI_DIRECT: '0' },
  });
  await runtime.callTianxiOfficialBridge(
    { model: 'super', input: 'hello' },
    {
      id: 'tianxi-official',
      protocol: 'tianxi',
    }
  );

  assert.equal(calls.direct.length, 0);
  assert.equal(calls.http.length, 1);
});

test('Tianxi bridge runtime returns sanitized direct runtime failures', async () => {
  const { runtime } = createRuntime({
    createDirectRuntime: () => ({
      async sendResponses() {
        const err = new Error('tianxi_tac_header_unavailable');
        err.statusCode = 503;
        throw err;
      },
    }),
  });

  await assert.rejects(
    () =>
      runtime.callTianxiOfficialBridge(
        { model: 'super', input: 'SECRET user prompt' },
        { id: 'tianxi-official', protocol: 'tianxi' }
      ),
    (error) => {
      assert.match(error.message, /tianxi_tac_header_unavailable/);
      assert.equal(String(error.message).includes('SECRET user prompt'), false);
      return true;
    }
  );
});
