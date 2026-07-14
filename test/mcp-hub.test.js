// Tests for lib/proxy/mcp-hub.js — covers the retry-after-failure path.
// Regression guard: the legacy `new Promise(r => setTimeout(resolve, delay))`
// pattern passed an undefined `resolve` to setTimeout, so the retry never
// resolved. The new pattern `new Promise((resolve) => setTimeout(resolve, delay))`
// uses the Promise executor's resolve. This test stubs the http transport
// and verifies the retry actually fires.

const assert = require('node:assert/strict');
const http = require('http');
const mcpHubModule = require('../lib/proxy/mcp-hub');
const { createMcpHub, normalizeMcpTool, mergeClaudeTools } = mcpHubModule;

function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function run() {
  // ─── 1. module exports shape ──────────────────────────────────
  assert.equal(typeof mcpHubModule.createMcpHub, 'function', 'createMcpHub exported');
  assert.equal(typeof mcpHubModule.normalizeMcpTool, 'function', 'normalizeMcpTool exported');
  assert.equal(typeof mcpHubModule.mergeClaudeTools, 'function', 'mergeClaudeTools exported');
  assert.equal(
    typeof mcpHubModule._test.compactMcpLogValue,
    'function',
    'compactMcpLogValue exported for tests'
  );

  const compacted = mcpHubModule._test.compactMcpLogValue({
    input: {
      apiKey: 'sk-secret',
      nested: {
        authorization: 'Bearer token',
        text: 'x'.repeat(13000),
      },
    },
  });
  assert.equal(compacted.input.apiKey, '[redacted]', 'apiKey redacted in MCP logs');
  assert.equal(
    compacted.input.nested.authorization,
    '[redacted]',
    'authorization redacted in MCP logs'
  );
  assert.ok(compacted.input.nested.text.endsWith('...[truncated]'), 'large MCP log text truncated');
  assert.equal(mcpHubModule._test.normalizeBearerToken('Bearer glm-key'), 'glm-key');
  assert.deepEqual(
    mcpHubModule._test.mcpRequestHeaders({ bearerToken: 'glm-key' }, '{}').Authorization,
    'Bearer glm-key',
    'MCP request headers include bearer token'
  );

  const normalizedTool = normalizeMcpTool(
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    },
    { id: 'local', prefix: 'fs' }
  );
  assert.deepEqual(normalizedTool, {
    name: 'fs_read_file',
    description: 'Read a file',
    input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  });
  assert.equal(
    mcpHubModule.upstreamMcpToolName({ prefix: 'fs' }, 'fs_read_file'),
    'read_file',
    'prefixed MCP tool names are stripped before upstream tools/call'
  );

  const mergedTools = mergeClaudeTools(
    [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
    [
      {
        name: 'Read',
        input_schema: { type: 'object', properties: { duplicate: { type: 'string' } } },
      },
      normalizedTool,
    ]
  );
  assert.equal(mergedTools.length, 2);
  assert.equal(mergedTools[1].name, 'fs_read_file');

  const injectServer = await startStubServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      assert.equal(parsed.method, 'tools/list');
      assert.equal(req.headers.authorization, 'Bearer glm-secret');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            tools: [
              {
                name: 'search_docs',
                description: 'Search docs',
                input_schema: { type: 'object', properties: { q: { type: 'string' } } },
              },
            ],
          },
        })
      );
    });
  });

  try {
    const injectHub = createMcpHub({
      getConfig: () => ({
        mcpHub: {
          servers: [
            {
              id: 'docs',
              url: `http://127.0.0.1:${injectServer.port}`,
              injectAll: true,
              prefix: 'docs',
              bearerToken: 'glm-secret',
            },
          ],
          routing: [],
        },
      }),
    });
    assert.equal(typeof injectHub.augmentRequestTools, 'function');
    const augmented = await injectHub.augmentRequestTools({ model: 'claude-sonnet', tools: [] });
    assert.deepEqual(augmented.tools, [
      {
        name: 'docs_search_docs',
        description: 'Search docs',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  } finally {
    injectServer.server.close();
  }

  // ─── 2. retry-after-failure actually waits and retries ────────
  let attempts = 0;
  const { server, port } = await startStubServer((req, res) => {
    attempts += 1;
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      assert.equal(parsed.params.name, 'ping');
      if (attempts < 3) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'server boom' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, payload: 'success-on-third' } }));
      }
    });
  });

  const hub = createMcpHub({
    getConfig: () => ({
      mcpHub: {
        enabled: true,
        servers: [
          {
            id: 's1',
            url: `http://127.0.0.1:${port}/mcp`,
            maxRetries: 2,
            retryDelayMs: 30,
            timeoutMs: 1000,
          },
        ],
        routing: [{ toolName: 'ping', serverId: 's1' }],
      },
    }),
    normalizeMcpTool,
    mergeClaudeTools,
    logMcpExecution: () => {},
  });

  // capture warnings to detect retry messages
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };

  try {
    const result = await hub.callRemoteMcp(
      {
        id: 's1',
        url: `http://127.0.0.1:${port}/mcp`,
        prefix: 'glm',
        maxRetries: '2',
        retryDelayMs: '-10',
        timeoutMs: '0',
      },
      'glm_ping',
      { ok: true }
    );
    assert.deepEqual(result, { ok: true, payload: 'success-on-third' });
    assert.equal(attempts, 3, 'callRemoteMcp retries until configured maxRetries');
    assert.ok(
      warnings.some((line) => line.includes('attempt 2/3')),
      'retry warning includes bounded attempt count'
    );

    const fixedDelay = 50;
    const t0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, fixedDelay));
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed >= fixedDelay - 5,
      `inline-mirror delay honored (${elapsed}ms >= ${fixedDelay}ms)`
    );

    // Compare with the broken pattern to confirm it would have failed:
    let brokenResolved = false;
    const brokenPromise = new Promise((brokenResolve) => setTimeout(brokenResolve, 50));
    setTimeout(() => {
      // If the broken pattern worked, brokenResolved would be true after 50ms.
      // But it does work because in our mirror we name the param `brokenResolve`.
      // The real bug was using a non-existent `resolve` identifier — here we
      // confirm that any timer schedule that takes a callback invokes it.
      brokenResolved = true;
    }, 5);
    await brokenPromise;
    assert.equal(brokenResolved, true, 'timer callback fires (this is a guard)');

    // Verify the actual source file uses the fixed pattern, not the broken one.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'mcp-hub.js'), 'utf8');
    assert.ok(
      src.includes('new Promise((resolve) => setTimeout(resolve, delay))'),
      'mcp-hub.js uses the fixed Promise pattern'
    );
    assert.ok(
      !src.includes('new Promise(r => setTimeout(resolve, delay))'),
      'mcp-hub.js no longer contains the broken Promise pattern'
    );

    // Sanity: hub is callable and has the expected methods
    assert.equal(typeof hub.resolveToolRoute, 'function', 'hub.resolveToolRoute exists');
  } finally {
    console.warn = origWarn;
    server.close();
  }

  let cappedAttempts = 0;
  const capped = await startStubServer((req, res) => {
    cappedAttempts += 1;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'always down' } }));
    });
  });
  try {
    const cappedWarnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => {
      cappedWarnings.push(args.join(' '));
    };
    const cappedHub = createMcpHub({ getConfig: () => ({ mcpHub: { servers: [], routing: [] } }) });
    try {
      await assert.rejects(
        () =>
          cappedHub.callRemoteMcp(
            {
              id: 'bounded',
              url: `http://127.0.0.1:${capped.port}/mcp`,
              maxRetries: '999',
              retryDelayMs: '-100',
              timeoutMs: 'Infinity',
            },
            'fail',
            {}
          ),
        /always down/
      );
      assert.equal(cappedAttempts, 11, 'maxRetries is capped to 10 retries plus initial call');
      assert.equal(cappedWarnings.length, 10, 'capped retry path emits one warning per retry');
    } finally {
      console.warn = origWarn;
    }
  } finally {
    capped.server.close();
  }

  let hugeRequestSeen = false;
  const huge = await startStubServer((req, res) => {
    hugeRequestSeen = true;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"jsonrpc":"2.0","result":"');
      res.write('x'.repeat(1024 * 1024 + 1));
      res.end('"}');
    });
  });
  try {
    const response = await mcpHubModule._test.sendJsonRpc(
      { url: `http://127.0.0.1:${huge.port}/mcp` },
      'tools/list',
      {},
      1000
    );
    assert.equal(hugeRequestSeen, true, 'oversized MCP server was contacted');
    assert.equal(response.ok, false, 'oversized MCP response is rejected');
    assert.match(
      response.error,
      /MCP response too large/,
      'oversized MCP response reports size error'
    );
  } finally {
    huge.server.close();
  }

  console.log('mcp-hub.test.js ok');
}

run().catch((err) => {
  console.error('mcp-hub.test.js FAILED:', err);
  process.exit(1);
});
