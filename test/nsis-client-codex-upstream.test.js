'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createCodexSyntheticUpstream } = require('../scripts/lib/nsis-client-codex-upstream');
const { decodeContextRecoveryEnvelope } = require('../lib/proxy/context-recovery-protocol');
const { assertNativeCompactionResponse } = require('../lib/proxy/native-responses-compaction');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const LIST = 'hpm_list_retained_evidence',
  READ = 'hpm_read_retained_evidence';
const marker = 'HPM_SYNTHETIC_' + 'a'.repeat(32);
const original = 'Synthetic upstream\r\n中文🙂\r\nREQUIRED_MARKER=' + marker;
const options = { mode: 'enhanced', model: 'fixture-model', original, marker };
const failure = { message: 'nsis_codex_upstream_failed' };
const tools = [LIST, READ].map((name) => ({ type: 'function', name }));
const tagged = (body) => ({
  ...body,
  observation: 'client_reported',
  verification: 'not_verified',
});
const body = (input, privateTools = true, stream = true) => ({
  model: options.model,
  input,
  tools: privateTools ? tools : [],
  stream,
});
const output = (call, value) => ({
  type: 'function_call_output',
  call_id: call.call_id,
  output: typeof value === 'string' ? value : JSON.stringify(value),
});
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const decode = (result) => decodeContextRecoveryEnvelope('responses', result.wire, result.stream);
const respond = (upstream, value, path = '/v1/responses') =>
  upstream.respond({ path, body: value });

test('real enhanced session seed uses private recovery then an independent public READY', () => {
  const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
  const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  const upstream = createCodexSyntheticUpstream(options);
  const prepared = {
    profile: { id: 'seed-fixture', protocol: 'openai', targetUrl: 'https://api.openai.com/v1' },
    authMode: 'api-key',
    rewriteTo: '-',
  };
  const auth = { ok: true, enabled: true, key: { id: 'fixture-owner' } };
  const seed = {
    ...body([user('seed')], false),
    tools: [
      {
        type: 'function',
        name: 'hpm_fixture_original',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    tool_choice: 'auto',
  };
  const begin = (input) =>
    beginContextRecoveryRequest(runtime, {
      auth,
      kind: 'responses',
      prepared,
      buffer: Buffer.from(JSON.stringify(input)),
    });
  let first, view, run;
  try {
    upstream.setPhase('seed');
    first = begin(seed);
    assert.equal(first.ok, true);
    const call = decode(respond(upstream, seed)).output[0];
    assert.equal(
      first.complete(
        [call],
        [{ callId: call.call_id, toolName: call.name, arguments: {}, completed: true, output: '' }]
      ).ok,
      true
    );
    const next = { ...seed, input: [...seed.input, call, output(call, original)] };
    view = begin(next);
    assert.equal(view.ok, true);
    assert.equal(view.inspect().visibleSources, 1);
    run = view.recovery(next, { publicGeneration: 'isolated' });
    assert.equal(run.ok, true);
    assert.deepEqual(
      run.initialRequest.tools.map((tool) => tool.name),
      [LIST, READ]
    );
    const privateReply = decode(respond(upstream, run.initialRequest));
    assert.match(JSON.stringify(privateReply), /private-thinking-sentinel/);
    const publicTurn = run.accept(privateReply);
    assert.equal(publicTurn.ok, true);
    assert.equal(publicTurn.mode, 'continue');
    assert.deepEqual(JSON.parse(JSON.stringify(publicTurn.request.tools)), seed.tools);
    assert.doesNotMatch(
      JSON.stringify(publicTurn.request),
      /private-thinking-sentinel|hpm_list_retained_evidence|hpm_read_retained_evidence/
    );
    const publicReply = decode(respond(upstream, publicTurn.request));
    assert.equal(publicReply.output[0].content[0].text, 'READY');
    assert.equal(run.accept(publicReply).mode, 'release');
    assert.equal(upstream.inspect().requests, 3);
    assert.equal(upstream.inspect().sourceCalls, 1);
    assert.equal(upstream.inspect().sourceObserved, true);
    assert.equal(upstream.inspect().failed, false);
    upstream.setPhase('compact-1');
  } finally {
    run?.cancel();
    view?.abort();
    first?.abort();
    runtime.close();
  }
});

test('private seed cannot finish early, replay, change originals or leak private data into its public request', () => {
  for (const fault of [
    'early-phase',
    'replay-private',
    'second-private',
    'changed-original',
    'empty-history',
    'private-public',
    'public-private-tool',
    'default-private',
  ]) {
    const upstream = createCodexSyntheticUpstream({
      ...options,
      mode: fault === 'default-private' ? 'default' : 'enhanced',
    });
    upstream.setPhase('seed');
    const seed = {
      ...body([user('seed')], false),
      tools: [{ type: 'function', name: 'hpm_fixture_original' }],
    };
    const call = decode(respond(upstream, seed)).output[0];
    const privateRequest = body([output(call, original)]);
    if (fault === 'default-private') {
      assert.throws(() => respond(upstream, privateRequest), failure);
      continue;
    }
    const reply = decode(respond(upstream, privateRequest));
    assert.match(JSON.stringify(reply), /private-thinking-sentinel/);
    const publicRequest = { ...seed, input: [output(call, original)] };
    const reject = () => {
      if (fault === 'early-phase') return upstream.setPhase('compact-1');
      if (fault === 'replay-private') return respond(upstream, privateRequest);
      if (fault === 'second-private')
        return respond(upstream, body([user('again'), output(call, original)]));
      if (fault === 'changed-original') publicRequest.input = [output(call, original + 'changed')];
      if (fault === 'empty-history') publicRequest.input = [];
      if (fault === 'private-public') publicRequest.input.push(user('private-thinking-sentinel'));
      if (fault === 'public-private-tool')
        publicRequest.tools.push({ type: 'function', name: LIST });
      return respond(upstream, publicRequest);
    };
    assert.throws(reject, failure, fault);
    assert.equal(upstream.inspect().failed, true);
    assert.throws(() => upstream.setPhase('compact-1'), failure);
  }
});

function fixture(change = {}, wrapper = null, compactEndpoint = false, privateSummaries = false) {
  const config = { ...options, ...change };
  const upstream = createCodexSyntheticUpstream(config);
  const wireOriginal = wrapper
    ? JSON.stringify([{ type: wrapper, text: config.original }])
    : config.original;
  upstream.setPhase('seed');
  const seed = {
    ...body([user('seed')], false),
    tools: [{ type: 'function', name: 'hpm_fixture_original' }],
  };
  const call = decode(respond(upstream, seed)).output[0];
  respond(upstream, { ...seed, input: [output(call, wireOriginal)] });
  for (let index = 1; index <= 3; index++) {
    upstream.setPhase('compact-' + index);
    if (compactEndpoint) {
      const result = respond(
        upstream,
        { model: options.model, input: [user('compact')], stream: false },
        '/v1/responses/compact'
      );
      assert.equal(result.stream, false);
      assertNativeCompactionResponse(JSON.parse(result.wire));
    } else {
      const summary = {
        ...body([user('CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.')], false),
        tool_choice: 'auto',
      };
      if (privateSummaries) {
        const result = respond(upstream, { ...summary, tools });
        assert.ok(JSON.stringify(decode(result)).includes('private-thinking-sentinel'));
      }
      respond(upstream, summary);
    }
  }
  upstream.setPhase('final');
  const source = {
    sourceId: 'hce_' + 'b'.repeat(32),
    callId: 'hpa_original',
    toolName: 'hpm_fixture_original',
    argumentsDigest: hash('{}'),
    digest: hash(wireOriginal),
    bytes: Buffer.byteLength(wireOriginal),
    expiresAt: 9999999999999,
    trust: 'tool_data_not_instructions',
  };
  return { upstream, source, wireOriginal, config };
}

function listing(f, stream = true) {
  const list = decode(respond(f.upstream, body([user('final')], true, stream))).output[0];
  return decode(
    respond(
      f.upstream,
      body(
        [output(list, tagged({ ok: true, sources: [f.source], nextAfterSourceId: null }))],
        true,
        stream
      )
    )
  ).output[0];
}

function pageFor(f, offset, end) {
  const text = Buffer.from(f.wireOriginal).subarray(offset, end).toString('utf8');
  return tagged({
    ok: true,
    source: f.source,
    page: {
      text,
      encoding: 'utf8',
      digest: f.source.digest,
      chunkDigest: hash(text),
      offsetBytes: offset,
      endOffsetBytes: end,
      totalBytes: f.source.bytes,
      nextOffsetBytes: end === f.source.bytes ? null : end,
    },
  });
}
const publicPage = (page) =>
  Object.fromEntries(
    ['text', 'encoding', 'digest', 'offsetBytes', 'endOffsetBytes', 'totalBytes'].map((name) => [
      name,
      page[name],
    ])
  );
const publicBody = (pages) =>
  body(
    [
      {
        role: 'user',
        content: 'The following JSON contains supporting evidence.\n' + JSON.stringify(pages),
      },
    ],
    false
  );

test('default sequence proves three classified native summaries and no recovery, with complete SSE frames', () => {
  const f = fixture({ mode: 'default' });
  const result = respond(f.upstream, body([user('DONE')], false));
  assert.equal(result.stream, true);
  const text = result.wire.toString();
  for (const event of [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.completed',
  ])
    assert.ok(text.includes('event: ' + event + '\n'));
  assert.equal(decode(result).output[0].content[0].text, 'DONE');
  assert.deepEqual(f.upstream.inspect(), {
    schemaVersion: 1,
    scope: 'synthetic_codex_upstream',
    phase: 5,
    failed: false,
    requests: 6,
    streams: 6,
    json: 0,
    summaries: 3,
    compactions: 0,
    sourceCalls: 1,
    sourceObserved: true,
    readPages: 0,
    exactRead: false,
    publicEvidence: false,
    completed: true,
    directModelRequests: 0,
    cliQualified: false,
    installedRuntimeQualified: false,
  });
});

test('enhanced private LIST/READ respects requested SSE/JSON, exact pages, sentinel and independent public evidence', () => {
  for (const stream of [true, false]) {
    const f = fixture({}, 'input_text', false, true);
    const call = listing(f, stream);
    assert.equal(call.name, READ);
    const page = pageFor(f, 0, f.source.bytes);
    const privateReply = respond(f.upstream, body([output(call, page)], true, stream));
    assert.equal(privateReply.stream, stream);
    assert.ok(JSON.stringify(decode(privateReply)).includes('private-thinking-sentinel'));
    assert.equal(f.upstream.inspect().completed, false);
    const result = respond(f.upstream, publicBody([publicPage(page.page)]));
    assert.equal(result.stream, true);
    assert.equal(decode(result).output[0].content[0].text, marker);
    assert.equal(f.upstream.inspect().exactRead, true);
    assert.equal(f.upstream.inspect().publicEvidence, true);
    assert.equal(f.upstream.inspect().completed, true);
    const receipt = JSON.stringify(f.upstream.inspect());
    for (const secret of [marker, f.wireOriginal, f.source.digest, f.source.sourceId])
      assert.equal(receipt.includes(secret), false);
  }
});

test('compact endpoint returns actual response.compaction JSON and exact paginated UTF-8 recovery remains required', () => {
  const f = fixture({}, 'text', true);
  let call = listing(f);
  const split = Buffer.from(f.wireOriginal).indexOf(Buffer.from('中文'));
  const first = pageFor(f, 0, split),
    last = pageFor(f, split, f.source.bytes);
  call = decode(respond(f.upstream, body([output(call, first)]))).output[0];
  assert.equal(JSON.parse(call.arguments).offsetBytes, split);
  respond(f.upstream, body([output(call, last)]));
  respond(f.upstream, publicBody([publicPage(first.page), publicPage(last.page)]));
  assert.equal(f.upstream.inspect().compactions, 3);
  assert.equal(f.upstream.inspect().readPages, 2);
  assert.equal(f.upstream.inspect().completed, true);
});

test('invalid constructors and hostile data never execute coercion/accessor hooks', () => {
  let calls = 0;
  const hostile = { ...options };
  Object.defineProperty(hostile, 'original', {
    enumerable: true,
    get() {
      calls++;
      return original;
    },
  });
  for (const input of [
    null,
    {},
    [],
    hostile,
    { ...options, mode: 'real' },
    { ...options, model: '' },
    { ...options, original: '' },
    { ...options, original: 'x'.repeat(65537) + original },
    { ...options, original: '\ud800' + original },
    { ...options, marker: 'PRIVATE' },
    { ...options, original: 'missing-marker' },
    { ...options, extra: 'PRIVATE' },
  ])
    assert.throws(() => createCodexSyntheticUpstream(input), failure);
  assert.equal(calls, 0);
});

test('phase, replay, endpoint, stream, summary classification and request shape failures are permanently sticky', () => {
  const cases = [
    (u) => u.setPhase('final'),
    (u) => u.respond({ path: '/v1/responses', body: body([user('seed')]) }),
    (u) => {
      u.setPhase('seed');
      u.setPhase('compact-1');
    },
    (u) => {
      u.setPhase('seed');
      respond(u, body([user('seed')], false));
    },
    (u) => {
      u.setPhase('seed');
      respond(u, body([], false));
    },
    (u) => {
      u.setPhase('seed');
      respond(u, { ...body([user('seed')], false), model: 'wrong' });
    },
    (u) => {
      u.setPhase('seed');
      respond(u, body([user('seed')], false), '/v1/responses?token=PRIVATE');
    },
  ];
  for (const action of cases) {
    const u = createCodexSyntheticUpstream(options);
    assert.throws(() => action(u), failure);
    assert.equal(u.inspect().failed, true);
    assert.throws(() => u.setPhase('seed'), failure);
    assert.throws(() => respond(u, body([user('anything')], false)), failure);
  }
  const u = createCodexSyntheticUpstream(options);
  u.setPhase('seed');
  const seed = {
    ...body([user('seed')], false),
    tools: [{ type: 'function', name: 'hpm_fixture_original' }],
  };
  respond(u, seed);
  assert.throws(() => respond(u, seed), failure);
  for (const change of [
    { stream: false },
    { stream: null },
    { stream: 'true' },
    { tools: [tools[0]] },
  ]) {
    const f = fixture();
    assert.throws(
      () =>
        respond(f.upstream, {
          ...body([user('final')]),
          ...change,
          ...(change.stream === false ? { tools: [] } : {}),
        }),
      failure
    );
  }
});

test('native original must match exact known text envelope rather than merely include the marker', () => {
  for (const value of [
    'PRIVATE ' + original,
    JSON.stringify([{ type: 'text', text: original, private: true }]),
    JSON.stringify([
      { type: 'text', text: original },
      { type: 'text', text: 'extra' },
    ]),
  ]) {
    const u = createCodexSyntheticUpstream(options);
    u.setPhase('seed');
    const seed = {
      ...body([user('seed')], false),
      tools: [{ type: 'function', name: 'hpm_fixture_original' }],
    };
    const call = decode(respond(u, seed)).output[0];
    assert.throws(() => respond(u, { ...seed, input: [output(call, value)] }), failure);
  }
});

test('source and read witness reject changed digest, source identity, range, UTF-8, failure and duplicate output', () => {
  for (const change of [
    (value) => {
      value.page.digest = '0'.repeat(64);
    },
    (value) => {
      value.source.sourceId = 'hce_' + 'c'.repeat(32);
    },
    (value) => {
      value.page.offsetBytes = 1;
    },
    (value) => {
      value.page.text = 'PRIVATE';
      value.page.chunkDigest = hash('PRIVATE');
    },
    (value) => {
      value.page.nextOffsetBytes = 0;
    },
    (value) => {
      value.verification = 'verified';
    },
    (value) => {
      value.ok = false;
    },
  ]) {
    const f = fixture(),
      call = listing(f),
      page = globalThis.structuredClone(pageFor(f, 0, f.source.bytes));
    change(page);
    assert.throws(() => respond(f.upstream, body([output(call, page)])), failure);
  }
  const f = fixture(),
    call = listing(f),
    item = output(call, pageFor(f, 0, f.source.bytes));
  assert.throws(() => respond(f.upstream, body([item, item])), failure);
});

test('public generation cannot precede private READ or carry private tools, sentinels, reordered or incorrect support pages', () => {
  const early = fixture();
  assert.throws(() => respond(early.upstream, publicBody([])), failure);
  for (const alter of [
    (value) => {
      value.input[0].content += ' private-thinking-sentinel';
    },
    (value) => {
      value.input[0].content += ' hpm_read_retained_evidence';
    },
    (value) => {
      value.input[0].content = 'The following JSON contains supporting evidence.\n[]';
    },
    (value) => {
      value.stream = false;
    },
  ]) {
    const f = fixture(),
      call = listing(f),
      page = pageFor(f, 0, f.source.bytes);
    respond(f.upstream, body([output(call, page)]));
    const value = publicBody([publicPage(page.page)]);
    alter(value);
    assert.throws(() => respond(f.upstream, value), failure);
  }
});

test('LIST association rejects wrong original metadata, extra sources and noncanonical duplicate JSON keys', () => {
  for (const alter of [
    (value) => {
      value.sources[0].digest = '0'.repeat(64);
    },
    (value) => {
      value.sources[0].bytes++;
    },
    (value) => {
      value.sources.push({ ...value.sources[0] });
    },
    (value) => {
      value.nextAfterSourceId = value.sources[0].sourceId;
    },
    (value) => {
      value.observation = 'trusted';
    },
  ]) {
    const f = fixture(),
      call = decode(respond(f.upstream, body([user('final')]))).output[0];
    const value = tagged({
      ok: true,
      sources: [globalThis.structuredClone(f.source)],
      nextAfterSourceId: null,
    });
    alter(value);
    assert.throws(() => respond(f.upstream, body([output(call, value)])), failure);
  }
  const f = fixture(),
    call = decode(respond(f.upstream, body([user('final')]))).output[0];
  const value = JSON.stringify(tagged({ ok: true, sources: [f.source], nextAfterSourceId: null }));
  assert.throws(
    () =>
      respond(
        f.upstream,
        body([output(call, value.replace('{"ok":true', '{"ok":false,"ok":true'))])
      ),
    failure
  );
});

test('public support requires exact contiguous coverage, no duplicate or reordered pages, and no extra fields', () => {
  for (const alter of [
    (pages) => pages.reverse(),
    (pages) => pages.pop(),
    (pages) => pages.push({ ...pages[1] }),
    (pages) => {
      pages[0].private = 'extra';
    },
    (pages) => {
      pages[0].digest = '0'.repeat(64);
    },
    (pages) => {
      pages[0].text = 'PRIVATE';
    },
    (pages) => {
      pages[0].endOffsetBytes = Number.MAX_SAFE_INTEGER;
    },
  ]) {
    const f = fixture(),
      split = 8;
    let call = listing(f);
    const first = pageFor(f, 0, split),
      last = pageFor(f, split, f.source.bytes);
    call = decode(respond(f.upstream, body([output(call, first)]))).output[0];
    respond(f.upstream, body([output(call, last)]));
    const pages = [publicPage(first.page), publicPage(last.page)];
    alter(pages);
    assert.throws(() => respond(f.upstream, publicBody(pages)), failure);
  }
});

test('fixed request cap rejects overlong pagination without returning a passing completion', () => {
  const f = fixture();
  let call = listing(f),
    offset = 0;
  while (f.upstream.inspect().requests < 24) {
    const start = offset;
    offset++;
    call = decode(respond(f.upstream, body([output(call, pageFor(f, start, offset))]))).output[0];
  }
  const start = offset;
  offset++;
  assert.throws(
    () => respond(f.upstream, body([output(call, pageFor(f, start, offset))])),
    failure
  );
  assert.equal(f.upstream.inspect().requests, 24);
  assert.equal(f.upstream.inspect().failed, true);
  assert.equal(f.upstream.inspect().completed, false);
});

test('compact streaming/stateful controls and unclassified summaries reject instead of silently changing protocol', () => {
  for (const control of [
    { stream: true },
    { stream: 'false' },
    { store: true },
    { context_management: {} },
    { previous_response_id: 'old' },
    { conversation: 'old' },
  ]) {
    const u = createCodexSyntheticUpstream(options);
    u.setPhase('seed');
    const seed = {
      ...body([user('seed')], false),
      tools: [{ type: 'function', name: 'hpm_fixture_original' }],
    };
    const call = decode(respond(u, seed)).output[0];
    respond(u, { ...seed, input: [output(call, original)] });
    u.setPhase('compact-1');
    assert.throws(
      () =>
        respond(
          u,
          { model: options.model, input: [user('compact')], ...control },
          '/v1/responses/compact'
        ),
      failure
    );
  }
  const u = createCodexSyntheticUpstream(options);
  u.setPhase('seed');
  const seed = {
    ...body([user('seed')], false),
    tools: [{ type: 'function', name: 'hpm_fixture_original' }],
  };
  const call = decode(respond(u, seed)).output[0];
  respond(u, { ...seed, input: [output(call, original)] });
  u.setPhase('compact-1');
  assert.throws(
    () => respond(u, body([user('ordinary request is not a native summary')], false)),
    failure
  );
});
