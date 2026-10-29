'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createSourceHandler } = require('../scripts/lib/nsis-client-source.cjs');

function request(meta) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'original', arguments: {}, _meta: meta },
  };
}

test('source accepts Claude transport metadata without replay or endpoint authority', async () => {
  let reads = 0;
  const handle = createSourceHandler('http://127.0.0.1:1234/source', async (url) => {
    assert.equal(url.href, 'http://127.0.0.1:1234/source');
    reads++;
    return 'synthetic';
  });
  const call = request({
    'claudecode/toolUseId': 'toolu_synthetic',
    progressToken: 0,
    extension: { endpoint: 'https://invalid.example', name: 'other', arguments: { ignored: true } },
  });
  assert.equal((await handle(call)).content[0].text, 'synthetic');
  await assert.rejects(handle(call), { message: 'source_request_invalid' });
  assert.equal(reads, 1);
});

test('source rejects malformed metadata and executable inputs before reading', async () => {
  let hooks = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      hooks++;
      return 1;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        hooks++;
        return [];
      },
    }
  );
  const cycle = {};
  cycle.self = cycle;
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { nested: deep };
  const handle = createSourceHandler('http://127.0.0.1:1234', async () =>
    assert.fail('unexpected source read')
  );
  for (const meta of [
    null,
    [],
    '',
    1,
    false,
    undefined,
    { progressToken: null },
    { progressToken: {} },
    { progressToken: Infinity },
    { 'claudecode/toolUseId': 1 },
    { oversized: 'x'.repeat(16384) },
    { accessor },
    { proxy },
    cycle,
    deep,
    {
      toJSON() {
        hooks++;
        return {};
      },
    },
  ]) {
    await assert.rejects(handle(request(meta)), { message: 'source_request_invalid' });
  }
  await assert.rejects(handle(proxy), { message: 'source_request_invalid' });
  assert.equal(hooks, 0);
});

test('source metadata cannot bypass name, empty arguments, or failed fetch consumption', async () => {
  let reads = 0;
  const handle = createSourceHandler('http://127.0.0.1:1234', async () => {
    reads++;
    throw new Error('source_failed');
  });
  for (const params of [
    { ...request({}).params, name: 'other' },
    { ...request({}).params, arguments: { injected: true } },
    { ...request({}).params, task: {} },
  ])
    await assert.rejects(handle({ ...request({}), params }), { message: 'source_request_invalid' });
  await assert.rejects(handle(request({})), { message: 'source_failed' });
  await assert.rejects(handle(request({ progressToken: 'next' })), {
    message: 'source_request_invalid',
  });
  assert.equal(reads, 1);
});

test('source metadata preserves bounded JSON extensions and rejects wire-size and shape extremes', async () => {
  const base = request({ padding: '' });
  const remaining = 16384 - Buffer.byteLength(JSON.stringify(base));
  let reads = 0;
  const make = () =>
    createSourceHandler('http://127.0.0.1:1234', async () => {
      reads++;
      return 'synthetic';
    });
  assert.equal(
    (await make()(request({ padding: 'x'.repeat(remaining) }))).content[0].text,
    'synthetic'
  );
  for (const meta of [
    { padding: 'x'.repeat(remaining + 1) },
    { padding: '\u0000'.repeat(3000) },
    { extension: new Array(4096).fill(null) },
    { extension: Array(1) },
    { extension: Object.create({ inherited: true }) },
    { extension: { [Symbol('hidden')]: true } },
    { extension: Object.defineProperty({}, 'hidden', { value: true }) },
  ])
    await assert.rejects(make()(request(meta)), { message: 'source_request_invalid' });
  assert.equal(
    (
      await make()(
        request({ progressToken: 'progress', extension: [null, false, 1.5, { value: '中文' }] })
      )
    ).content[0].text,
    'synthetic'
  );
  assert.equal(reads, 2);
});

test('source snapshots request envelopes without executing accessors or coercion', async () => {
  let hooks = 0;
  const unsafe = { ...request({}) };
  Object.defineProperty(unsafe, 'params', {
    get() {
      hooks++;
      return request({}).params;
    },
  });
  const handle = createSourceHandler('http://127.0.0.1:1234', async () =>
    assert.fail('unexpected source read')
  );
  for (const value of [
    null,
    [],
    {},
    unsafe,
    { ...request({}), id: Number.MAX_SAFE_INTEGER + 1 },
    { ...request({}), params: [] },
    { ...request({}), params: 'original' },
  ]) {
    await assert.rejects(handle(value), { message: 'source_request_invalid' });
  }
  assert.equal(hooks, 0);
});

test(
  'real MCP SDK stdio source accepts Claude metadata and SDK progress token once',
  { timeout: 15000 },
  async (t) => {
    const original =
      'Synthetic original Unicode 中文🙂\r\nfixed synthetic content\r\nREQUIRED_MARKER=HPM_PRIVATE_0123456789abcdef';
    let reads = 0;
    const server = http.createServer((req, res) => {
      reads++;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/source');
      let input = '';
      req.on('data', (chunk) => {
        input += chunk;
      });
      req.on('end', () => {
        assert.equal(input, '{}');
        res.end(original);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, '../scripts/lib/nsis-client-source.cjs')],
      env: {
        HPM_FIXTURE_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/source',
        NODE_OPTIONS: '',
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const client = new Client({ name: 'hpm-source-regression', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['original']
    );
    const result = await client.callTool(
      { name: 'original', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_synthetic' } },
      undefined,
      {
        timeout: 5000,
        onprogress() {
          assert.fail('unexpected progress');
        },
      }
    );
    assert.deepEqual(result.content, [{ type: 'text', text: original }]);
    await assert.rejects(
      client.callTool({ name: 'original', arguments: {}, _meta: {} }),
      /source_request_invalid/
    );
    assert.equal(reads, 1);
    assert.equal(stderr, '');
  }
);
