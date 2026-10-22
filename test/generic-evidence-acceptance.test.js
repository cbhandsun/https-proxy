'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createContextEvidenceGateway } = require('../lib/client/context-evidence-gateway');
const {
  runGenericEvidenceAcceptance,
  SOURCE,
  LIST,
  READ,
} = require('../scripts/lib/generic-evidence-acceptance');
const {
  genericAcceptanceAuthority,
  genericAcceptancePreload,
  requestGenericAcceptanceModel,
} = require('../scripts/lib/generic-evidence-acceptance-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');

const rows = Array.from({ length: 80 }, (_, row) => ({
  row,
  value: 'fixture-' + row + '-'.repeat(32),
  label: '原始-é-✅-' + row,
}));
const output = (value) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: value }],
    },
  ],
});
function setup(mode) {
  let executions = 0;
  const report = {};
  const gateway = createContextEvidenceGateway({
    tools: [
      {
        name: SOURCE,
        description: 'Synthetic one-time operation',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    offloadThresholdBytes: 1024,
    async callTool() {
      executions++;
      return {
        content: [{ type: 'text', text: JSON.stringify({ sideEffectCount: executions, rows }) }],
      };
    },
  });
  let requests = 0;
  let rememberedReceipt;
  const source = (name, args = {}) => ({
    status: 'completed',
    output: [
      { type: 'function_call', call_id: 'call_' + requests, name, arguments: JSON.stringify(args) },
    ],
  });
  const request = async ({ compact, input }) => {
    requests++;
    if (mode === 'network') throw new Error('private provider content');
    if (mode === 'replay' && requests === 2) return source(SOURCE);
    if (mode === 'budget' && requests > 2 && !compact) return source(LIST);
    if (compact)
      return {
        status: 'completed',
        output: [
          { role: 'user', content: 'canonical retained item ' + requests },
          {
            type: 'compaction',
            id: 'checkpoint-' + requests,
            encrypted_content: 'opaque-fixture-' + requests,
          },
          {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'canonical tail' }],
          },
        ],
      };
    if (requests === 1) return source(SOURCE);
    if (requests === 2) {
      if (mode === 'direct-read') {
        const reply = JSON.parse(input.at(-1).output);
        rememberedReceipt = JSON.parse(reply.content[0].text).source;
      }
      return output('READY');
    }
    if (mode === 'direct-read') {
      if ([4, 7].includes(requests))
        return source(READ, {
          sourceId: rememberedReceipt.sourceId,
          digest: rememberedReceipt.digest,
          limitBytes: 16384,
        });
      if ([5, 8].includes(requests))
        return output(JSON.stringify(recoveredRows(input)[requests === 5 ? 60 : 70]));
      if (requests === 9) return source(LIST);
      return output(JSON.stringify({ status: 'unavailable', replayed: false }));
    }
    if (mode === 'invalid-index' && requests === 4) return source(LIST, { afterSourceId: null });
    if ([4, 8, 11].includes(requests)) return source(LIST);
    if ([5, 9].includes(requests)) {
      const reply = JSON.parse(input.at(-1).output);
      const receipt = JSON.parse(reply.content[0].text).sources[0];
      return source(READ, {
        sourceId: receipt.sourceId,
        digest: receipt.digest,
        limitBytes: 16384,
      });
    }
    if (requests === 6)
      return output(
        JSON.stringify(
          mode === 'wrong'
            ? { row: 60, value: 'guessed', label: 'wrong' }
            : mode === 'stdio'
              ? recoveredRows(input)[60]
              : rows[60]
        )
      );
    if (requests === 10)
      return output(JSON.stringify(mode === 'stdio' ? recoveredRows(input)[70] : rows[70]));
    return output(JSON.stringify({ status: 'unavailable', replayed: false }));
  };
  return {
    gateway,
    report,
    request,
    executions: () => executions,
    run: () =>
      runGenericEvidenceAcceptance({
        request,
        report,
        definitions: gateway.definitions,
        callTool: (name, args) => {
          if (mode === 'tool-transport' && name === LIST)
            throw new Error('private transport detail must not be retained');
          return gateway.call(name, args);
        },
      }),
  };
}

function recoveredRows(input) {
  const reader = JSON.parse(input.at(-1).output);
  const page = JSON.parse(reader.content[0].text);
  const original = JSON.parse(page.page.text);
  return JSON.parse(original.content[0].text).rows;
}

test('actual stdio gateway and fresh synthetic source complete the same offline twelve-request workload without host metadata', async (t) => {
  const root = path.resolve('.');
  const client = new Client({ name: 'generic-offline-host', version: '1' });
  t.after(() => client.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(root, 'scripts/start-evidence-mcp-gateway.js'),
      '--offload-bytes',
      '1024',
      '--',
      process.execPath,
      path.join(root, 'test/fixtures/generic-evidence-source-mcp.js'),
    ],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  const fixture = setup('stdio');
  t.after(() => fixture.gateway.close());
  const report = await runGenericEvidenceAcceptance({
    request: fixture.request,
    report: fixture.report,
    definitions: (await client.listTools()).tools,
    callTool: (name, args) => client.callTool({ name, arguments: args }),
  });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.modelRequests, 12);
  assert.equal(report.sourceExecutionCount, 1);
  await client.close();
});

test('two complete canonical windows, fresh exact reader input, missing evidence and one source dispatch fit twelve requests', async (t) => {
  const fixture = setup();
  t.after(() => fixture.gateway.close());
  const result = await fixture.run();
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.modelRequests, 12);
  assert.equal(fixture.executions(), 1);
  assert.equal(result.sourceExecutionCount, 1);
  assert.ok(
    result.cycles.every((cycle) => cycle.exactRead && cycle.finalCorrect && cycle.readCalls === 1)
  );
  assert.ok(result.canonicalWindowChecks.length > 0 && result.canonicalWindowChecks.every(Boolean));
  assert.equal(result.nativeDetailLossClaimed, false);
  assert.equal(result.automaticRetries, 0);
  assert.ok(
    discoverTestFiles(path.resolve('.')).includes('test/generic-evidence-acceptance.test.js')
  );
});

test('replay, incorrect answers and provider failures stop without source reexecution or automatic model retries', async (t) => {
  for (const mode of ['replay', 'wrong', 'network', 'budget']) {
    const fixture = setup(mode);
    t.after(() => fixture.gateway.close());
    await assert.rejects(fixture.run());
    assert.equal(fixture.report.passed, false);
    assert.ok(fixture.executions() <= 1);
    assert.ok(fixture.report.modelRequests <= 12);
    if (mode === 'network') assert.equal(fixture.report.modelRequests, 1);
    if (mode === 'replay') assert.equal(fixture.report.unsafeToolRequests, 1);
  }
});

test('correct direct reads using a retained receipt do not satisfy the unchanged fresh-index gate', async (t) => {
  const fixture = setup('direct-read');
  t.after(() => fixture.gateway.close());
  const result = await fixture.run();
  assert.equal(result.passed, false);
  assert.equal(result.modelRequests, 10);
  assert.equal(result.cycles.length, 2);
  assert.ok(
    result.cycles.every(
      (cycle) =>
        cycle.listCalls === 0 && cycle.readCalls === 1 && cycle.exactRead && cycle.finalCorrect
    )
  );
  assert.ok(result.canonicalWindowChecks.length > 0 && result.canonicalWindowChecks.every(Boolean));
  assert.equal(result.missingEvidencePassed, true);
  assert.equal(result.sourceDispatches, 1);
  assert.equal(result.sourceExecutionCount, 1);
  assert.equal(fixture.executions(), 1);
  assert.equal(result.unsafeToolRequests, 0);
  assert.equal(result.automaticRetries, 0);
});

test('invalid model index arguments stop with safe contract diagnostics and no retry or source replay', async (t) => {
  const fixture = setup('invalid-index');
  t.after(() => fixture.gateway.close());
  await assert.rejects(fixture.run(), { code: 'generic_acceptance_tool_failed' });
  assert.equal(fixture.report.modelRequests, 4);
  assert.equal(fixture.executions(), 1);
  assert.deepEqual(fixture.report.toolObservations.at(-1), {
    tool: 'index',
    phase: 'recovery_1',
    outcome: 'tool_failed',
    failure: {
      ok: false,
      error: 'invalid_evidence_arguments',
      field: 'afterSourceId',
      reason: 'wrong_type',
    },
  });
  assert.ok(!JSON.stringify(fixture.report.toolObservations).includes('hce_'));
});

test('tool transport failure is distinguished without retaining exception text or retrying', async (t) => {
  const fixture = setup('tool-transport');
  t.after(() => fixture.gateway.close());
  await assert.rejects(fixture.run(), { code: 'generic_acceptance_tool_failed' });
  assert.equal(fixture.report.modelRequests, 2);
  assert.equal(fixture.executions(), 1);
  assert.deepEqual(fixture.report.toolObservations.at(-1), {
    tool: 'index',
    phase: 'source_verification',
    outcome: 'transport_failed',
  });
  assert.ok(!JSON.stringify(fixture.report.toolObservations).includes('private'));
});

test('authority is exact and test-process preload disables retry/failover without altering production modules', () => {
  const authority = {
    schema: 'hpm.context.generic-model-acceptance-authorization',
    version: 1,
    scope: 'one_isolated_generic_gateway_repeated_compaction_and_missing_evidence',
    userExplicitlyAuthorized: true,
    maximumModelRequests: 12,
    automaticRetries: 0,
    failedAndCompactionRequestsCounted: true,
    reuseExistingOfficialRouteAndAuthentication: true,
    installedCodexClaudeConfigurationMayChange: false,
    oldHistoryMayBeRead: false,
    productionRestartAuthorized: false,
    providerCredentialsMayChange: false,
  };
  assert.doesNotThrow(() => genericAcceptanceAuthority(authority));
  for (const invalid of [
    null,
    [],
    {},
    { ...authority, maximumModelRequests: 13 },
    { ...authority, productionRestartAuthorized: true },
    { ...authority, extra: true },
  ])
    assert.throws(() => genericAcceptanceAuthority(invalid));
  const modules = new Map();
  vm.runInNewContext(genericAcceptancePreload(path.resolve('.')), {
    require(file) {
      const module = {};
      modules.set(path.basename(file), module);
      return module;
    },
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        modules.get('upstream-retry.js').resolveUpstreamRecovery({ kind: 'error', attempt: 1 })
      )
    ),
    { type: 'none' }
  );
  const config = { unchanged: true };
  assert.equal(modules.get('builtin-model-routes.js').mergeBuiltinModelRoutes(config), config);
});

test('generic raw HTTP sender preserves canonical items and counts no hidden retries on invalid terminal output', async (t) => {
  let received = 0;
  let lastInput;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received++;
      lastInput = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({ type: 'response.completed', response: output('fixture') }) +
          '\n\n'
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const canonical = [
    { type: 'compaction', encrypted_content: 'opaque-fixture', id: 'keep-exactly' },
  ];
  const args = {
    port: server.address().port,
    ingress: 'synthetic',
    compact: false,
    input: canonical,
    definitions: [
      {
        name: LIST,
        description: 'optional cursor',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { afterSourceId: { type: 'string', pattern: '^hce_[a-f0-9]{32}$' } },
        },
      },
    ],
    row: {},
  };
  await requestGenericAcceptanceModel(args);
  assert.deepEqual(lastInput.input, canonical);
  assert.equal(lastInput.tools[0].strict, false);
  assert.deepEqual(lastInput.tools[0].parameters, args.definitions[0].inputSchema);
  await requestGenericAcceptanceModel({ ...args, compact: true, row: {} });
  assert.deepEqual(lastInput.input, [...canonical, { type: 'compaction_trigger' }]);
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    received++;
    req.resume();
    res.writeHead(429);
    res.end('{}');
  });
  await assert.rejects(requestGenericAcceptanceModel({ ...args, row: {} }));
  assert.equal(received, 3);
});
