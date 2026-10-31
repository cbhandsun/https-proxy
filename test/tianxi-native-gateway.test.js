'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { AbortController } = globalThis;
const {
  createTianxiNativeGatewaySessions,
  MODELS,
} = require('../scripts/lib/tianxi-native-gateway-sessions');
const { createTianxiNativeGateway } = require('../scripts/lib/tianxi-native-gateway');
const { createTianxiNativeCatalog } = require('../scripts/lib/tianxi-native-responses-catalog');
const { TIANXI_SDK_MODELS } = require('../lib/proxy/tianxi-sdk-models');
const body = {
  model: MODELS[0],
  stream: false,
  input: [{ role: 'user', content: 'first' }],
  tools: [
    {
      type: 'custom',
      name: 'exec',
      namespace: 'functions',
      description: 'native',
      format: { type: 'text' },
    },
  ],
};
const run = async (options) => {
  const output = await options.onCall(
    options.tools[0].name,
    { input: 'native source' },
    { signal: options.signal }
  );
  return { finalText: output.content[0].text };
};
const output = (call, value = 'success') => ({
  type: 'custom_tool_call_output',
  call_id: call.call_id,
  output: value,
});
function continued(call, value) {
  return { ...body, input: [...body.input, call, output(call, value)] };
}

test('all current Tianxi models share the native tool protocol and preserve selected upstream model IDs', async () => {
  const selected = [];
  const sessions = createTianxiNativeGatewaySessions({
    run: async (options) => {
      selected.push(options.modelId);
      return run(options);
    },
  });
  try {
    assert.deepEqual([...MODELS].sort(), TIANXI_SDK_MODELS.map((model) => model.alias).sort());
    assert.equal(new Set(MODELS).size, 12);
    for (const model of TIANXI_SDK_MODELS) {
      const request = { ...body, model: model.alias };
      const call = (await sessions.request(request, 'owner')).output[0];
      const result = await sessions.request(
        { ...request, input: [...request.input, call, output(call, model.modelId)] },
        'owner'
      );
      assert.equal(call.namespace, 'functions');
      assert.equal(call.input, 'native source');
      assert.equal(result.output_text, model.modelId);
    }
    assert.deepEqual(
      selected,
      TIANXI_SDK_MODELS.map((model) => model.modelId)
    );
  } finally {
    await sessions.close();
  }
});

test('gateway isolates interleaved tasks, supports retries, ownership and model checks', async () => {
  let runs = 0;
  const sessions = createTianxiNativeGatewaySessions({
    run: (options) => {
      runs++;
      return run(options);
    },
  });
  try {
    const [first, second] = await Promise.all([
      sessions.request(body, 'a'),
      sessions.request(body, 'b'),
    ]);
    const a = first.output[0],
      b = second.output[0];
    assert.deepEqual(await sessions.request(body, 'a'), first);
    assert.notEqual(a.call_id, b.call_id);
    await assert.rejects(sessions.request(continued(a), 'b'), /continuation_not_found/);
    await assert.rejects(
      sessions.request({ ...continued(a), model: MODELS[1] }, 'a'),
      /continuation_not_found/
    );
    await assert.rejects(
      sessions.request(
        { ...continued(a), tools: [{ ...body.tools[0], description: 'changed' }] },
        'a'
      ),
      /catalog_changed/
    );
    const result = await sessions.request(continued(a, 'A'), 'a');
    const replay = await sessions.request(continued(a, 'A'), 'a');
    assert.deepEqual(replay, result);
    assert.equal(result.output_text, 'A');
    assert.equal((await sessions.request(continued(b, 'B'), 'b')).output_text, 'B');
    await assert.rejects(sessions.request(continued(a, 'tampered'), 'a'), /output_invalid/);
    assert.equal(runs, 2);
  } finally {
    await sessions.close();
  }
  await assert.rejects(sessions.request(body, 'a'), /gateway_closed/);
});

test('new turns preserve the labelled prior transcript without replaying old tools', async () => {
  const prompts = [];
  const sessions = createTianxiNativeGatewaySessions({
    run: async (options) => {
      prompts.push(options.prompt);
      return run(options);
    },
  });
  try {
    const initial = await sessions.request(body, 'a');
    const call = initial.output[0];
    const final = await sessions.request(continued(call, 'untrusted tool data'), 'a');
    const next = {
      ...body,
      input: [
        ...continued(call, 'untrusted tool data').input,
        ...final.output,
        { role: 'user', content: 'second' },
      ],
    };
    const followup = await sessions.request(next, 'a');
    assert.equal(prompts.length, 2);
    const transcript = JSON.parse(prompts[1]);
    assert.equal(transcript.at(-1).content, 'second');
    assert.equal(transcript[2].output, 'untrusted tool data');
    assert.equal(transcript[3].role, 'assistant');
    assert.notEqual(followup.output[0].call_id, call.call_id);
    const secondFinal = await sessions.request(
      {
        ...next,
        input: [...next.input, followup.output[0], output(followup.output[0], 'second success')],
      },
      'a'
    );
    assert.equal(secondFinal.output_text, 'second success');
    assert.throws(() => createTianxiNativeCatalog(next), /initial_history_unsupported/);
    const catalog = createTianxiNativeCatalog(next, { allowHistory: true });
    assert.ok(!catalog.systemPrompt.includes('untrusted tool data'));
    assert.match(catalog.systemPrompt, /untrusted historical data/);
  } finally {
    await sessions.close();
  }
});

test('native loaded-only catalogs omit the optional top-level tools field', async () => {
  const sessions = createTianxiNativeGatewaySessions({ run });
  const request = {
    model: body.model,
    stream: false,
    input: [{ type: 'additional_tools', role: 'developer', tools: body.tools }, ...body.input],
  };
  try {
    const call = (await sessions.request(request, 'a')).output[0];
    const final = await sessions.request(
      { ...request, input: [...request.input, call, output(call)] },
      'a'
    );
    assert.equal(final.output_text, 'success');
  } finally {
    await sessions.close();
  }
});

test('invalid, empty, oversized, compacted and unsupported requests fail before provider dispatch', async () => {
  let runs = 0;
  const sessions = createTianxiNativeGatewaySessions({
    run: async () => {
      runs++;
      return { finalText: 'unexpected' };
    },
  });
  for (const invalid of [
    null,
    {},
    { ...body, model: 'other' },
    { ...body, stream: null },
    { ...body, input: [] },
    { ...body, input: Array(4097).fill(body.input[0]) },
    { ...body, previous_response_id: 'resp_old' },
    { ...body, background: true },
    { ...body, truncation: 'auto' },
    { ...body, input: [{ type: 'compaction', encrypted_content: 'x' }] },
    { ...body, input: [{ role: 'user', content: 'x'.repeat(32769) }] },
    {
      ...body,
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'image', text: 'x' }] }],
    },
  ]) {
    await assert.rejects(sessions.request(invalid, 'a'));
  }
  await assert.rejects(sessions.request(body, ''));
  await assert.rejects(sessions.request(body, 'x'.repeat(257)));
  assert.equal(runs, 0);
  await sessions.close();
});

test('capacity, expiry, cancellation and failure release active slots without changing limits', async () => {
  let time = 0;
  const sessions = createTianxiNativeGatewaySessions({
    run,
    now: () => time,
    maxActive: 1,
    ttlMs: 10,
  });
  const first = await sessions.request(body, 'a');
  await assert.rejects(sessions.request(body, 'b'), /capacity/);
  time = 11;
  sessions.sweep();
  await assert.rejects(sessions.request(continued(first.output[0]), 'a'), /continuation_not_found/);
  const controller = new AbortController();
  controller.abort();
  const aborted = await sessions.request(body, 'a', controller.signal);
  assert.equal(aborted.status, 'failed');
  await sessions.close();
  const failure = createTianxiNativeGatewaySessions({
    run: async () => {
      throw new Error('secret credentials');
    },
  });
  const result = await failure.request(body, 'a');
  assert.equal(result.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('secret credentials'));
  await failure.close();
});

function send(
  port,
  {
    method = 'POST',
    route = '/v1/responses',
    token = 'a'.repeat(64),
    raw = JSON.stringify(body),
    headers = {},
  } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: { authorization: 'Bearer ' + token, ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on('error', reject);
    req.end(method === 'POST' ? raw : undefined);
  });
}
test('authenticated loopback gateway serves health/catalog and rejects origins, malformed bodies and unavailable endpoints', async () => {
  let runs = 0;
  assert.throws(() => createTianxiNativeGateway({ token: 'bad' }), /token_invalid/);
  const gateway = createTianxiNativeGateway({
    token: 'a'.repeat(64),
    run: async () => {
      runs++;
      return { finalText: 'done' };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const port = gateway.server.address().port;
  try {
    assert.equal((await send(port, { token: 'wrong' })).status, 401);
    assert.equal((await send(port, { headers: { origin: 'https://evil.example' } })).status, 401);
    assert.equal((await send(port, { method: 'GET', route: '/health' })).status, 200);
    const models = JSON.parse(
      (await send(port, { method: 'GET', route: '/v1/models?client_version=0.160.1' })).data
    );
    assert.deepEqual(
      models.data.map((item) => item.id),
      MODELS
    );
    assert.equal((await send(port, { route: '/v1/responses/compact' })).status, 404);
    assert.equal((await send(port, { raw: '{' })).status, 400);
    assert.equal((await send(port, { raw: '"secret"' })).status, 400);
    assert.equal((await send(port, { headers: { 'content-encoding': 'gzip' } })).status, 400);
    assert.equal(
      (await send(port, { raw: JSON.stringify({ ...body, background: true }) })).status,
      400
    );
    assert.equal((await send(port, { raw: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 400);
    const stream = await send(port, { raw: JSON.stringify({ ...body, stream: true }) });
    assert.equal(stream.status, 200);
    assert.match(stream.data, /response.completed/);
    assert.equal((await send(port)).status, 200);
    assert.equal(runs, 2);
  } finally {
    await gateway.close();
    await gateway.close();
  }
});

test('compaction_trigger produces hpm1 encrypted checkpoint and subsequent turn expands hpm1/magpie1 compaction items', async () => {
  const prompts = [];
  const sessions = createTianxiNativeGatewaySessions({
    run: async (options) => {
      prompts.push(options.prompt);
      return run(options);
    },
  });
  try {
    const compactReq = {
      ...body,
      input: [
        { role: 'user', content: 'Audit the repository security and performance' },
        { role: 'assistant', content: 'I inspected package.json and found 2 outdated deps.' },
        { type: 'compaction_trigger' },
      ],
    };
    const compactRes = await sessions.request(compactReq, 'owner');
    assert.equal(compactRes.status, 'completed');
    assert.equal(compactRes.output.length, 1);
    const compItem = compactRes.output[0];
    assert.equal(compItem.type, 'compaction');
    assert.match(compItem.encrypted_content, /^hpm1:/);

    // Resume after compaction with the hpm1 item + a follow-up user turn
    const resumedReq = {
      ...body,
      input: [
        compItem,
        { role: 'user', content: 'Now run the test suite.' },
      ],
    };
    const call = (await sessions.request(resumedReq, 'owner')).output[0];
    assert.equal(call.name, 'exec');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Audit the repository security and performance/);
    assert.match(prompts[0], /Now run the test suite/);
  } finally {
    await sessions.close();
  }
});

test('recoverOrphanContinuations cold-starts from full transcript after restart and reclaims stale owner slots', async () => {
  let runs = 0;
  const sessions = createTianxiNativeGatewaySessions({
    run: async (options) => {
      runs++;
      return { finalText: 'recovered:' + runs };
    },
    maxActive: 1,
    recoverOrphanContinuations: true,
  });
  try {
    // Simulate a continuation whose call_id is unknown (e.g. proxy restarted mid-audit)
    const orphanContinuation = {
      ...body,
      input: [
        { role: 'user', content: 'run audit' },
        {
          id: 'ct_1',
          call_id: 'call_tianxi_native_orphan123',
          type: 'custom_tool_call',
          status: 'completed',
          name: 'exec',
          namespace: 'functions',
          input: 'npm test',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_tianxi_native_orphan123',
          output: 'all tests passed',
        },
      ],
    };
    const res = await sessions.request(orphanContinuation, 'owner');
    assert.equal(res.status, 'completed');
    assert.equal(res.output_text, 'recovered:1');
    assert.ok(res.usage && res.usage.total_tokens > 0);
  } finally {
    await sessions.close();
  }
});


test('mid-session continuation failure seamlessly failovers to a fresh session when recoverOrphanContinuations is enabled', async () => {
  let runs = 0;
  const sessions = createTianxiNativeGatewaySessions({
    run: async ({ tools, onCall, signal }) => {
      runs++;
      const exec = tools.find((tool) => tool.name.startsWith('exec_'));
      if (runs === 1) {
        await onCall(exec.name, { input: 'const r = await tools.write_stdin({session_id: 1}); text(r);' }, { signal });
        throw new Error('tianxi_sdk_mcp_protocol_failed');
      }
      return { finalText: 'seamless-failover-ok' };
    },
    maxActive: 1,
    recoverOrphanContinuations: true,
  });
  try {
    const initial = await sessions.request(body, 'owner');
    assert.equal(initial.status, 'completed');
    const call = initial.output[0];
    assert.equal(call.name, 'exec');

    const contBody = {
      ...body,
      input: [
        ...body.input,
        call,
        {
          type: 'custom_tool_call_output',
          call_id: call.call_id,
          output: [
            { type: 'input_text', text: 'Script completed\nOutput:\n' },
            { type: 'input_text', text: 'x'.repeat(30000) },
          ],
        },
      ],
    };
    const resumed = await sessions.request(contBody, 'owner');
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.output_text, 'seamless-failover-ok');
    assert.equal(runs, 2);
  } finally {
    await sessions.close();
  }
});
