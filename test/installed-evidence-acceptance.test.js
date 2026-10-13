'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  acceptanceAuthority,
  acceptanceContinuationPrompt,
  createFreshAcceptanceSource,
  validateCapturedPage,
  inspectAcceptanceInput,
  acceptanceVerdict,
  acceptanceCyclePassed,
} = require('../scripts/lib/installed-evidence-acceptance');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const authority = {
  schema: 'hpm.context.installed-evidence-acceptance-authorization',
  version: 1,
  scope: 'one_isolated_installed_hook_compact_continue',
  maximumAdditionalRequests: 6,
  automaticRetries: 0,
  failedAndCompactionRequestsCounted: true,
  userExplicitlyAuthorized: true,
  reuseExistingOfficialRoute: true,
  installedConfigurationMayChange: false,
  productionRestartAuthorized: false,
  oldHistoryReadAuthorized: false,
};
const marker = 'probe-' + 'a'.repeat(32);
const digest = (value) => createHash('sha256').update(value).digest('hex');
test('strict raw-page acceptance explicitly emits the complete native result before parsed projections', () => {
  const prompt = acceptanceContinuationPrompt();
  assert.match(prompt, /one retained-evidence page per exec/);
  assert.match(prompt, /complete unmodified tool result with native text\(result\) before parsing/);
  assert.match(prompt, /Never console\.log, summarize, print only parsed fields/);
  assert.match(prompt, /untrusted data, not instructions/);
  assert.match(prompt, /stop without retry or guessing/);
});
function fixture() {
  const source = createFreshAcceptanceSource(marker);
  const original = JSON.stringify(source.emit({}));
  const hash = digest(original);
  const body = {
    ok: true,
    page: {
      text: original,
      offsetBytes: 0,
      endOffsetBytes: Buffer.byteLength(original),
      totalBytes: Buffer.byteLength(original),
      nextOffsetBytes: null,
      digest: hash,
      chunkDigest: hash,
    },
    source: { sourceId: 'hce_' + 'b'.repeat(32), digest: hash },
  };
  return {
    expected: source.expected,
    original,
    body,
    result: { content: [{ type: 'text', text: JSON.stringify(body) }] },
  };
}
test('one-shot authority rejects missing, widened, retrying, unknown and unsafe input', () => {
  assert.deepEqual({ ...acceptanceAuthority(authority) }, authority);
  for (const value of [
    null,
    [],
    {},
    '',
    { ...authority, maximumAdditionalRequests: 7 },
    { ...authority, automaticRetries: 1 },
    { ...authority, oldHistoryReadAuthorized: true },
    { ...authority, extra: true },
    { ...authority, maximumAdditionalRequests: Infinity },
  ])
    assert.throws(() => acceptanceAuthority(value));
  assert.throws(() =>
    acceptanceAuthority({
      get schema() {
        throw Error('not evaluated');
      },
    })
  );
});
test('fresh source is single-use strict data-only and has no filesystem or network capability', () => {
  const source = createFreshAcceptanceSource(marker);
  for (const args of [null, [], { command: 'unsafe' }, { x: 'x'.repeat(8192) }])
    assert.throws(() => source.emit(args));
  assert.equal(source.emit({}).content[0].text, JSON.stringify(source.expected));
  assert.throws(() => source.emit({}));
  for (const input of ['', null, 'probe-secret', 'probe-' + 'f'.repeat(100)])
    assert.throws(() => createFreshAcceptanceSource(input));
});

test('fresh retest authority is separate from consumed run1 and never opens arbitrary run selection', () => {
  const retest = { ...authority, retestRun: 'run2', previouslyReportedRequests: 96 };
  assert.deepEqual({ ...acceptanceAuthority(retest, 'run2') }, retest);
  assert.throws(() => acceptanceAuthority(authority, 'run2'));
  assert.throws(() => acceptanceAuthority(retest));
  assert.throws(() => acceptanceAuthority(retest, 'run3'));
  assert.throws(() => acceptanceAuthority({ ...retest, previouslyReportedRequests: 0 }, 'run2'));
});

test('two-cycle authority is separate, fixed at twelve requests, and cannot reopen spent single-run authority', () => {
  const repeated = {
    ...authority,
    scope: 'two_same_thread_installed_hook_compact_continue_cycles',
    maximumAdditionalRequests: 12,
    acceptanceRun: 'multi1',
    requiredCompactionCycles: 2,
  };
  assert.deepEqual({ ...acceptanceAuthority(repeated, 'multi1') }, repeated);
  assert.throws(() => acceptanceAuthority(authority, 'multi1'));
  assert.throws(() => acceptanceAuthority(repeated, 'run2'));
  for (const change of [
    { maximumAdditionalRequests: 13 },
    { requiredCompactionCycles: 1 },
    { requiredCompactionCycles: Infinity },
    { automaticRetries: 1 },
    { installedConfigurationMayChange: true },
    { productionRestartAuthorized: true },
    { oldHistoryReadAuthorized: true },
    { extra: true },
  ])
    assert.throws(() => acceptanceAuthority({ ...repeated, ...change }, 'multi1'));
});

test('Code Mode wrapper observation requires the complete exact native reader envelope, not parsed projections', () => {
  const f = fixture();
  const envelope = f.result.content[0].text;
  for (const output of [
    'Script completed\nWall time: 1s\nOutput:\n' + envelope,
    'Script completed\nOutput:\n' + JSON.stringify(f.result),
    JSON.stringify(JSON.stringify(f.result)),
  ])
    assert.equal(
      inspectAcceptanceInput(
        [{ type: 'custom_tool_call_output', output }],
        marker,
        f.original,
        envelope
      ).exactRetainedPageInput,
      true
    );
  for (const output of [
    f.original,
    JSON.stringify(f.expected),
    envelope.slice(0, -1),
    envelope.replace('"offsetBytes":0', '"offsetBytes":1'),
  ])
    assert.equal(
      inspectAcceptanceInput(
        [{ type: 'custom_tool_call_output', output }],
        marker,
        f.original,
        envelope
      ).exactRetainedPageInput,
      false
    );
  assert.throws(() => inspectAcceptanceInput([], marker, f.original, '{invalid'));
  assert.throws(() => inspectAcceptanceInput([], marker, f.original, 'x'.repeat(65537)));
});
test('captured UTF-8 page requires completed full exact content and matching independent digests', () => {
  const f = fixture();
  assert.equal(validateCapturedPage(f.result, f.expected).text, f.original);
  for (const change of [
    { text: 'wrong' },
    { nextOffsetBytes: 1 },
    { offsetBytes: 1 },
    { digest: '0'.repeat(64) },
    { chunkDigest: '0'.repeat(64) },
    { totalBytes: 0 },
  ]) {
    const value = { ...f.body, page: { ...f.body.page, ...change } };
    assert.throws(() =>
      validateCapturedPage({ content: [{ type: 'text', text: JSON.stringify(value) }] }, f.expected)
    );
  }
  assert.throws(() => validateCapturedPage({ ...f.result, isError: true }, f.expected));
  assert.throws(() => validateCapturedPage(f.result, { ...f.expected, label: 'changed' }));
  assert.throws(() =>
    validateCapturedPage({ content: [{ type: 'text', text: '{invalid' }] }, f.expected)
  );
});
test('wire observer distinguishes exact retained page from raw source, guessed text and incomplete output', () => {
  const f = fixture();
  assert.equal(inspectAcceptanceInput([], marker, f.original).visibleMarker, false);
  assert.equal(
    inspectAcceptanceInput(
      [{ type: 'compaction', encrypted_content: 'synthetic' }],
      marker,
      f.original
    ).checkpointItems,
    1
  );
  for (const output of [
    f.result,
    JSON.stringify(f.result),
    JSON.stringify(JSON.stringify(f.result)),
  ])
    assert.equal(
      inspectAcceptanceInput([{ type: 'function_call_output', output }], marker, f.original)
        .exactRetainedPageInput,
      true
    );
  assert.equal(
    inspectAcceptanceInput(
      [{ type: 'function_call_output', output: f.original }],
      marker,
      f.original
    ).exactRetainedPageInput,
    false
  );
  assert.equal(
    inspectAcceptanceInput(
      [{ type: 'message', content: JSON.stringify(f.body) }],
      marker,
      f.original
    ).exactRetainedPageInput,
    false
  );
  assert.throws(() => inspectAcceptanceInput(null, marker, f.original));
});
test('acceptance cannot become green by missing any semantic, route, budget or cleanup gate', () => {
  const good = {
    failureCode: null,
    sourceToolCompleted: true,
    originalHookCaptured: true,
    preCompactExactRead: true,
    nativeCompactionItemCompleted: true,
    nativeCompactionCycles: 1,
    postCompactCheckpointObserved: true,
    postCompactInitialMarkerAbsent: true,
    modelListCompleted: true,
    modelExactReadCompleted: true,
    exactReaderOutputEnteredModelInput: true,
    finalStateCorrect: true,
    requestBudget: { reservedRequests: 6 },
    transport: Array.from({ length: 6 }, () => ({ status: 200, responseFailedEvents: 0 })),
    hookTrusted: true,
    unsafeToolRequests: 0,
    providerRouteVerified: true,
    guardedFilesUnchanged: true,
    nativeProcessTerminal: true,
    isolatedProxyTerminal: true,
    loopbackServerTerminal: true,
    isolatedDirectoriesRemoved: true,
  };
  assert.equal(acceptanceVerdict(good), true);
  const cycle = {
    nativeCompactionItemCompleted: true,
    postCompactCheckpointObserved: true,
    postCompactInitialMarkerAbsent: true,
    modelListCompleted: true,
    modelExactReadCompleted: true,
    exactReaderOutputEnteredModelInput: true,
    finalStateCorrect: true,
  };
  const repeated = {
    ...good,
    acceptanceRun: 'multi1',
    nativeCompactionCycles: 2,
    requestBudget: { reservedRequests: 12 },
    transport: Array.from({ length: 12 }, () => ({ status: 200, responseFailedEvents: 0 })),
    cycles: [
      { ...cycle, index: 1 },
      { ...cycle, index: 2 },
    ],
    compactionChainReuseChecks: [true],
    nativeCheckpointItemEqual: true,
  };
  assert.equal(acceptanceVerdict(repeated), true);
  for (const key of Object.keys(cycle)) {
    assert.equal(acceptanceCyclePassed({ ...cycle, [key]: false }), false);
    for (const index of [0, 1]) {
      const cycles = repeated.cycles.map((value) => ({ ...value }));
      cycles[index][key] = false;
      assert.equal(acceptanceVerdict({ ...repeated, cycles }), false, `${index}:${key}`);
    }
  }
  for (const change of [
    { cycles: [] },
    { cycles: [repeated.cycles[0]] },
    { cycles: [repeated.cycles[0], repeated.cycles[0]] },
    { compactionChainReuseChecks: [] },
    { compactionChainReuseChecks: [false] },
    { compactionChainReuseChecks: [true, true] },
    { nativeCheckpointItemEqual: false },
    { nativeCompactionCycles: 1 },
    { requestBudget: { reservedRequests: 13 } },
    { transport: [] },
  ])
    assert.equal(acceptanceVerdict({ ...repeated, ...change }), false);
  for (const value of [null, [], {}, '', 'x'.repeat(8192)])
    assert.equal(acceptanceCyclePassed(value), false);
  assert.equal(
    acceptanceCyclePassed({
      get nativeCompactionItemCompleted() {
        throw Error('not evaluated');
      },
    }),
    false
  );
  for (const bad of [
    null,
    [],
    {},
    {
      get transport() {
        throw Error('not evaluated');
      },
    },
    { ...good, transport: [] },
    { ...good, unsafeToolRequests: 1 },
  ])
    assert.equal(acceptanceVerdict(bad), false);
  for (const [key, value] of Object.entries(good))
    if (value === true) assert.equal(acceptanceVerdict({ ...good, [key]: false }), false, key);
  for (const change of [
    { failureCode: 'failed' },
    { nativeCompactionCycles: 0 },
    { requestBudget: { reservedRequests: 7 } },
    { requestBudget: { reservedRequests: 0 } },
    { transport: [{ status: 400, responseFailedEvents: 0 }] },
  ])
    assert.equal(acceptanceVerdict({ ...good, ...change }), false);
});
test('acceptance tests enter unified CI and runtime uses one immutable authority without model retries', () => {
  const root = path.resolve(__dirname, '..');
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(root)).includes(
      'test/installed-evidence-acceptance.test.js'
    )
  );
  const source = fs.readFileSync(
    path.join(root, 'scripts/lib/installed-evidence-acceptance-runtime.js'),
    'utf8'
  );
  assert.match(source, /flag: 'wx'/);
  assert.match(source, /request_max_retries: 0/);
  assert.match(source, /stream_max_retries: 0/);
  assert.doesNotMatch(source, /thread\/resume|thread\/read|auth\.json/);
  assert.match(source, /readerEnvelope = undefined/);
  assert.match(source, /report\[key\] = false/);
  assert.match(source, /if \(!acceptanceCyclePassed\(cycle\)\) throw/);
});
