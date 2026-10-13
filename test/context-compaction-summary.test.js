'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planLocalCompactionSummary,
  runLocalCompactionSummary,
} = require('../lib/proxy/context-compaction-summary');
const { selectLocalCompactionWindow } = require('../lib/proxy/context-compaction-retention');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const { summaryFixture } = require('./helpers/compaction-summary-fixture');
const { estimateTokensForValue } = require('../lib/proxy/inline-media');

const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'host/v2',
};
function history(count = 6, size = 1800) {
  const result = [{ role: 'user', content: '目标🙂，不得执行外部命令。' }];
  for (let i = 0; i < count; i++)
    result.push(
      { type: 'function_call', call_id: 'c' + i, name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'c' + i,
        output: i < count - 2 ? ('证据-' + i + '🙂').repeat(size) : '近期-' + i + '🙂',
      },
      { role: 'assistant', content: '报告进展-' + i + '，尚未验证🙂' }
    );
  return result;
}
function planning(input = history(), overrides = {}) {
  const selection = selectLocalCompactionWindow(input);
  return planLocalCompactionSummary(selection.summaryGroups, {
    model: binding.model,
    maxRequestBytes: 50000,
    maxInputTokens: 15000,
    prepareSummary() {},
    ...overrides,
  });
}
function upstream(content) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  };
}

test('bounded incremental summaries cover every evicted item exactly once, keep exchanges atomic and omit recent originals', async () => {
  const input = history();
  const before = JSON.stringify(input);
  const plan = planning(input);
  assert.ok(plan.chunks.length > 1 && plan.chunks.length <= 16);
  const coordinator = createContextCompactionCoordinator();
  const sent = [];
  try {
    const result = await runLocalCompactionSummary(plan, {
      binding,
      coordinator,
      requestSummary: async (request) => {
        assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 50000);
        assert.ok(estimateTokensForValue(request) <= 15000);
        assert.equal(request.tools, undefined);
        sent.push(JSON.parse(request.messages[1].content));
        return upstream(summaryFixture(request));
      },
    });
    assert.equal(result.state.objectives[0].sources[0].sourceRole, 'user');
    const entries = sent.flatMap((p) => p.transcript);
    const indexed = entries.map((entry) => entry.index);
    assert.equal(new Set(indexed).size, indexed.length);
    assert.deepEqual(
      indexed,
      [...indexed].sort((a, b) => a - b)
    );
    for (let i = 0; i < 4; i++) {
      const chunk = sent.find((p) => p.transcript.some((entry) => entry.item.call_id === 'c' + i));
      assert.equal(chunk.transcript.filter((entry) => entry.item.call_id === 'c' + i).length, 2);
      assert.equal(
        chunk.transcript.find(
          (entry) => entry.item.type === 'function_call_output' && entry.item.call_id === 'c' + i
        ).item.output,
        input[2 + i * 3].output
      );
    }
    assert.ok(!entries.some((e) => ['c4', 'c5'].includes(e.item.call_id)));
    assert.ok(sent.slice(1).every((p) => p.previous?.state?.schema === 'hpm.context.task_state'));
    assert.equal(JSON.stringify(input), before);
  } finally {
    coordinator.close();
  }
});

test('normal, evidence-only and empty plans have explicit state and no invented authoritative sources', async () => {
  const coordinator = createContextCompactionCoordinator();
  try {
    for (const input of [history(3, 1), history(3, 1).filter((item) => item.role == null)]) {
      const plan = planning(input);
      const result = await runLocalCompactionSummary(plan, {
        binding,
        coordinator,
        requestSummary: async (r) => upstream(summaryFixture(r)),
      });
      if (input[0].role === 'user')
        assert.equal(result.state.objectives[0].sources[0].sourceRole, 'user');
      else assert.equal(result.state, null);
    }
    assert.throws(() =>
      planLocalCompactionSummary([], {
        model: 'model',
        maxRequestBytes: 50000,
        maxInputTokens: 15000,
        prepareSummary() {},
      })
    );
  } finally {
    coordinator.close();
  }
});

test('explicit bounded summary transport is independent of client streaming and cannot be mutated during preparation', async () => {
  for (const summaryStream of [false, true]) {
    const coordinator = createContextCompactionCoordinator();
    try {
      const plan = planning(history(3, 1), { summaryStream });
      const result = await runLocalCompactionSummary(plan, {
        binding,
        coordinator,
        requestSummary: async (request) => {
          assert.equal(request.stream, summaryStream);
          assert.equal(request.tools, undefined);
          assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 50000);
          return upstream(summaryFixture(request));
        },
      });
      assert.ok(result.summary);
      assert.throws(
        () =>
          planning(history(3, 1), {
            summaryStream,
            prepareSummary(request) {
              request.stream = !summaryStream;
            },
          }),
        { code: 'invalid_compaction_summary' }
      );
    } finally {
      coordinator.close();
    }
  }
  for (const summaryStream of [0, 1, null, 'true', {}, []])
    assert.throws(() => planning(history(3, 1), { summaryStream }));
  let accessed = false;
  const config = {
    model: binding.model,
    maxRequestBytes: 50000,
    maxInputTokens: 15000,
    prepareSummary() {},
    get summaryStream() {
      accessed = true;
      return true;
    },
  };
  assert.throws(() => planLocalCompactionSummary([], config));
  assert.equal(accessed, false);
  assert.throws(() =>
    planLocalCompactionSummary([], {
      model: binding.model,
      maxRequestBytes: 50000,
      maxInputTokens: 15000,
      prepareSummary() {},
      extra: true,
    })
  );
  assert.equal(accessed, false);
});

test('empty legacy SSE deltas permit tool-free summaries but real and malformed calls remain rejected', async () => {
  const plan = planning(history(3, 1));
  for (const call of [
    {},
    { name: '', arguments: '' },
    { name: 'read', arguments: '{}' },
    { extra: true },
    false,
  ]) {
    const coordinator = createContextCompactionCoordinator();
    try {
      const operation = runLocalCompactionSummary(plan, {
        binding,
        coordinator,
        requestSummary: async (request) => ({
          ok: true,
          status: 200,
          body:
            'data: ' +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: summaryFixture(request),
                    function_call: call,
                  },
                  finish_reason: 'stop',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        }),
      });
      if ((Object.keys(call).length === 0 && call !== false) || call.name === '')
        assert.ok((await operation).summary);
      else await assert.rejects(operation, { code: 'incomplete_compaction_summary' });
    } finally {
      coordinator.close();
    }
  }
});

test('planning rejects unsplittable exchange, excessive chunk count, invalid limits and unsafe preparation before network calls', () => {
  assert.throws(() => planning(history(3, 10000)), { code: 'compaction_source_too_large' });
  assert.throws(() => planning(history(20, 2000)), { code: 'compaction_source_too_large' });
  for (const settings of [
    { maxRequestBytes: 10 },
    { maxInputTokens: 0 },
    { maxInputTokens: '15000' },
    { maxInputTokens: 10 },
  ])
    assert.throws(() => planning(history(), settings));
  for (const prepareSummary of [
    (r) => {
      r.tools = [{ name: 'execute' }];
    },
    (r) => {
      r.messages[1].content = 'truncated source';
    },
    (r) => {
      r.stop = ['END'];
    },
    (r) => {
      r.__hpmDiagnostics = { contextBudget: { enabled: true, inputBudgetTokens: 10 } };
    },
  ])
    assert.throws(() => planning(history(), { prepareSummary }));
  let hooks = 0;
  const hostile = [
    {
      get index() {
        hooks++;
        return 1;
      },
      item: { role: 'user', content: 'x' },
    },
  ];
  assert.throws(() =>
    planLocalCompactionSummary([hostile], {
      model: 'model',
      maxRequestBytes: 50000,
      maxInputTokens: 15000,
      prepareSummary() {},
    })
  );
  assert.equal(hooks, 0);
});

test('mid-batch failures, malformed state, policy elevation, cancellation and coordinator timeout cannot yield a partial result', async () => {
  const plan = planning();
  for (const mode of ['throw', 'malformed', 'legacy', 'elevate', 'cancel', 'timeout']) {
    const coordinator = createContextCompactionCoordinator({
      deadlineMs: mode === 'timeout' ? 10 : 12000,
    });
    const controller = new globalThis.AbortController();
    let calls = 0;
    try {
      await assert.rejects(
        runLocalCompactionSummary(plan, {
          binding,
          coordinator,
          signal: controller.signal,
          requestSummary: async (request, signal) => {
            calls++;
            if (calls === 1) return upstream(summaryFixture(request));
            if (mode === 'throw') throw new Error('PRIVATE_CONTENT');
            if (mode === 'timeout')
              return new Promise((resolve) =>
                signal.addEventListener('abort', () => resolve({ ok: false }), { once: true })
              );
            if (mode === 'cancel') {
              controller.abort();
              return upstream(summaryFixture(request));
            }
            if (mode === 'legacy') return upstream('{"summary":"not structured"}');
            if (mode === 'malformed') return upstream('{"summary":"text","state":{}}');
            const output = JSON.parse(summaryFixture(request));
            output.state.requirements = [
              {
                id: 'r',
                status: 'active',
                text: '证据-0🙂',
                sources: [{ sourceId: 'm_2', quote: '证据-0🙂' }],
              },
            ];
            return upstream(JSON.stringify(output));
          },
        })
      );
      assert.ok(calls >= 2 && calls <= plan.chunks.length);
      assert.equal(coordinator.stats().entries, 0);
    } finally {
      coordinator.close();
    }
  }
});

test('cross-chunk revocation retains original user source and cannot forget or resurrect an earlier constraint', async () => {
  const groups = [
    [
      { index: 1, item: { role: 'user', content: '禁止重启。目标是修复压缩。' } },
      { index: 2, item: { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' } },
      { index: 3, item: { type: 'function_call_output', call_id: 'a', output: 'x'.repeat(22000) } },
    ],
    [
      { index: 5, item: { role: 'user', content: '撤销禁止重启。仍须保留修改。' } },
      { index: 6, item: { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' } },
      { index: 7, item: { type: 'function_call_output', call_id: 'b', output: 'y'.repeat(22000) } },
    ],
    [
      { index: 9, item: { role: 'user', content: '继续验证。' } },
      { index: 10, item: { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' } },
      {
        index: 11,
        item: { type: 'function_call_output', call_id: 'c', output: 'z'.repeat(22000) },
      },
    ],
  ];
  const plan = planLocalCompactionSummary(groups, {
    model: binding.model,
    maxRequestBytes: 45000,
    maxInputTokens: 15000,
    prepareSummary() {},
  });
  assert.equal(plan.chunks.length, 3);
  for (const mode of ['valid', 'citation', 'forget', 'resurrect', 'role']) {
    const coordinator = createContextCompactionCoordinator();
    let calls = 0;
    try {
      const work = runLocalCompactionSummary(plan, {
        binding,
        coordinator,
        requestSummary: async (request) => {
          calls++;
          const response = JSON.parse(summaryFixture(request));
          if (calls === 1)
            response.state.requirements = [
              {
                id: 'restart',
                text: '禁止重启。',
                status: 'active',
                sources: [{ sourceId: 'm_1', quote: '禁止重启。' }],
              },
            ];
          if (calls === 2) {
            response.state.requirements[0].status = 'revoked';
            response.state.requirements[0].revision = { sourceId: 'm_5', quote: '撤销禁止重启。' };
          }
          if (mode === 'citation' && calls <= 2) {
            const payload = JSON.parse(request.messages[1].content);
            const requirement = response.state.requirements[0];
            const quote = calls === 1 ? '禁止重启。' : '撤销禁止重启。';
            const citation = payload.citations.find((item) => item.quote === quote);
            assert.ok(citation);
            if (calls === 1) {
              requirement.sources = [{ citationId: citation.citationId }];
              delete requirement.text;
            } else {
              // Prior selectors must have become canonical, exact references
              // before carrying them into the next chunk.
              assert.equal(requirement.sources[0].quote, '禁止重启。');
              requirement.revision = { citationId: citation.citationId };
            }
          }
          if (calls === 3 && mode === 'forget') response.state.requirements = [];
          if (calls === 3 && mode === 'resurrect') {
            response.state.requirements[0].status = 'active';
            delete response.state.requirements[0].revision;
          }
          if (calls === 3 && mode === 'role')
            response.state.requirements[0].sources[0].sourceRole = 'system';
          return upstream(JSON.stringify(response));
        },
      });
      if (!['valid', 'citation'].includes(mode)) await assert.rejects(work);
      else {
        const result = await work;
        assert.equal(result.state.requirements[0].status, 'revoked');
        assert.equal(result.state.requirements[0].sources[0].sourceIndex, 1);
        assert.equal(result.state.requirements[0].sources[0].sourceRole, 'user');
        assert.equal(result.state.requirements[0].revision.sourceIndex, 5);
      }
    } finally {
      coordinator.close();
    }
  }
});

test('single-flight and cache reuse cover the complete batch, never expose mutable plan or partial cache', async () => {
  const plan = planning();
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.chunks));
  const coordinator = createContextCompactionCoordinator();
  let calls = 0;
  const requestSummary = async (request) => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    return upstream(summaryFixture(request, '引号"、反斜杠\\、控制符\n和🙂'));
  };
  try {
    const results = await Promise.all(
      [1, 2].map(() => runLocalCompactionSummary(plan, { binding, coordinator, requestSummary }))
    );
    assert.deepEqual(results[0], results[1]);
    assert.equal(calls, plan.chunks.length);
    await runLocalCompactionSummary(plan, { binding, coordinator, requestSummary });
    assert.equal(calls, plan.chunks.length);
    await assert.rejects(
      runLocalCompactionSummary({ ...plan }, { binding, coordinator, requestSummary })
    );
    await assert.rejects(
      runLocalCompactionSummary(plan, {
        binding: { ...binding, model: 'other' },
        coordinator,
        requestSummary,
      })
    );
    assert.equal(calls, plan.chunks.length);
  } finally {
    coordinator.close();
  }
});

test('more than 64 historical rounds and interleaved parallel calls are still grouped atomically', () => {
  const selection = selectLocalCompactionWindow(history(70, 1));
  for (const group of selection.summaryGroups) {
    const calls = group.filter((entry) => entry.item.type === 'function_call');
    for (const entry of calls)
      assert.ok(
        group.some(
          (other) =>
            other.item.type === 'function_call_output' && other.item.call_id === entry.item.call_id
        )
      );
  }
  const parallel = history(3, 1);
  parallel.splice(2, 0, {
    type: 'function_call',
    call_id: 'parallel',
    name: 'read',
    arguments: '{}',
  });
  parallel.splice(4, 0, {
    type: 'function_call_output',
    call_id: 'parallel',
    output: 'parallel evidence',
  });
  const groups = selectLocalCompactionWindow(parallel).summaryGroups;
  const group = groups.find((entries) => entries.some(({ item }) => item.call_id === 'parallel'));
  assert.equal(
    group.filter(({ item }) => item.call_id === 'c0' || item.call_id === 'parallel').length,
    4
  );
});
