'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { createNativeEvidenceV2Gateway } = require('../scripts/lib/native-evidence-v2-gateway');
const {
  createNativeBenchmarkRequestBudget,
} = require('../scripts/lib/native-benchmark-request-budget');
const frame = (v) => 'data: ' + JSON.stringify(v) + '\n\n';
const completed = () => ({
  type: 'response.completed',
  response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};
async function fixture(t, handler, remaining = 30) {
  const received = [];
  const failures = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ bytes: Buffer.concat(chunks), headers: req.headers });
      if (handler) handler(req, res);
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frame(completed()));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const report = {
    model: 'gpt-5.6-sol',
    transport: [],
    compactionChainReuseChecks: [],
    nativeCompactionCycles: 0,
  };
  const budget = createNativeBenchmarkRequestBudget({
    priorRequests: 32,
    cumulativeLimit: 32 + remaining,
  });
  const options = {
    report,
    budget,
    workload: {
      inspectInput: () => [{ index: 0, observed: true }],
      inspectReadbackInput: () => [],
    },
    upstreamPort,
    ingressKey: 'a'.repeat(48),
    testKey: 'b'.repeat(48),
    prefix: 'hpm-v2-abcdef123456',
    onFailure: (code) => failures.push(code),
  };
  const gateway = createNativeEvidenceV2Gateway(options);
  const port = await listen(gateway.server);
  t.after(() => close(gateway.server));
  const request = (body = JSON.stringify({ model: 'gpt-5.6-sol', input: [] }), extra = {}) =>
    new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/backend-api/codex/responses',
          method: 'POST',
          ...extra,
          agent: false,
          headers: {
            authorization: 'Bearer ' + options.testKey,
            'content-length': Buffer.byteLength(body),
            ...extra.headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }));
          res.on('error', () => resolve({ status: res.statusCode, failed: true }));
        }
      );
      req.on('error', () => resolve({ failed: true }));
      req.end(body);
    });
  return { report, budget, options, gateway, request, received, failures };
}

test('gateway preserves byte-for-byte native body and counts real terminals only', async (t) => {
  const f = await fixture(t);
  const body = '{ "model": "gpt-5.6-sol", "input": [] }';
  const r = await f.request(body);
  assert.equal(r.status, 200);
  assert.equal(f.received[0].bytes.toString(), body);
  assert.equal(f.received[0].headers.authorization, 'Bearer ' + f.options.ingressKey);
  assert.equal(f.received[0].headers['x-request-id'], 'hpm-v2-abcdef123456-1');
  assert.equal(f.report.transport[0].responseCompletedEvents, 1);
  assert.equal(f.gateway.inspect().exactEvidenceInputReplies, 1);
  assert.equal(f.budget.inspect().reservedRequests, 1);
  assert.deepEqual(f.failures, []);
});
test('concurrent requests cannot both consume the final allowance', async (t) => {
  const f = await fixture(
    t,
    (req, res) =>
      setTimeout(() => {
        res.writeHead(200);
        res.end(frame(completed()));
      }, 20),
    1
  );
  const r = await Promise.all([f.request(), f.request()]);
  assert.deepEqual(r.map((r) => r.status).sort(), [200, 429]);
  assert.equal(f.received.length, 1);
  assert.equal(f.report.transport.length, 1);
  assert.equal(f.budget.inspect().reservedRequests, 1);
});
test('invalid auth/method/path/origin refuse before any provider forwarding and then stop', async (t) => {
  for (const extra of [
    { method: 'GET' },
    { path: '/other' },
    { headers: { authorization: 'Bearer secret' } },
    { headers: { origin: 'https://example.com' } },
  ]) {
    const f = await fixture(t);
    assert.equal((await f.request(undefined, extra)).status, 403);
    assert.equal((await f.request()).status, 503);
    assert.equal(f.received.length, 0);
    assert.equal(f.budget.inspect().reservedRequests, 0);
  }
});
test('malformed UTF-8/body/model/oversize inputs fail without quota or raw logging', async (t) => {
  for (const [body, status] of [
    [Buffer.from([255]), 400],
    ['{secret', 400],
    ['null', 409],
    [JSON.stringify({ model: 'other', input: [] }), 409],
    [JSON.stringify({ model: 'gpt-5.6-sol', input: {} }), 409],
    [Buffer.alloc(2 * 1024 * 1024 + 1), undefined],
  ]) {
    const f = await fixture(t);
    const r = await f.request(body);
    if (status) assert.equal(r.status, status);
    else assert.equal(r.failed, true);
    assert.equal(f.received.length, 0);
    assert.equal(f.budget.inspect().reservedRequests, 0);
    assert.equal(JSON.stringify(f.failures).includes('secret'), false);
  }
});
test('upstream failures/duplicates/invalid streams retain charged request and reject success', async (t) => {
  for (const [status, body] of [
    [400, '{"error":{"message":"secret"}}'],
    [200, frame(completed()) + frame(completed())],
    [200, ''],
    [200, 'data: {bad}\n\n'],
  ]) {
    const f = await fixture(t, (req, res) => {
      res.writeHead(status);
      res.end(body);
    });
    await f.request();
    assert.equal(f.report.transport.length, 1);
    assert.equal(f.budget.inspect().reservedRequests, 1);
    assert.ok(f.failures.length > 0);
    assert.equal(JSON.stringify(f.report).includes('secret'), false);
  }
});
test('native checkpoint reuse observation keeps opaque content in memory', async (t) => {
  const checkpoint = { type: 'compaction', encrypted_content: 'opaque-secret' };
  const f = await fixture(t, (req, res) => {
    res.writeHead(200);
    res.end(frame({ type: 'response.output_item.done', item: checkpoint }) + frame(completed()));
  });
  await f.request(
    JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'compaction_trigger' }] })
  );
  await f.request(
    JSON.stringify({ model: 'gpt-5.6-sol', input: [checkpoint, { type: 'compaction_trigger' }] })
  );
  assert.equal(f.report.nativeCompactionCycles, 2);
  assert.equal(f.report.nativeCheckpointReused, true);
  assert.equal(f.report.nativeCheckpointItemEqual, true);
  assert.deepEqual(f.report.compactionChainReuseChecks, [true]);
  assert.equal(JSON.stringify(f.report).includes('opaque-secret'), false);
});
test('checkpoint equality cannot stay green after a later change, or recover after a mismatch', async (t) => {
  const checkpoint = { type: 'compaction', encrypted_content: 'opaque-secret', id: 'synthetic' };
  const f = await fixture(t, (req, res) => {
    res.writeHead(200);
    res.end(frame({ type: 'response.output_item.done', item: checkpoint }) + frame(completed()));
  });
  await f.request(
    JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'compaction_trigger' }] })
  );
  await f.request(JSON.stringify({ model: 'gpt-5.6-sol', input: [checkpoint] }));
  assert.equal(f.report.nativeCheckpointItemEqual, true);
  await f.request(
    JSON.stringify({
      model: 'gpt-5.6-sol',
      input: [{ ...checkpoint, 'secret-private-field': 'secret-value' }],
    })
  );
  assert.equal(f.report.nativeCheckpointItemEqual, false);
  assert.equal(f.report.transport[2].checkpointReuse.addedOtherFields, 1);
  assert.deepEqual(f.report.transport[2].checkpointReuse.changedKnownFields, []);
  await f.request(JSON.stringify({ model: 'gpt-5.6-sol', input: [checkpoint] }));
  assert.equal(f.report.transport[3].checkpointReuse.exactItemEqual, true);
  assert.equal(f.report.nativeCheckpointItemEqual, false);
  assert.equal(JSON.stringify(f.report).includes('secret'), false);
});

test('checkpoint mismatch labels accumulate rather than being erased by a later matching input', async (t) => {
  const checkpoint = { type: 'compaction', encrypted_content: 'opaque-secret', id: 'synthetic' };
  const f = await fixture(t, (req, res) => {
    res.writeHead(200);
    res.end(frame({ type: 'response.output_item.done', item: checkpoint }) + frame(completed()));
  });
  await f.request(
    JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'compaction_trigger' }] })
  );
  await f.request(
    JSON.stringify({ model: 'gpt-5.6-sol', input: [{ ...checkpoint, id: 'different' }] })
  );
  await f.request(JSON.stringify({ model: 'gpt-5.6-sol', input: [checkpoint] }));
  assert.equal(f.report.nativeCheckpointItemEqual, false);
  assert.deepEqual(f.report.checkpointChangedFieldNames, ['id']);
  assert.deepEqual(f.report.transport[2].checkpointReuse.changedKnownFields, []);
});

test('upstream disconnect/connection failure never produces terminal proof', async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200);
    res.flushHeaders();
    res.destroy();
  });
  await f.request();
  assert.ok(f.failures.length > 0);
  assert.equal(f.report.transport[0].responseCompletedEvents, 0);
  const g = await fixture(t);
  g.options.upstreamPort = 1;
  // Recreate only the test gateway, not a paid run.
  const gateway = createNativeEvidenceV2Gateway(g.options);
  const port = await listen(gateway.server);
  t.after(() => close(gateway.server));
  assert.equal((await g.request(undefined, { port })).status, 502);
  assert.ok(g.failures.includes('native_v2_forward_failed'));
});
test('gateway options reject hostile accessors and invalid capabilities', () => {
  let invoked = 0;
  const hostile = Object.defineProperty({}, 'report', {
    enumerable: true,
    get() {
      invoked++;
      return null;
    },
  });
  for (const options of [hostile, null, [], {}, { upstreamPort: 0 }])
    assert.throws(() => createNativeEvidenceV2Gateway(options));
  assert.equal(invoked, 0);
});

test('partial stream diagnostics and response header classes stay content-free', async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-private-header': 'secret' });
    res.end(frame(completed()) + 'data: {secret}\n\n');
  });
  await f.request();
  const row = f.report.transport[0];
  assert.equal(row.responseCompletedEvents, 1);
  assert.equal(row.responseMediaType, 'event-stream');
  assert.equal(row.responseEncoding, 'identity');
  assert.equal(row.observationFailureReason, 'invalid_event_json');
  assert.ok(row.responseBytes > 0);
  assert.equal(JSON.stringify(f.report).includes('secret'), false);
  const g = await fixture(t, (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await g.request();
  assert.equal(g.report.transport[0].responseMediaType, 'json');
});
