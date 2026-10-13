'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextEvidenceGateway } = require('../lib/client/context-evidence-gateway');
const { discoverTestFiles } = require('../lib/test-discovery');
const path = require('node:path');
const tool = (extra = {}) => ({
  name: 'lookup',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  },
  ...extra,
});
const textResult = (text = '中文🙂 exact original') => ({ content: [{ type: 'text', text }] });
const json = (result) => JSON.parse(result.content[0].text);
const plain = (value) => JSON.parse(JSON.stringify(value));
const create = (overrides = {}) =>
  createContextEvidenceGateway({
    tools: [tool()],
    callTool: async () => textResult(),
    ...overrides,
  });

test('gateway works without Codex metadata, retains evidence and never reexecutes on read', async (t) => {
  let calls = 0;
  const session = create({
    callTool: async (params) => {
      calls++;
      assert.deepEqual(plain(params), { name: 'lookup', arguments: { query: 'fresh' } });
      return textResult();
    },
  });
  t.after(session.close);
  assert.deepEqual(plain(await session.call('lookup', { query: 'fresh' })), textResult());
  const source = json(await session.call('hpm_list_retained_evidence')).sources[0];
  const page = json(
    await session.call('hpm_read_retained_evidence', {
      sourceId: source.sourceId,
      digest: source.digest,
    })
  );
  assert.deepEqual(JSON.parse(page.page.text), textResult());
  const record = json(await session.call('hpm_list_execution_records')).records[0];
  assert.equal(record.state, 'completed');
  assert.equal(record.verification, 'not_verified');
  assert.equal(record.sourceId, source.sourceId);
  assert.equal(calls, 1);
  assert.equal(session.inspect().scope, 'connection');
  assert.equal(session.inspect().captureFailures, 0);
  assert.equal(
    session.definitions.some((x) => /capture/.test(x.name)),
    false
  );
  const altered = session.definitions;
  altered[0].name = 'foreign';
  assert.equal(session.definitions[0].name, 'lookup');
});

test('gateway enforces schema and reserves private/read operations before dispatch', async () => {
  let calls = 0;
  const session = create({
    callTool: async () => {
      calls++;
      return textResult();
    },
  });
  for (const [name, args] of [
    ['foreign', {}],
    ['hpm_capture_completed_hook', {}],
    ['lookup', []],
    ['lookup', { query: 1 }],
    ['lookup', { owner: 'foreign' }],
    ['lookup', { query: 'x'.repeat(1048577) }],
  ]) {
    assert.equal((await session.call(name, args)).isError, true);
  }
  let invoked = 0;
  const getter = Object.defineProperty({}, 'query', {
    enumerable: true,
    get() {
      invoked++;
      return 'secret';
    },
  });
  assert.equal((await session.call('lookup', getter)).isError, true);
  assert.equal(invoked, 0);
  assert.equal(calls, 0);
  session.close();
  assert.equal((await session.call('lookup')).isError, true);
  assert.equal(session.inspect().closed, true);
});

test('connection scopes cannot read one another and callers cannot supply a selector', async (t) => {
  const a = create();
  const b = create();
  t.after(a.close);
  t.after(b.close);
  await a.call('lookup');
  const source = json(await a.call('hpm_list_retained_evidence')).sources[0];
  assert.equal(
    (
      await b.call('hpm_read_retained_evidence', {
        sourceId: source.sourceId,
        digest: source.digest,
      })
    ).isError,
    true
  );
  assert.equal(
    (await a.call('hpm_list_retained_evidence', { sessionId: 'foreign' })).isError,
    true
  );
  assert.deepEqual(json(await b.call('hpm_list_retained_evidence')).sources, []);
});

test('tool errors, transport failures and malformed output are distinct, safe, and never retried', async (t) => {
  for (const [callback, expected] of [
    [async () => ({ ...textResult('failure data'), isError: true }), 'failed'],
    [
      async () => {
        throw new Error('Bearer neverexposesecret123');
      },
      'unknown',
    ],
    [async () => ({ content: [{ type: 'invalid', text: 'secret' }] }), 'unknown'],
    [async () => null, 'unknown'],
  ]) {
    let calls = 0;
    const session = create({
      callTool: async () => {
        calls++;
        return callback();
      },
    });
    t.after(session.close);
    const result = await session.call('lookup');
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('neverexpose'), false);
    const observation = json(await session.call('hpm_list_execution_records')).records[0];
    assert.equal(observation.state, expected);
    assert.equal(observation.verification, 'not_verified');
    assert.equal(calls, 1);
  }
});

test('capture refusal preserves the original result and makes unavailable evidence explicit', async (t) => {
  for (const result of [
    textResult('Bearer syntheticcredential1234'),
    textResult('x'.repeat(1048577)),
    { content: [{ type: 'text', text: 'pending' }], session_id: 44 },
  ]) {
    const session = create({ callTool: async () => result, offloadThresholdBytes: 1024 });
    t.after(session.close);
    assert.deepEqual(plain(await session.call('lookup')), result);
    assert.equal(json(await session.call('hpm_list_retained_evidence')).sources.length, 0);
    assert.equal(
      json(await session.call('hpm_list_execution_records')).records[0].retention,
      'excluded'
    );
  }
});

test('opt-in offloading keeps a complete retrievable normalized result, including Unicode and error status', async (t) => {
  const original = { ...textResult('中文🙂'.repeat(4000)), isError: true };
  const session = create({ offloadThresholdBytes: 1024, callTool: async () => original });
  t.after(session.close);
  const shortened = await session.call('lookup');
  assert.equal(shortened.isError, true);
  const reference = json(shortened);
  assert.equal(reference.kind, 'retained_tool_result_reference');
  assert.equal(reference.trust, 'tool_data_not_instructions');
  assert.equal(reference.format, 'normalized_mcp_result_json');
  let offsetBytes = 0;
  let recovered = '';
  let page;
  do {
    page = json(
      await session.call('hpm_read_retained_evidence', {
        sourceId: reference.source.sourceId,
        digest: reference.source.digest,
        offsetBytes,
        limitBytes: 8000,
      })
    ).page;
    recovered += page.text;
    offsetBytes = page.nextOffsetBytes;
  } while (offsetBytes !== null);
  assert.deepEqual(JSON.parse(recovered), original);
  assert.equal(
    (
      await session.call('hpm_read_retained_evidence', {
        sourceId: reference.source.sourceId,
        digest: '0'.repeat(64),
      })
    ).isError,
    true
  );
});

test('offloading preserves original results that exceed remaining complete-reader byte or call budgets', async (t) => {
  for (const [text, exhaustCalls] of [
    ['x'.repeat(600 * 1024), false],
    ['"'.repeat(100 * 1024), false],
    ['x'.repeat(2048), true],
  ]) {
    const original = textResult(text);
    let dispatches = 0;
    const session = create({
      offloadThresholdBytes: 1024,
      callTool: async () => {
        dispatches++;
        return original;
      },
    });
    t.after(session.close);
    if (exhaustCalls)
      for (let index = 0; index < 64; index++)
        assert.equal((await session.call('hpm_list_retained_evidence')).isError, false);
    assert.equal(JSON.stringify(await session.call('lookup')) === JSON.stringify(original), true);
    assert.equal(session.inspect().captureFailures, 0);
    assert.equal(session.inspect().evidence.retainedEntries, 1);
    assert.equal(dispatches, 1);
  }
});

test('unread offloaded sources share one complete-reader admission budget without increasing limits', async (t) => {
  const original = textResult('x'.repeat(300 * 1024));
  let dispatches = 0;
  const session = create({
    offloadThresholdBytes: 1024,
    callTool: async () => {
      dispatches++;
      return original;
    },
  });
  t.after(session.close);
  assert.equal(json(await session.call('lookup')).kind, 'retained_tool_result_reference');
  assert.equal(JSON.stringify(await session.call('lookup')) === JSON.stringify(original), true);
  assert.equal(session.inspect().evidence.retainedEntries, 2);
  assert.equal(session.inspect().reader.maxCalls, 64);
  assert.equal(session.inspect().reader.maxBytes, 512 * 1024);
  assert.equal(dispatches, 2);
});

test('gateway releases admission only after complete real readback and keeps actual reader expenditure', async (t) => {
  let dispatches = 0;
  const original = textResult('x'.repeat(300 * 1024));
  const smaller = textResult('x'.repeat(100 * 1024));
  const session = create({
    offloadThresholdBytes: 1024,
    callTool: async () => (++dispatches === 1 ? original : smaller),
  });
  t.after(session.close);
  const reference = json(await session.call('lookup'));
  assert.equal(session.inspect().offloadBudget.pendingSources, 1);
  let offsetBytes = 0;
  let recovered = '';
  do {
    const reply = await session.call('hpm_read_retained_evidence', {
      sourceId: reference.source.sourceId,
      digest: reference.source.digest,
      offsetBytes,
      limitBytes: reference.readerOptions.limitBytes,
    });
    assert.equal(reply.isError, false);
    const page = json(reply).page;
    recovered += page.text;
    offsetBytes = page.nextOffsetBytes;
    assert.equal(session.inspect().offloadBudget.pendingSources, offsetBytes === null ? 0 : 1);
  } while (offsetBytes !== null);
  assert.equal(recovered === JSON.stringify(original), true);
  assert.ok(session.inspect().reader.returnedBytes > 300 * 1024);
  assert.equal(json(await session.call('lookup')).kind, 'retained_tool_result_reference');
  assert.equal(dispatches, 2);
  session.close();
  assert.equal(session.inspect().offloadBudget.pendingSources, 0);
});

test('expired offload admission is not renewed by reads and can be reclaimed by a new real source', async (t) => {
  let now = 0;
  const original = textResult('x'.repeat(300 * 1024));
  const session = create({
    now: () => now,
    ttlMs: 20,
    offloadThresholdBytes: 1024,
    callTool: async () => original,
  });
  t.after(session.close);
  const reference = json(await session.call('lookup'));
  now = 15;
  assert.equal(
    (
      await session.call('hpm_read_retained_evidence', {
        sourceId: reference.source.sourceId,
        digest: reference.source.digest,
        limitBytes: 1,
      })
    ).isError,
    false
  );
  now = 20;
  assert.equal(json(await session.call('lookup')).kind, 'retained_tool_result_reference');
  assert.equal(session.inspect().offloadBudget.pendingSources, 1);
  assert.equal(session.inspect().evidence.retainedEntries, 1);
  assert.equal(
    (
      await session.call('hpm_read_retained_evidence', {
        sourceId: reference.source.sourceId,
        digest: reference.source.digest,
      })
    ).isError,
    true
  );
});

test('concurrent source completions cannot overbook the same remaining offload read capacity', async (t) => {
  let dispatches = 0;
  const resolvers = [];
  const original = textResult('x'.repeat(300 * 1024));
  const session = create({
    offloadThresholdBytes: 1024,
    callTool: () => {
      dispatches++;
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  t.after(session.close);
  const pending = [session.call('lookup'), session.call('lookup')];
  resolvers[1](original);
  resolvers[0](original);
  const replies = await Promise.all(pending);
  assert.equal(
    replies.filter((reply) => JSON.stringify(reply) === JSON.stringify(original)).length,
    1
  );
  const shortened = replies.find((reply) => JSON.stringify(reply) !== JSON.stringify(original));
  assert.equal(json(shortened).kind, 'retained_tool_result_reference');
  assert.equal(session.inspect().offloadBudget.pendingSources, 1);
  assert.equal(session.inspect().evidence.retainedEntries, 2);
  assert.equal(dispatches, 2);
});

test('offloading does not alter typed, multimodal, metadata, multiple-block or small output', async (t) => {
  const large = 'x'.repeat(2000);
  for (const [definition, result] of [
    [tool({ outputSchema: { type: 'object' } }), { ...textResult(large), structuredContent: {} }],
    [tool(), { ...textResult(large), structuredContent: { value: 1 } }],
    [tool(), { ...textResult(large), _meta: { category: 'safe' } }],
    [tool(), { content: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }] }],
    [
      tool(),
      {
        content: [
          { type: 'text', text: large },
          { type: 'text', text: 'second' },
        ],
      },
    ],
    [tool(), textResult('small')],
  ]) {
    const session = create({
      tools: [definition],
      offloadThresholdBytes: 1024,
      callTool: async () => result,
    });
    t.after(session.close);
    assert.deepEqual(plain(await session.call('lookup')), result);
  }
});

test('quota and expiry never manufacture evidence or cause original execution retry', async (t) => {
  let now = 0;
  let calls = 0;
  const original = textResult('x'.repeat(1100));
  const session = create({
    now: () => now,
    ttlMs: 20,
    offloadThresholdBytes: 1024,
    callTool: async () => {
      calls++;
      return original;
    },
  });
  t.after(session.close);
  for (let i = 0; i < 64; i++)
    assert.equal(json(await session.call('lookup')).kind, 'retained_tool_result_reference');
  assert.deepEqual(plain(await session.call('lookup')), original);
  assert.equal(session.inspect().captureFailures, 1);
  const source = json(await session.call('hpm_list_retained_evidence')).sources[0];
  now = 20;
  assert.equal(
    (
      await session.call('hpm_read_retained_evidence', {
        sourceId: source.sourceId,
        digest: source.digest,
      })
    ).isError,
    true
  );
  assert.equal(json(await session.call('hpm_list_execution_records')).records.length, 0);
  assert.equal(calls, 65);
});

test('late results after close/expiry do not reopen ledgers or change a returned tool result', async () => {
  for (const close of [false, true]) {
    let now = 0;
    let resolve;
    const session = create({
      now: () => now,
      ttlMs: 1,
      callTool: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const pending = session.call('lookup');
    if (close) session.close();
    else now = 1;
    resolve(textResult());
    assert.deepEqual(plain(await pending), textResult());
    assert.ok(session.inspect().captureFailures > 0);
    session.close();
  }
});

test('dispatch concurrency and reader budgets are bounded and cancellation does not dispatch', async (t) => {
  let calls = 0;
  const resolvers = [];
  const session = create({
    callTool: () => {
      calls++;
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  t.after(session.close);
  assert.equal((await session.call('lookup', {}, { signal: { aborted: true } })).isError, true);
  const pending = Array.from({ length: 16 }, () => session.call('lookup'));
  assert.equal((await session.call('lookup')).isError, true);
  assert.equal(calls, 16);
  for (const resolve of resolvers) resolve(textResult());
  await Promise.all(pending);
  assert.equal(session.inspect().active, 0);
  for (let i = 0; i < 64; i++)
    assert.equal(
      (await session.call('hpm_list_execution_records', { invalid: true })).isError,
      true
    );
  assert.equal(
    json(await session.call('hpm_list_execution_records')).error,
    'execution_read_budget_exceeded'
  );
});

test('gateway rejects unsafe catalogs, schemas and executable configuration', () => {
  for (const config of [
    null,
    [],
    {},
    { tools: [], callTool: 'bad' },
    { tools: [], callTool() {}, unknown: 'secret' },
    { tools: [], callTool() {}, offloadThresholdBytes: 0 },
    { tools: [], callTool() {}, offloadThresholdBytes: 1048577 },
    { tools: [], callTool() {}, now: 1 },
  ])
    assert.throws(() => createContextEvidenceGateway(config));
  for (const tools of [
    null,
    {},
    Array.from({ length: 513 }, () => tool()),
    [tool(), tool()],
    [tool({ name: 'hpm_capture_completed_hook' })],
    [tool({ name: '../bad' })],
    [tool({ inputSchema: [] })],
    [tool({ description: 3 })],
    [tool({ inputSchema: { type: 'object', properties: { x: { pattern: '(a+)+' } } } })],
    [tool({ inputSchema: { type: 'object', properties: { x: { $ref: 'https://never-fetch' } } } })],
    [tool({ inputSchema: { type: 'object', patternProperties: { '(a+)+': { type: 'string' } } } })],
  ])
    assert.throws(() => create({ tools }));
  let invoked = 0;
  const getter = Object.defineProperty({ tools: [] }, 'callTool', {
    get() {
      invoked++;
      return undefined;
    },
  });
  assert.throws(() => createContextEvidenceGateway(getter));
  assert.equal(invoked, 0);
});

test('cancelled in-flight dispatch remains unknown and the gateway never retries it', async (t) => {
  const controller = new globalThis.AbortController();
  let calls = 0;
  const session = create({
    callTool: (_params, context) => {
      calls++;
      return new Promise((_resolve, reject) =>
        context.signal.addEventListener(
          'abort',
          () => reject(new Error('untrusted cancellation detail')),
          { once: true }
        )
      );
    },
  });
  t.after(session.close);
  const pending = session.call('lookup', {}, { signal: controller.signal });
  controller.abort();
  assert.equal(json(await pending).error, 'downstream_execution_unknown');
  assert.equal(json(await session.call('hpm_list_execution_records')).records[0].state, 'unknown');
  assert.equal(calls, 1);
});

test('output contracts are validated before retention and never replaced with references', async (t) => {
  const outputSchema = {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 0 } },
    required: ['count'],
    additionalProperties: false,
  };
  for (const [result, valid] of [
    [{ ...textResult('x'.repeat(2048)), structuredContent: { count: 0 } }, true],
    [textResult('missing'), false],
    [{ ...textResult('wrong'), structuredContent: { count: 'private data' } }, false],
    [{ ...textResult('extreme'), structuredContent: { count: -1 } }, false],
    [{ ...textResult('empty'), structuredContent: {} }, false],
    [{ ...textResult('failure'), isError: true }, true],
    [
      { ...textResult('invalid failure'), isError: true, structuredContent: { count: false } },
      false,
    ],
  ]) {
    let calls = 0;
    const session = create({
      tools: [tool({ outputSchema })],
      offloadThresholdBytes: 1024,
      callTool: async () => {
        calls++;
        return result;
      },
    });
    t.after(session.close);
    const returned = await session.call('lookup');
    if (valid) assert.deepEqual(plain(returned), result);
    else assert.equal(json(returned).error, 'invalid_downstream_result');
    const observation = json(await session.call('hpm_list_execution_records')).records[0];
    assert.equal(observation.state, valid ? (result.isError ? 'failed' : 'completed') : 'unknown');
    assert.equal(observation.retention, valid ? 'retained' : 'unavailable');
    assert.equal(
      json(await session.call('hpm_list_retained_evidence')).sources.length,
      valid ? 1 : 0
    );
    assert.equal(calls, 1);
  }
  for (const outputSchema of [
    { type: 'object', properties: { value: { pattern: '(a+)+' } } },
    { type: 'object', properties: { value: { $ref: 'https://must-not-fetch.invalid' } } },
    { type: 'object', properties: { value: { $dynamicRef: 'https://must-not-fetch.invalid' } } },
    { type: 'object', properties: { value: { $recursiveRef: 'https://must-not-fetch.invalid' } } },
  ])
    assert.throws(
      () => create({ tools: [tool({ outputSchema })] }),
      /Invalid evidence gateway schema/
    );
});

test('task-only tools fail closed and optional downstream tasks are explicitly unavailable here', async (t) => {
  assert.throws(
    () => create({ tools: [tool({ execution: { taskSupport: 'required' } })] }),
    /Invalid evidence gateway schema/
  );
  const original = tool({ execution: { taskSupport: 'optional' } });
  const session = create({ tools: [original] });
  t.after(session.close);
  assert.equal(session.definitions[0].execution.taskSupport, 'forbidden');
  assert.equal(original.execution.taskSupport, 'optional');
  assert.deepEqual(plain(await session.call('lookup')), textResult());
});

test('existing proxy evidence-reader guidance does not authorize reacquisition or side-effect replay', () => {
  const { contextArtifactToolDefinition } = require('../lib/proxy/context-artifact-tool');
  const description = contextArtifactToolDefinition().function.description;
  assert.ok(description.includes('Do not automatically rerun the original tool'));
  assert.ok(description.includes('separate applicable authorization'));
  assert.equal(description.includes('reacquire the original source with permitted tools'), false);
});

test('new gateway regressions enter unified discovery and the client coverage command', () => {
  const root = path.resolve(__dirname, '..');
  const tests = discoverTestFiles(root);
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of [
    'client-context-evidence-source',
    'client-context-execution-ledger',
    'client-context-evidence-gateway',
    'client-context-evidence-offload-budget',
    'client-context-evidence-gateway-mcp',
    'client-context-evidence-gateway-lifecycle',
    'evidence-gateway-environment',
    'evidence-gateway-runtime',
  ]) {
    assert.ok(tests.includes('test/' + name + '.test.js'));
    assert.ok(pkg.scripts['test:client:coverage'].includes('test/' + name + '.test.js'));
  }
});
