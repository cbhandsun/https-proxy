'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTianxiBridgeServer } = require('../lib/proxy/tianxi-bridge-server');

async function withServer(runtime, action, options = {}) {
  const records = [];
  const bridge = createTianxiBridgeServer({
    runtime,
    token: options.token || '',
    onRequest: (record) => records.push(record),
  });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  try {
    await action({ url, records });
  } finally {
    await bridge.close();
  }
}

test('Tianxi bridge health, auth and model listing stay loopback/browser safe', async () => {
  await withServer(
    {
      name: 'test',
      models: ['tianxi/super', 'super'],
      sendResponses: async () => ({ frames: [] }),
    },
    async ({ url }) => {
      const health = await (await fetch(url + '/health')).json();
      assert.equal(health.ok, true);
      assert.equal(health.upstream, 'tianxi');
      assert.equal((await fetch(url + '/v1/models')).status, 401);
      assert.equal(
        (await fetch(url + '/v1/models', { headers: { origin: 'https://evil.example' } })).status,
        403
      );
      const models = await (
        await fetch(url + '/v1/models', { headers: { authorization: 'Bearer local-secret' } })
      ).json();
      assert.deepEqual(
        models.data.map((model) => model.id),
        ['tianxi/super', 'super']
      );
    },
    { token: 'local-secret' }
  );
});

test('Tianxi bridge validates Responses payload and returns frames without logging prompt text', async () => {
  let received;
  await withServer(
    {
      name: 'test-runtime',
      sendResponses: async (payload) => {
        received = payload;
        return {
          frames: [
            { type: 'task_output', data: { content_type: 'text', content: 'ok' } },
            { type: 'task_status', data: { status: 'COMPLETED' } },
          ],
        };
      },
    },
    async ({ url, records }) => {
      const good = await fetch(url + '/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'super',
          input: 'SECRET user prompt',
          stream: true,
          chat: { messages: [{ role: 'user', content: 'hello' }] },
        }),
      });
      assert.equal(good.status, 200);
      const body = await good.json();
      assert.equal(body.frames[0].data.content, 'ok');
      assert.equal(received.model, 'super');
      assert.equal(received.stream, true);
      assert.ok(!JSON.stringify(records).includes('SECRET user prompt'));
      assert.equal(
        (
          await fetch(url + '/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: '', input: 'x' }),
          })
        ).status,
        400
      );
      assert.equal(
        (
          await fetch(url + '/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: '{}',
          })
        ).status,
        415
      );
      assert.equal((await fetch(url + '/missing')).status, 404);
    }
  );
});

test('Tianxi bridge converts runtime failures to sanitized API errors', async () => {
  await withServer(
    {
      name: 'broken',
      sendResponses: async () => {
        throw new Error('SECRET token expired');
      },
    },
    async ({ url }) => {
      const response = await fetch(url + '/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'super', input: 'hello' }),
      });
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.ok(text.includes('tianxi_bridge_runtime_failed'));
      assert.ok(!text.includes('SECRET'));
    }
  );
});
