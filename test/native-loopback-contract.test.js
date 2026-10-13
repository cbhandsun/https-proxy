'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createContextEvidenceLedger } = require('../lib/client/context-evidence-ledger');
const { createContextEvidenceNativeTools } = require('../lib/client/context-evidence-native-tools');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const {
  createNativeBenchmarkWorkload,
} = require('../scripts/lib/native-compaction-benchmark-workload');
const {
  seedFixtureLedger,
  runNativeEvidenceLoopback,
} = require('../scripts/lib/native-evidence-loopback');
const {
  FIXTURE_MODES,
  EVIDENCE_NAMESPACE,
  nativeFixtureOptions,
  nativeFixtureThreadOptions,
  nativeFixtureToolShapes,
  nativeFixtureToolInventory,
  nativeFixtureCodeItem,
  nativeFixtureSse,
  nativeFixtureAcceptance,
} = require('../scripts/lib/native-loopback-contract');
const executable = path.resolve('isolated-does-not-exist.exe');
const directory = path.resolve('isolated');
const shape = { type: 'custom', name: 'exec', namespace: 'functions' };

function fixture(t) {
  const ledger = createContextEvidenceLedger({ owner: 'test', threadId: 'test' });
  t.after(() => ledger.close());
  const sources = seedFixtureLedger(ledger);
  const native = createContextEvidenceNativeTools(ledger);
  return { ledger, sources, native };
}

test('strict isolated options reject empty, illegal, huge and accessor input without execution', () => {
  for (const mode of FIXTURE_MODES)
    assert.equal(nativeFixtureOptions({ executable, mode }).mode, mode);
  let executed = 0;
  const getter = Object.defineProperty({}, 'mode', {
    enumerable: true,
    get() {
      executed++;
      return 'direct';
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const input of [
    null,
    [],
    {},
    getter,
    cyclic,
    { executable: 'relative', mode: 'direct' },
    { executable: executable + '\0', mode: 'direct' },
    { executable, mode: 'unknown' },
    { executable, mode: 'direct', secret: 'x' },
    { executable, mode: 'x'.repeat(5000) },
  ])
    assert.throws(() => nativeFixtureOptions(input));
  assert.equal(executed, 0);
});

test('thread options preserve read/output budgets and have only isolated mock routing', (t) => {
  const f = fixture(t);
  const options = nativeFixtureThreadOptions(1234, directory, f.native.definitions);
  assert.equal(options.ephemeral, true);
  assert.equal(options.sandbox, 'read-only');
  const provider = options.config.model_providers['hpm-loopback-fixture'];
  assert.equal(provider.base_url, 'http://127.0.0.1:1234');
  assert.equal(provider.requires_openai_auth, false);
  assert.equal(provider.request_max_retries, 0);
  assert.equal(options.config.tool_output_token_limit, 24000);
  const direct = nativeFixtureThreadOptions(
    1234,
    directory,
    f.native.definitions,
    'namespace-direct'
  );
  assert.deepEqual(direct.config.features.code_mode.direct_only_tool_namespaces, [
    EVIDENCE_NAMESPACE,
  ]);
  assert.equal(direct.dynamicTools[0].type, 'namespace');
  assert.equal(direct.dynamicTools[0].name, EVIDENCE_NAMESPACE);
  assert.equal(direct.dynamicTools[0].tools.length, 2);
  for (const port of [0, 65536, NaN, 1.5, '1234'])
    assert.throws(() => nativeFixtureThreadOptions(port, directory, f.native.definitions));
  for (const definitions of [
    null,
    [],
    [null, null],
    [f.native.definitions[0], f.native.definitions[0]],
    [{ type: 'function', name: 'bad' }, f.native.definitions[1]],
  ])
    assert.throws(() => nativeFixtureThreadOptions(1234, directory, definitions));
  assert.throws(() => nativeFixtureThreadOptions(1234, 'relative', f.native.definitions));
  assert.throws(() => nativeFixtureThreadOptions(1234, directory, f.native.definitions, 'bad'));
});

test('native empty tools are valid and cannot prove advertised Code Mode; duplicate identities refused', () => {
  assert.deepEqual(nativeFixtureToolShapes([]), []);
  assert.deepEqual(nativeFixtureToolInventory([]), []);
  const tools = [
    {
      type: 'namespace',
      name: 'functions',
      tools: [{ type: 'custom', name: 'exec', format: { type: 'grammar' } }],
    },
    { type: 'function', name: 'read' },
    { type: 'tool_search' },
  ];
  assert.equal(nativeFixtureToolShapes(tools)[0].namespace, 'functions');
  assert.equal(nativeFixtureToolShapes(tools)[0].formatType, 'grammar');
  assert.equal(nativeFixtureToolShapes(tools).length, 3);
  for (const value of [
    null,
    {},
    [null],
    [{ type: 'unknown' }],
    [{ type: 'function', name: 'bad name' }],
    [
      { type: 'function', name: 'read' },
      { type: 'custom', name: 'read' },
    ],
    Array.from({ length: 65 }, () => ({ type: 'web_search' })),
  ])
    assert.throws(() => nativeFixtureToolShapes(value));
  const inventory = nativeFixtureToolInventory([
    {
      type: 'function',
      name: 'read',
      description: 'secret content',
      arguments: 'secret',
      parameters: { hidden: 'secret' },
    },
  ]);
  assert.equal(JSON.stringify(inventory).includes('secret'), false);
  assert.throws(() => nativeFixtureToolInventory(Array(65).fill({})));
});

test('seven preserved corpus sources are seeded outside native execution with matching digests', (t) => {
  const f = fixture(t);
  assert.equal(f.sources.length, 7);
  assert.equal(f.ledger.inspect().capturedCount, 7);
  assert.equal(f.ledger.inspect().fullyReadSources, 0);
  assert.equal(
    createNativeBenchmarkWorkload().descriptor.corpusSha256,
    '3530a79d9b7846e71a195412f7f6f812e9c8980449ba53423f592b6f5453370b'
  );
  for (const source of f.sources) {
    const chunks = [];
    let offsetBytes = 0;
    do {
      const reply = f.native.reply('hpm_read_retained_evidence', {
        sourceId: source.sourceId,
        digest: source.digest,
        offsetBytes,
        limitBytes: 6144,
      });
      assert.equal(reply.success, true);
      const page = JSON.parse(reply.contentItems[0].text).page;
      chunks.push(page.text);
      offsetBytes = page.nextOffsetBytes;
    } while (offsetBytes !== null);
    assert.equal(createHash('sha256').update(chunks.join('')).digest('hex'), source.digest);
  }
  assert.equal(f.ledger.inspect().fullyReadSources, 7);
  assert.equal(f.native.inspect().calls, 13);
});

test('native text programs contain source identities only, not findings or submitted answers', async (t) => {
  const f = fixture(t);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const mode of ['code-mode-object', 'code-mode-json']) {
    const item = nativeFixtureCodeItem(shape, f.sources, mode);
    assert.ok(item.input.includes('text('));
    assert.equal(item.input.includes('console.log'), false);
    for (const finding of Object.values(createNativeBenchmarkWorkload().expected).filter(
      (value) => typeof value === 'string'
    ))
      assert.equal(item.input.includes(JSON.stringify(finding)), false);
    let replies = 0;
    await new AsyncFunction('tools', 'text', item.input)(
      { hpm_read_retained_evidence: (args) => f.native.reply('hpm_read_retained_evidence', args) },
      () => {
        replies++;
      }
    );
    assert.equal(replies, 13);
  }
  const legacy = nativeFixtureCodeItem(shape, f.sources, 'legacy-console');
  await assert.rejects(
    new AsyncFunction('tools', 'text', 'console', legacy.input)(
      { hpm_read_retained_evidence: (args) => f.native.reply('hpm_read_retained_evidence', args) },
      () => {},
      undefined
    ),
    TypeError
  );
  const page = nativeFixtureCodeItem(shape, [f.sources[0]], 'code-mode-page', 0, 3);
  assert.equal(page.call_id, 'fixture-code-call-3');
  assert.equal(page.input.includes('while'), false);
  const namespace = nativeFixtureCodeItem(shape, f.sources, 'namespace-direct');
  assert.ok(namespace.input.includes('fixture_evidence_nested_unavailable'));
  assert.equal(namespace.input.includes('await'), false);
  for (const [s, sources, mode, offset, index] of [
    [null, f.sources, 'code-mode-object', 0, 1],
    [shape, [], 'code-mode-object', 0, 1],
    [shape, f.sources, 'bad', 0, 1],
    [shape, [f.sources[0]], 'code-mode-page', -1, 1],
    [shape, [f.sources[0]], 'code-mode-page', 0, 33],
  ])
    assert.throws(() => nativeFixtureCodeItem(s, sources, mode, offset, index));
});

test('synthetic SSE is framed as mock protocol, not a fabricated compaction item', () => {
  const item = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'fixture' }],
  };
  const events = nativeFixtureSse(item)
    .trim()
    .split('\n\n')
    .map((block) => JSON.parse(block.split('\ndata: ')[1]));
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'response.created',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]
  );
  assert.deepEqual(events.at(-1).response.output, [item]);
  assert.throws(() => nativeFixtureSse({ type: 'compaction' }));
});

test('native completed turns never mask missing evidence, lifecycle, isolation or diagnostic failures', () => {
  const complete = {
    mode: 'namespace-direct',
    failureCode: null,
    turnCompleted: true,
    requests: 15,
    fullyReadSources: 7,
    readReplies: 13,
    exactEnvelopes: 13,
    completedDynamicReadItems: 13,
    realNativeCodeModeObserved: true,
    evidenceNestedUnavailableObserved: true,
    evidenceNestedCallableObserved: false,
  };
  assert.equal(nativeFixtureAcceptance(complete), true);
  for (const [key, value] of [
    ['failureCode', 'native_fixture_http_refused'],
    ['turnCompleted', false],
    ['fullyReadSources', 6],
    ['readReplies', 12],
    ['exactEnvelopes', 6],
    ['exactEnvelopes', '13'],
    ['completedDynamicReadItems', 12],
    ['realNativeCodeModeObserved', false],
    ['evidenceNestedUnavailableObserved', false],
    ['evidenceNestedCallableObserved', true],
  ])
    assert.equal(nativeFixtureAcceptance({ ...complete, [key]: value }), false);
  assert.equal(
    nativeFixtureAcceptance({ ...complete, mode: 'direct', realNativeCodeModeObserved: false }),
    true
  );
  assert.equal(
    nativeFixtureAcceptance({
      ...complete,
      mode: 'code-mode-page',
      evidenceNestedUnavailableObserved: false,
    }),
    true
  );
  assert.equal(
    nativeFixtureAcceptance({
      mode: 'discovery',
      failureCode: null,
      turnCompleted: true,
      requests: 1,
    }),
    true
  );
  assert.equal(
    nativeFixtureAcceptance({
      mode: 'discovery',
      failureCode: null,
      turnCompleted: true,
      requests: 2,
    }),
    false
  );
  for (const input of [null, [], { mode: 'bad' }])
    assert.throws(() => nativeFixtureAcceptance(input));
});

test('runner rejects invalid options and safely cleans up a nonexistent native executable', async () => {
  await assert.rejects(runNativeEvidenceLoopback({ executable, mode: 'bad' }));
  const report = await runNativeEvidenceLoopback({ executable, mode: 'direct' });
  assert.equal(report.passed, false);
  assert.equal(report.failureCode, 'native_process_spawn_failed');
  assert.equal(report.nativeProcessTerminal, true);
  assert.equal(report.loopbackServerTerminal, true);
  assert.equal(report.realProviderRequests, 0);
  assert.equal(report.codexConfigurationChanged, false);
  assert.equal(report.sourceEvidencePreloadedByFixture, true);
});

test('new tests enter unified unit CI discovery and CLI remains a composition root', () => {
  const files = selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..')));
  assert.ok(files.includes('test/native-loopback-rpc.test.js'));
  assert.ok(files.includes('test/native-loopback-contract.test.js'));
  const cli = fs.readFileSync(
    path.resolve(__dirname, '../scripts/probe-native-evidence-loopback.js'),
    'utf8'
  );
  assert.ok(cli.includes('runNativeEvidenceLoopback'));
  assert.equal(cli.includes('http.createServer'), false);
});
