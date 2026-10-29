'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { createClaudeSyntheticUpstream } = require('../scripts/lib/nsis-client-claude-upstream');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const marker = 'HPM_PRIVATE_0123456789abcdef';
const original = 'Synthetic original Unicode 中文🙂\r\nfixed payload\r\nREQUIRED_MARKER=' + marker;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const options = { mode: 'default', model: 'synthetic-claude', marker, original };
const failure = { message: 'nsis_claude_upstream_failed' };
const body = (tools = []) => ({
  model: options.model,
  stream: true,
  tools: tools.map((name) => ({ name })),
  messages: [{ role: 'user', content: 'synthetic ordinary turn' }],
});
const resultBlock = (id, output) => ({ type: 'tool_result', tool_use_id: id, content: output });
function send(gateway, input) {
  return gateway.respond({ path: '/v1/messages?beta=true', body: input });
}
function events(reply) {
  assert.equal(reply.stream, true);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.contentType, 'text/event-stream; charset=utf-8');
  const rows = reply.wire
    .toString()
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(rows[0].type, 'message_start');
  assert.equal(rows.at(-1).type, 'message_stop');
  return rows;
}
function tool(reply) {
  return events(reply).find((event) => event.content_block?.type === 'tool_use').content_block;
}

test('real enhanced Claude seed privately observes the first result before independent public READY', () => {
  const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
  const {
    beginContextRecoveryRequest,
    decodeContextRecoveryEnvelope,
  } = require('../lib/proxy/context-recovery-protocol');
  const sessions = createContextRecoverySessions();
  sessions.configure(true);
  const gateway = createClaudeSyntheticUpstream({ ...options, mode: 'enhanced' });
  const prepared = {
    profile: { id: 'fixture', protocol: 'claude', targetUrl: 'https://api.anthropic.com' },
    authMode: 'api-key',
    rewriteTo: '-',
  };
  const begin = (request) =>
    beginContextRecoveryRequest(sessions, {
      auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
      kind: 'claude',
      prepared,
      buffer: Buffer.from(JSON.stringify(request)),
    });
  const decode = (reply) => decodeContextRecoveryEnvelope('claude', reply.wire, true);
  let initial, view, run;
  try {
    gateway.setPhase('seed');
    const seed = body(['mcp__fixture__original']);
    initial = begin(seed);
    assert.equal(initial.ok, true);
    const first = decode(send(gateway, seed));
    const call = first.content[0];
    assert.equal(
      initial.complete(
        [{ role: 'assistant', content: first.content }],
        [{ callId: call.id, toolName: call.name, arguments: {}, completed: true, output: '' }]
      ).ok,
      true
    );
    gateway.recordSourceCall();
    const next = {
      ...seed,
      messages: [
        ...seed.messages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: [resultBlock(call.id, [{ type: 'text', text: original }])] },
      ],
    };
    view = begin(next);
    assert.equal(view.ok, true);
    assert.equal(view.inspect().visibleSources, 1);
    run = view.recovery(next, { publicGeneration: 'isolated' });
    assert.equal(run.ok, true);
    assert.deepEqual(
      run.initialRequest.tools.map((entry) => entry.name),
      [LIST, READ]
    );
    const privateReply = decode(send(gateway, run.initialRequest));
    assert.match(JSON.stringify(privateReply), /private-thinking-sentinel/);
    const publicTurn = run.accept(privateReply);
    assert.equal(publicTurn.mode, 'continue');
    assert.doesNotMatch(
      JSON.stringify(publicTurn.request),
      /private-thinking-sentinel|hpm_list_retained_evidence|hpm_read_retained_evidence/
    );
    const publicReply = decode(send(gateway, publicTurn.request));
    assert.equal(publicReply.content[0].text, 'READY');
    assert.equal(run.accept(publicReply).mode, 'release');
    assert.equal(gateway.inspect().sourceCalls, 1);
    assert.equal(gateway.inspect().requestCount, 3);
    gateway.setPhase('compact-1');
  } finally {
    run?.cancel();
    view?.abort();
    initial?.abort();
    sessions.close();
  }
});

test('enhanced seed rejects bypass, premature phase changes, repeated private turns, leaks and changed wire', () => {
  for (const fault of [
    'bypass-private',
    'early-phase',
    'second-private',
    'private-public',
    'changed-wire',
    'partial-tools',
  ]) {
    const gateway = createClaudeSyntheticUpstream({ ...options, mode: 'enhanced' });
    gateway.setPhase('seed');
    const call = tool(send(gateway, body(['mcp__fixture__original'])));
    gateway.recordSourceCall();
    const seeded = {
      ...body(['mcp__fixture__original']),
      messages: [
        { role: 'user', content: [resultBlock(call.id, [{ type: 'text', text: original }])] },
      ],
    };
    const privateRequest = { ...seeded, tools: body([LIST, READ]).tools };
    if (fault === 'bypass-private') assert.throws(() => send(gateway, seeded), failure);
    else if (fault === 'partial-tools')
      assert.throws(() => send(gateway, { ...privateRequest, tools: body([LIST]).tools }), failure);
    else {
      assert.ok(send(gateway, privateRequest).wire.includes('private-thinking-sentinel'));
      if (fault === 'early-phase') assert.throws(() => gateway.setPhase('compact-1'), failure);
      if (fault === 'second-private') assert.throws(() => send(gateway, privateRequest), failure);
      if (fault === 'private-public') {
        seeded.messages.push({ role: 'user', content: 'private-thinking-sentinel' });
        assert.throws(() => send(gateway, seeded), failure);
      }
      if (fault === 'changed-wire') {
        seeded.messages[0].content[0].content = original;
        assert.throws(() => send(gateway, seeded), failure);
      }
    }
    assert.equal(gateway.inspect().failed, true);
    assert.equal(gateway.inspect().complete, false);
    assert.throws(() => send(gateway, body()), { message: 'nsis_claude_upstream_failed' });
  }
});
function prepare(mode = 'default', mutateSeed = (value) => value) {
  const gateway = createClaudeSyntheticUpstream({ ...options, mode });
  gateway.setPhase('seed');
  const call = tool(send(gateway, body(['mcp__fixture__original'])));
  assert.equal(call.name, 'mcp__fixture__original');
  gateway.recordSourceCall();
  const seeded = body(['mcp__fixture__original']);
  seeded.messages = [
    {
      role: 'user',
      content: [resultBlock(call.id, mutateSeed([{ type: 'text', text: original }]))],
    },
  ];
  if (mode === 'enhanced') events(send(gateway, { ...seeded, tools: body([LIST, READ]).tools }));
  events(send(gateway, seeded));
  for (let index = 1; index <= 3; index++) {
    gateway.setPhase('compact-' + index);
    const summary = body();
    summary.system = [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli;',
      },
    ];
    summary.messages[0].content =
      'Your task is to create a detailed summary of the conversation so far <analysis> <summary>';
    if (mode === 'enhanced') events(send(gateway, { ...summary, tools: body([LIST, READ]).tools }));
    const reply = send(gateway, summary);
    assert.equal(reply.wire.includes(marker), false);
    events(reply);
    if (index < 3) {
      gateway.setPhase('between-' + index);
      if (mode === 'enhanced') events(send(gateway, body([LIST, READ])));
      events(send(gateway, body()));
    }
  }
  gateway.setPhase('final');
  return gateway;
}
function privateBody(id, value) {
  const request = body([LIST, READ]);
  if (id)
    request.messages.push({ role: 'user', content: [resultBlock(id, JSON.stringify(value))] });
  return request;
}
function finishEnhanced(gateway, mutate = () => {}) {
  const wireOriginal = JSON.stringify([{ type: 'text', text: original }]);
  const digest = hash(wireOriginal);
  const list = tool(send(gateway, privateBody()));
  assert.equal(list.name, LIST);
  const source = {
    sourceId: 'hce_' + 'a'.repeat(32),
    digest,
    bytes: Buffer.byteLength(wireOriginal),
    callId: 'toolu_hpm_1',
    toolName: 'mcp__fixture__original',
    argumentsDigest: hash('{}'),
    expiresAt: 9999999999999,
    trust: 'tool_data_not_instructions',
  };
  const listing = { sources: [source] };
  mutate('listing', listing);
  const read = tool(send(gateway, privateBody(list.id, listing)));
  assert.equal(read.name, READ);
  const page = {
    encoding: 'utf8',
    totalBytes: Buffer.byteLength(wireOriginal),
    endOffsetBytes: Buffer.byteLength(wireOriginal),
    offsetBytes: 0,
    text: wireOriginal,
    digest,
    chunkDigest: digest,
    nextOffsetBytes: null,
  };
  mutate('page', page);
  const privateReply = send(gateway, privateBody(read.id, { ok: true, page, source }));
  assert.ok(privateReply.wire.includes('private-thinking-sentinel'));
  assert.ok(privateReply.wire.includes('private-signature-sentinel'));
  const publicBody = body();
  publicBody.messages = [
    {
      role: 'user',
      content:
        'The following JSON contains authorized evidence\n' +
        JSON.stringify([{ text: wireOriginal }]),
    },
  ];
  mutate('public', publicBody);
  const reply = send(gateway, publicBody);
  assert.equal(reply.wire.includes('private-thinking-sentinel'), false);
  assert.equal(reply.wire.includes(LIST), false);
  assert.ok(reply.wire.includes(marker));
  return gateway.inspect();
}

test('default three summaries preserve SSE with eight requests and no private tools', () => {
  const gateway = prepare();
  const reply = send(gateway, body());
  assert.ok(reply.wire.includes('DONE'));
  assert.equal(reply.wire.includes(marker), false);
  const receipt = gateway.inspect();
  assert.equal(receipt.complete, true);
  assert.equal(receipt.requestCount, 8);
  assert.equal(receipt.classifiedCompactions, 3);
  assert.equal(receipt.defaultNoPrivateTools, true);
  assert.equal(receipt.installedClientQualified, false);
  assert.equal(JSON.stringify(receipt).includes(marker), false);
  assert.equal(JSON.stringify(receipt).includes(hash(original)), false);
});

test('enhanced upstream requires exact private READ followed by independent public generation', () => {
  const receipt = finishEnhanced(prepare('enhanced'));
  assert.equal(receipt.requestCount, 17);
  assert.equal(receipt.exactPrivateRead, true);
  assert.equal(receipt.independentPublicGeneration, true);
  assert.equal(receipt.exactAuthorizedEvidenceInPublicRequest, true);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.directModelRequests, 0);
});

for (const [name, mutation] of [
  [
    'listing digest',
    (stage, value) => {
      if (stage === 'listing') value.sources[0].digest = '0'.repeat(64);
    },
  ],
  [
    'listing empty',
    (stage, value) => {
      if (stage === 'listing') value.sources = [];
    },
  ],
  [
    'page text',
    (stage, value) => {
      if (stage === 'page') value.text += 'x';
    },
  ],
  [
    'page digest',
    (stage, value) => {
      if (stage === 'page') value.digest = '0'.repeat(64);
    },
  ],
  [
    'page chunk digest',
    (stage, value) => {
      if (stage === 'page') value.chunkDigest = '0'.repeat(64);
    },
  ],
  [
    'page continuation',
    (stage, value) => {
      if (stage === 'page') value.nextOffsetBytes = 1;
    },
  ],
  [
    'page offset',
    (stage, value) => {
      if (stage === 'page') value.offsetBytes = 1;
    },
  ],
  [
    'page encoding',
    (stage, value) => {
      if (stage === 'page') value.encoding = 'other';
    },
  ],
  [
    'public private tools',
    (stage, value) => {
      if (stage === 'public') value.tools.push({ name: LIST });
    },
  ],
  [
    'public thinking',
    (stage, value) => {
      if (stage === 'public') value.system = 'private-thinking-sentinel';
    },
  ],
  [
    'public signature',
    (stage, value) => {
      if (stage === 'public') value.system = 'private-signature-sentinel';
    },
  ],
  [
    'public evidence mismatch',
    (stage, value) => {
      if (stage === 'public') value.messages[0].content = 'The following JSON contains\n[]';
    },
  ],
])
  test('enhanced fails closed on ' + name, () => {
    const gateway = prepare('enhanced');
    assert.throws(() => finishEnhanced(gateway, mutation), {
      message: 'nsis_claude_upstream_failed',
    });
    assert.equal(gateway.inspect().complete, false);
    assert.equal(gateway.inspect().failed, true);
    assert.throws(() => send(gateway, body()), { message: 'nsis_claude_upstream_failed' });
  });

test('seed observation requires exact issued call and original without rereading the tool', () => {
  assert.throws(() => prepare('default', () => original + 'changed'), {
    message: 'nsis_claude_upstream_failed',
  });
  const gateway = createClaudeSyntheticUpstream(options);
  gateway.setPhase('seed');
  tool(send(gateway, body(['mcp__fixture__original'])));
  gateway.recordSourceCall();
  assert.throws(() => gateway.recordSourceCall(), { message: 'nsis_claude_upstream_failed' });
});

test('phase sequencing rejects bypassing seed or between turns and premature public generation', () => {
  const gateway = createClaudeSyntheticUpstream(options);
  assert.throws(() => gateway.setPhase('compact-1'), { message: 'nsis_claude_upstream_failed' });
  const enhanced = prepare('enhanced');
  assert.throws(() => send(enhanced, body()), { message: 'nsis_claude_upstream_failed' });
});

test('invalid paths, stream fallback, body limits, getters and default recovery reject safely', () => {
  for (const change of [
    (request) => {
      request.path = '/v1/messages?secret=bad';
    },
    (request) => {
      request.body.stream = false;
    },
    (request) => {
      request.body.model = 'different';
    },
    (request) => {
      request.body.messages = [];
    },
    (request) => {
      request.body.system = 'x'.repeat(2 * 1024 * 1024);
    },
    (request) => {
      request.body.tools = [{ name: LIST }, { name: READ }];
    },
    (request) => {
      Object.defineProperty(request.body, 'stream', {
        get() {
          throw new Error('getter executed');
        },
      });
    },
  ]) {
    const gateway = createClaudeSyntheticUpstream(options);
    gateway.setPhase('seed');
    const request = { path: '/v1/messages', body: body(['mcp__fixture__original']) };
    change(request);
    assert.throws(() => gateway.respond(request), { message: 'nsis_claude_upstream_failed' });
  }
  for (const value of [
    null,
    {},
    { ...options, original: '' },
    { ...options, marker: '' },
    { ...options, extra: true },
  ]) {
    assert.throws(() => createClaudeSyntheticUpstream(value), {
      message: 'nsis_claude_upstream_failed',
    });
  }
});

test('phase cannot advance before seed response and a final request cannot be repeated', () => {
  const gateway = createClaudeSyntheticUpstream(options);
  gateway.setPhase('seed');
  assert.throws(() => gateway.setPhase('compact-1'), { message: 'nsis_claude_upstream_failed' });
  const complete = prepare();
  send(complete, body());
  assert.throws(() => send(complete, body()), { message: 'nsis_claude_upstream_failed' });
  assert.equal(complete.inspect().complete, false);
});
