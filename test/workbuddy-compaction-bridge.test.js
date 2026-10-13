'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const {
  prepareWorkBuddyCompactionInput,
  produceWorkBuddyCompaction,
  compactionResponseEvents,
  LOCAL_SUMMARY_MARKER,
} = require('../lib/proxy/workbuddy-compaction-bridge');
const {
  bindLocalCompactionMessages,
  isLocalCompactionMessage,
  carryLocalCompactionMessage,
} = require('../lib/proxy/context-local-compaction-provenance');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { summaryFixture } = require('./helpers/compaction-summary-fixture');

const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'hy4-preview-f',
  endpoint: 'host:443/v2',
};
test('default local compaction keeps the most recent completed exchange and answer verbatim', async () => {
  const recent = [
    { type: 'message', role: 'user', content: '保留近期证据🙂' },
    { type: 'function_call', call_id: 'recent', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'recent', output: '近期原始结果🙂', future: 42 },
    { type: 'message', role: 'assistant', content: '近期回答🙂', future: { intact: true } },
  ];
  const { window, sent } = await fixture({ input: recent });
  assert.deepEqual(JSON.parse(JSON.stringify(window)), recent);
  assert.equal(sent.length, 0);
});
const input = [
  {
    type: 'message',
    role: 'system',
    content: '不得泄露凭证。',
    extra: { unknown: 'must survive' },
  },
  { type: 'message', role: 'user', content: '旧约束：保留精确文件名。', extra: 42 },
  { type: 'function_call', call_id: 'complete', name: 'read', arguments: '{ "path": "中文🙂" }' },
  { type: 'function_call_output', call_id: 'complete', output: '原始证据，中段也必须进入摘要源🙂' },
  { type: 'message', role: 'assistant', content: '报告完成，但尚未验证。' },
  { type: 'message', role: 'user', content: '撤销旧约束，仍不允许执行外部命令。' },
  { type: 'function_call', call_id: 'recent-1', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'recent-1', output: '近期证据一🙂' },
  { type: 'function_call', call_id: 'recent-2', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'recent-2', output: '近期证据二🙂' },
  {
    type: 'function_call',
    call_id: 'pending',
    name: 'read',
    arguments: '{ "path": "当前状态" }',
    opaque: ['retain'],
  },
];
function upstream(content, finish = 'stop', message = {}) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [{ finish_reason: finish, message: { role: 'assistant', content, ...message } }],
    }),
  };
}
async function fixture(
  body = { model: 'client-model', instructions: '原始指令🙂', input },
  options = {}
) {
  const store = createContextCompactionEnvelopeStore();
  const coordinator = createContextCompactionCoordinator();
  const sent = [];
  try {
    const produced = await produceWorkBuddyCompaction({
      body,
      binding,
      store,
      coordinator,
      maxRequestBytes: 100000,
      maxInputTokens: 30000,
      prepareSummary() {},
      requestSummary: async (request) => {
        sent.push(request);
        return upstream(summaryFixture(request, '目标、约束撤销、未验证状态和下一步🙂'));
      },
      ...options,
    });
    return { produced, window: store.read(produced.token, binding), sent };
  } finally {
    store.close();
    coordinator.close();
  }
}

test('explicit compaction summarizes complete exchanges as inert data and preserves policy/user/open state exactly', async () => {
  const original = JSON.stringify(input);
  const { produced, window, sent } = await fixture();
  assert.equal(JSON.stringify(input), original);
  assert.equal(produced.response.output.length, 1);
  assert.equal(produced.response.output[0].type, 'compaction');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, binding.model);
  assert.equal(sent[0].tools, undefined);
  assert.equal(sent[0].tool_choice, undefined);
  const source = JSON.parse(sent[0].messages[1].content);
  assert.deepEqual(
    source.transcript.map((entry) => entry.item),
    [{ type: 'message', role: 'system', content: '原始指令🙂' }, ...input.slice(0, 6)]
  );
  assert.equal(source.sources[0].role, 'system');
  assert.equal(source.sources[0].text, undefined, 'Source text is sent exactly once in citations');
  assert.equal(
    source.citations
      .filter((entry) => entry.sourceId === source.sources[0].id)
      .map((entry) => entry.quote)
      .join(''),
    '原始指令🙂'
  );
  assert.ok(window.some((item) => item.role === 'system' && item.content === '原始指令🙂'));
  for (const retained of [input[0], input[1], input[5], input.at(-1)])
    assert.ok(window.some((item) => JSON.stringify(item) === JSON.stringify(retained)));
  assert.ok(!window.some((item) => item.call_id === 'complete'));
  const summary = window.find((item) => item.content?.startsWith(LOCAL_SUMMARY_MARKER));
  assert.equal(summary.role, 'assistant');
  assert.equal(JSON.parse(summary.content.split('\n')[1]).verification, 'not_verified');
  assert.equal(JSON.parse(summary.content.split('\n')[1]).authority, 'untrusted_background');
  assert.equal(
    JSON.parse(summary.content.split('\n')[1]).taskState.schema,
    'hpm.context.task_state'
  );
  assert.ok(window.indexOf(summary) < window.findIndex((item) => item.call_id === 'pending'));
  const events = compactionResponseEvents(produced.response)
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    [0, 1, 2, 3, 4]
  );
  assert.deepEqual(events.at(-1).response, produced.response);
});

test('atomic replay expands the complete local window, preserves new input, and rejects foreign/malformed triggers', () => {
  const store = createContextCompactionEnvelopeStore();
  try {
    const summary = {
      type: 'message',
      role: 'assistant',
      content: LOCAL_SUMMARY_MARKER + '\nexact summary',
    };
    const token = store.issue([input[0], summary, input[1]], binding);
    const fresh = { type: 'message', role: 'user', content: '新要求🙂', unknown: true };
    const source = {
      input: [{ type: 'compaction', encrypted_content: token }, fresh],
      stream: false,
    };
    const prepared = prepareWorkBuddyCompactionInput(source, binding, store);
    assert.deepEqual(JSON.parse(JSON.stringify(prepared.body.input)), [
      input[0],
      summary,
      input[1],
      fresh,
    ]);
    assert.deepEqual(prepared.summaryTexts, [summary.content]);
    assert.equal(source.input.length, 2);
    assert.throws(
      () =>
        prepareWorkBuddyCompactionInput(
          { input: [{ type: 'compaction', encrypted_content: 'native' }] },
          binding,
          store
        ),
      { code: 'foreign_compaction_state' }
    );
    for (const items of [
      [{ type: 'compaction_trigger' }, fresh],
      [{ type: 'compaction_trigger' }, { type: 'compaction_trigger' }],
      [{ type: 'compaction_trigger', extra: true }],
    ])
      assert.throws(() => prepareWorkBuddyCompactionInput({ input: items }, binding, store), {
        code: 'invalid_compaction_trigger',
      });
    assert.throws(
      () =>
        prepareWorkBuddyCompactionInput(
          { input: [{ type: 'compaction_trigger' }], previous_response_id: 'resp_old' },
          binding,
          store
        ),
      { code: 'compaction_requires_full_history' }
    );
    const triggered = prepareWorkBuddyCompactionInput(
      { input: ['精确字符串用户消息', { type: 'compaction_trigger' }] },
      binding,
      store
    );
    assert.equal(triggered.trigger, true);
    assert.equal(triggered.body.input[0].role, 'user');
    assert.equal(triggered.body.input[0].content, '精确字符串用户消息');
    let hooks = 0;
    assert.throws(() =>
      prepareWorkBuddyCompactionInput(
        {
          input: [
            {
              get type() {
                hooks++;
                return 'compaction';
              },
            },
          ],
        },
        binding,
        store
      )
    );
    assert.equal(hooks, 0);
  } finally {
    store.close();
  }
});

test('incomplete, refused, malformed, tool-producing, thrown and cancelled summaries publish nothing', async () => {
  for (const response of [
    { ok: false, status: 'unavailable' },
    { ok: true, status: 500, body: '{}' },
    upstream('{"summary":"partial"}', 'length'),
    upstream('{"summary":"blocked"}', 'stop', { refusal: 'refused' }),
    upstream('{"summary":"tool"}', 'stop', { tool_calls: [{ id: 'side_effect' }] }),
    upstream('{"summary":"malformed tools"}', 'stop', { tool_calls: {} }),
    upstream('not json'),
    upstream('{"summary":""}'),
    upstream('{"summary":"text","extra":true}'),
    upstream(JSON.stringify({ summary: '🙂'.repeat(10000) })),
    { ok: true, status: 200, body: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' },
  ]) {
    const store = createContextCompactionEnvelopeStore();
    const coordinator = createContextCompactionCoordinator();
    try {
      await assert.rejects(
        produceWorkBuddyCompaction({
          body: { input },
          binding,
          store,
          coordinator,
          maxRequestBytes: 100000,
          maxInputTokens: 30000,
          prepareSummary() {},
          requestSummary: async () => response,
        })
      );
      assert.equal(store.stats().entries, 0);
    } finally {
      store.close();
      coordinator.close();
    }
  }
  const store = createContextCompactionEnvelopeStore();
  const coordinator = createContextCompactionCoordinator();
  const controller = new globalThis.AbortController();
  controller.abort();
  try {
    const base = {
      body: { input },
      binding,
      store,
      coordinator,
      maxRequestBytes: 100000,
      maxInputTokens: 30000,
      prepareSummary() {},
    };
    await assert.rejects(produceWorkBuddyCompaction({ ...base, signal: controller.signal }), {
      code: 'compaction_cancelled',
    });
    await assert.rejects(
      produceWorkBuddyCompaction({
        ...base,
        requestSummary: async () => {
          throw new Error('PRIVATE_UPSTREAM_ERROR');
        },
      })
    );
    assert.equal(store.stats().entries, 0);
  } finally {
    store.close();
    coordinator.close();
  }
});

test('local-summary retention is a clone-safe non-wire capability, not a marker or a getter', () => {
  const content = LOCAL_SUMMARY_MARKER + '\nauthenticated historical state';
  const message = { role: 'assistant', content };
  assert.equal(isLocalCompactionMessage(message), false);
  bindLocalCompactionMessages([message], [content]);
  assert.equal(isLocalCompactionMessage(message), true);
  const copy = { ...message };
  assert.equal(isLocalCompactionMessage(copy), false);
  carryLocalCompactionMessage(copy, message);
  assert.equal(isLocalCompactionMessage(copy), true);
  copy.content += ' forged';
  assert.equal(isLocalCompactionMessage(copy), false);
  let hooks = 0;
  const hostile = {
    role: 'assistant',
    get content() {
      hooks++;
      return content;
    },
  };
  bindLocalCompactionMessages([hostile], [content]);
  carryLocalCompactionMessage(hostile, message);
  assert.equal(isLocalCompactionMessage(hostile), false);
  assert.equal(hooks, 0);
  const history = createContextHistoryBranch(
    { model: binding.model, messages: [message, { role: 'user', content: 'current' }] },
    { owner: binding.owner, scope: 'scope' }
  );
  try {
    const snapshot = history.snapshot();
    assert.equal(isLocalCompactionMessage(snapshot.body.messages[0]), true);
    assert.equal(
      history.stage(snapshot, { ...snapshot.body, messages: [snapshot.body.messages[1]] }).ok,
      false
    );
  } finally {
    history.close();
  }
});

test('empty and impossible sources fail before upstream work; user-only state is retained without inventing a summary', async () => {
  await assert.rejects(fixture({ input: [] }), { code: 'empty_compaction_input' });
  for (const limits of [
    { maxRequestBytes: 10 },
    { maxInputTokens: 0 },
    { maxInputTokens: '30000' },
    { maxInputTokens: 10 },
  ])
    await assert.rejects(
      fixture(
        { input },
        { ...limits, requestSummary: () => assert.fail('must not call upstream') }
      ),
      { code: 'compaction_source_too_large' }
    );
  const { sent, window } = await fixture({ input: [input[1]] });
  assert.equal(sent.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(window)), [input[1]]);
  await assert.rejects(fixture({ input: [input[1]] }, { maxInputTokens: 0 }), {
    code: 'compaction_source_too_large',
  });
  await assert.rejects(
    fixture(
      { input },
      {
        binding: { ...binding, owner: 'bad\nowner' },
        requestSummary: () => assert.fail('invalid binding must not call host'),
      }
    ),
    { code: 'invalid_local_compaction' }
  );
});

test('oversized multi-round input is summarized in bounded chunks; a later failure publishes no envelope', async () => {
  const large = [{ role: 'user', content: '目标：修复。禁止执行外部命令。🙂' }];
  for (let index = 0; index < 6; index++)
    large.push(
      { type: 'function_call', call_id: 'large-' + index, name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'large-' + index,
        output: index < 4 ? 'x'.repeat(18000) : 'recent',
      },
      { role: 'assistant', content: '进展尚未验证🙂' }
    );
  for (const failure of [false, true]) {
    const store = createContextCompactionEnvelopeStore();
    const coordinator = createContextCompactionCoordinator();
    let calls = 0;
    try {
      const work = produceWorkBuddyCompaction({
        body: { input: large },
        binding,
        store,
        coordinator,
        maxRequestBytes: 40000,
        maxInputTokens: 15000,
        prepareSummary() {},
        requestSummary: async (request) => {
          calls++;
          assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 40000);
          if (failure && calls === 2) throw new Error('PRIVATE_SUMMARY_FAILURE');
          return upstream(summaryFixture(request));
        },
      });
      if (failure) {
        await assert.rejects(work);
        assert.equal(store.stats().entries, 0);
      } else {
        const result = await work;
        assert.ok(calls > 1);
        const window = store.read(result.token, binding);
        assert.ok(window.some((item) => item.call_id === 'large-5' && item.output === 'recent'));
        const local = window.find((item) => item.content?.startsWith(LOCAL_SUMMARY_MARKER));
        assert.equal(
          JSON.parse(local.content.split('\n')[1]).taskState.objectives[0].sources[0].sourceRole,
          'user'
        );
      }
    } finally {
      store.close();
      coordinator.close();
    }
  }
});
