'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const {
  createNativeEvidenceBenchmarkWorkloadV2,
} = require('../scripts/lib/native-evidence-benchmark-workload-v2');
const {
  createNativeEvidenceV2Client,
  nativeEvidenceV2Thread,
} = require('../scripts/lib/native-evidence-v2-client');

function fixture(t) {
  const report = {
    turns: [],
    unsafeToolRequests: 0,
    toolFailureCount: 0,
    completedDynamicReadItems: 0,
  };
  const workload = createNativeEvidenceBenchmarkWorkloadV2();
  t.after(() => workload.close());
  const delays = [];
  const client = createNativeEvidenceV2Client({
    workload,
    report,
    delay: (ms) => {
      delays.push(ms);
      return new Promise((r) => setImmediate(r));
    },
  });
  client.bind('thread-1');
  client.onNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
  });
  const request = (callId, tool, args) => ({
    id: callId,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId,
      namespace: null,
      tool,
      arguments: args,
    },
  });
  const completed = (id, tool) =>
    client.onNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'dynamicToolCall', id, tool, success: true },
      },
    });
  return { report, workload, client, request, completed, delays };
}

test('native client correlates actual tool completions and observes genuine pending branches', async (t) => {
  const f = fixture(t);
  const replies = await Promise.all(
    ['design', 'verification'].map((document) =>
      f.client.onServerRequest(f.request(document, 'hpm_read_branch', { document }))
    )
  );
  assert.equal(
    replies.every((r) => r.success),
    true
  );
  for (const id of ['design', 'verification']) f.completed(id, 'hpm_read_branch');
  const list = JSON.parse(f.workload.reply('hpm_list_retained_evidence', {}).text);
  const source = list.sources[0];
  await f.client.onServerRequest(
    f.request('read', 'hpm_read_retained_evidence', {
      sourceId: source.sourceId,
      digest: source.digest,
      offsetBytes: 0,
      limitBytes: 6144,
    })
  );
  f.completed('read', 'hpm_read_retained_evidence');
  assert.equal(f.report.completedDynamicReadItems, 1);
  assert.equal(f.client.inspect().parallelBranchesObserved, true);
  assert.equal(f.client.inspect().pendingBranches, 0);
  assert.deepEqual(f.delays, [100, 100, 100]);
  assert.throws(() => f.completed('read', 'hpm_read_retained_evidence'));
});

test('native final comparison is one-shot, memory-only and exact', (t) => {
  const f = fixture(t);
  f.client.onNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', text: JSON.stringify(f.workload.expected) },
    },
  });
  f.client.onNotification({
    method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'contextCompaction' } },
  });
  f.client.onNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });
  f.client.verifyFinal();
  assert.equal(f.report.finalStateCorrect, true);
  assert.equal(f.report.turns[0].compactionItems, 1);
  assert.equal(JSON.stringify(f.report).includes(f.workload.expected.project), false);
  assert.throws(() => f.client.verifyFinal());
});

test('invalid, duplicate, foreign, side-effect and failed calls fail closed', async (t) => {
  for (const mutation of [
    (m) => {
      m.method = 'approve';
    },
    (m) => {
      m.params.threadId = 'other';
    },
    (m) => {
      m.params.turnId = 'other';
    },
    (m) => {
      m.params.namespace = 'untrusted';
    },
    (m) => {
      m.params.tool = 'shell';
    },
    (m) => {
      m.params.callId = '';
    },
  ]) {
    const f = fixture(t);
    const m = f.request('test', 'hpm_read_branch', { document: 'design' });
    mutation(m);
    await assert.rejects(f.client.onServerRequest(m));
    assert.equal(f.report.unsafeToolRequests, 1);
  }
  const f = fixture(t);
  const m = f.request('test', 'hpm_read_branch', { document: 'design' });
  await f.client.onServerRequest(m);
  await assert.rejects(f.client.onServerRequest(m));
  const bad = fixture(t);
  await assert.rejects(bad.client.onServerRequest(bad.request('test', 'hpm_read_page', {})));
  assert.equal(bad.report.toolFailureCount, 1);
  for (const type of [
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'collabAgentToolCall',
    'webSearch',
  ]) {
    const f = fixture(t);
    assert.throws(() =>
      f.client.onNotification({
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type },
        },
      })
    );
    assert.equal(f.report.unsafeToolRequests, 1);
  }
  const g = fixture(t);
  assert.throws(() => g.completed('unknown', 'hpm_read_branch'));
  assert.throws(() => g.client.bind('thread-2'));
  assert.throws(() =>
    g.client.onNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-2' } },
    })
  );
  assert.throws(() => g.client.onNotification({ method: 'error', params: {} }));
  assert.throws(() =>
    g.client.onNotification({ method: 'item/completed', params: { threadId: 'other' } })
  );
  assert.throws(() => g.client.onNotification({ method: 'turn/completed', params: {} }));
  assert.throws(() =>
    g.client.onNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: 'x'.repeat(65537) },
      },
    })
  );
});

test('native thread is isolated and preserves both zero-retry and threshold policies', () => {
  const w = createNativeEvidenceBenchmarkWorkloadV2();
  try {
    for (const arm of ['control', 'compact']) {
      const p = nativeEvidenceV2Thread(1234, os.tmpdir(), w.tools, arm);
      assert.equal(p.ephemeral, true);
      assert.equal(p.sandbox, 'read-only');
      assert.equal(p.config.tool_output_token_limit, 24000);
      assert.equal(p.config.model_auto_compact_token_limit, arm === 'compact' ? 4096 : 1000000);
      assert.equal(p.config.model_providers['hpm-isolated'].request_max_retries, 0);
    }
    for (const [port, directory, tools, arm] of [
      [0, os.tmpdir(), w.tools, 'control'],
      [1234, 'relative', w.tools, 'control'],
      [1234, os.tmpdir(), [], 'control'],
      [1234, os.tmpdir(), w.tools, 'retry'],
    ])
      assert.throws(() => nativeEvidenceV2Thread(port, directory, tools, arm));
  } finally {
    w.close();
  }
  let called = false;
  const options = Object.defineProperty({}, 'workload', {
    enumerable: true,
    get() {
      called = true;
      return null;
    },
  });
  assert.throws(() => createNativeEvidenceV2Client(options));
  assert.equal(called, false);
});

test('failed retained listing exposes only fixed code and allowlisted argument types', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.client.onServerRequest(
      f.request('bad-list', 'hpm_list_retained_evidence', {
        afterSourceId: null,
        limit: 16,
        'private-secret-key': 'secret-value',
      })
    )
  );
  assert.equal(f.report.toolFailureShape.tool, 'hpm_list_retained_evidence');
  assert.deepEqual(f.report.toolFailureShape.keyTypes, { afterSourceId: 'null', limit: 'number' });
  assert.equal(f.report.toolFailureShape.unknownKeyCount, 1);
  assert.equal(JSON.stringify(f.report).includes('secret'), false);
  const g = fixture(t);
  await assert.rejects(
    g.client.onServerRequest(g.request('null-list', 'hpm_list_retained_evidence', null))
  );
  assert.equal(g.report.toolFailureShape.argumentsType, 'null');
});
