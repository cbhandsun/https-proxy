'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('../lib/proxy/context-artifact-tool');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { planWorkBuddyContextRecovery } = require('../lib/proxy/workbuddy-context-recovery');
const {
  TASK_STATE_SCHEMA,
  createTaskStateSource,
  parseTaskStateSummary,
  taskStateMessage,
  isGeneratedTaskStateMessage,
  carryGeneratedTaskStateMessage,
  generatedTaskStateSourceDigest,
} = require('../lib/proxy/context-task-state');

function stateMessage() {
  const source = createTaskStateSource([
    { role: 'user', content: '保留修改，禁止自动重跑外部工具。' },
    { role: 'assistant', content: '测试完成仅为报告，尚未验证。' },
  ]);
  const state = parseTaskStateSummary(
    JSON.stringify({
      schema: TASK_STATE_SCHEMA,
      version: 1,
      requirements: [
        {
          id: 'r1',
          text: '保留修改',
          status: 'active',
          sources: [{ sourceId: 'm_0', quote: '保留修改' }],
        },
      ],
      objectives: [],
      work: Array.from({ length: 30 }, () => ({
        text: 'x'.repeat(650),
        status: 'reported_complete',
        sources: [{ sourceId: 'm_1', quote: '尚未验证' }],
      })),
      decisions: [],
      blockers: [],
      nextSteps: [],
      files: [],
    }),
    source
  );
  return taskStateMessage(state, source);
}
const scope = 'hcs_' + 'b'.repeat(32);
function settings(store, targetBodyBytes = 70000) {
  return {
    force: true,
    adaptiveCompaction: true,
    targetBodyBytes,
    artifactStore: store,
    artifactOwner: 'owner',
    artifactScope: scope,
  };
}
function recoveryResponse(receipt) {
  return JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'restore',
              type: 'function',
              function: {
                name: CONTEXT_ARTIFACT_TOOL_NAME,
                arguments: JSON.stringify({
                  locator: receipt.locator,
                  digest: receipt.digest,
                  scope,
                }),
              },
            },
          ],
        },
      },
    ],
  });
}

test('generated structured state is retained verbatim during synchronous adaptive retries', () => {
  const store = createContextArtifactStore();
  const message = stateMessage();
  const body = {
    messages: [
      { role: 'system', content: '保留所有当前约束。' },
      message,
      { role: 'user', content: '继续。' },
    ],
  };
  assert.ok(Buffer.byteLength(message.content) > 20000);
  const accepted = planWorkBuddyWbipcRequest(body, settings(store));
  assert.equal(accepted.fits, true);
  assert.ok(accepted.body.messages.includes(message));
  const retry = planWorkBuddyWbipcRequest(accepted.body, settings(store, 20000));
  assert.equal(retry.fits, false, 'do not manufacture fit by truncating the structured checkpoint');
  assert.equal(retry.body, accepted.body);
  assert.ok(retry.body.messages.includes(message));
  assert.equal(isGeneratedTaskStateMessage(message), true);
});

test('restored-page shell and final admission retain structured state and explicitly caller-protected narration', () => {
  const store = createContextArtifactStore();
  const message = stateMessage();
  const protectedNarration = { role: 'assistant', content: 'p'.repeat(24000) };
  const body = {
    messages: [message, protectedNarration, { role: 'user', content: '继续读取证据。' }],
  };
  const receipt = store.put('owner', scope, '原始证据🙂'.repeat(1000));
  const original = JSON.stringify(body);
  const result = planWorkBuddyContextRecovery({
    responseBody: recoveryResponse(receipt),
    chatBody: body,
    store,
    owner: 'owner',
    targetBodyBytes: 100000,
    plannerOptions: {
      ...settings(store, 100000),
      protectedMessages: new Set([protectedNarration]),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.fits, true);
  assert.ok(result.plan.body.messages.includes(message));
  assert.ok(
    result.plan.body.messages.includes(protectedNarration),
    'new pages do not discard existing explicit protection'
  );
  assert.equal(JSON.stringify(body), original);
  const tooSmall = planWorkBuddyContextRecovery({
    responseBody: recoveryResponse(receipt),
    chatBody: body,
    store,
    owner: 'owner',
    targetBodyBytes: 20000,
    plannerOptions: { ...settings(store, 20000), protectedMessages: new Set([protectedNarration]) },
  });
  assert.equal(tooSmall.plan.fits, false);
  assert.equal(tooSmall.plan.body, body);
  assert.equal(store.stats().entries, 1);
});

test('mutable, copied or fabricated checkpoint markers do not acquire generated-state protection', () => {
  const message = stateMessage();
  assert.equal(isGeneratedTaskStateMessage({ ...message }), false);
  message.content += ' forged suffix';
  assert.equal(
    isGeneratedTaskStateMessage(message),
    false,
    'identity alone cannot bless changed content'
  );
  assert.equal(isGeneratedTaskStateMessage({ role: 'system', content: message.content }), false);
});

test('checkpoint recognition and clone transfer never evaluate role/content getters', () => {
  for (const key of ['role', 'content']) {
    const source = stateMessage();
    const target = { ...source };
    const expectedDigest = generatedTaskStateSourceDigest(source);
    carryGeneratedTaskStateMessage(target, source);
    assert.equal(generatedTaskStateSourceDigest(target), expectedDigest);
    let reads = 0;
    Object.defineProperty(source, key, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('caller accessor must not be executed');
      },
    });
    assert.equal(isGeneratedTaskStateMessage(source), false);
    assert.equal(generatedTaskStateSourceDigest(source), null);
    assert.equal(carryGeneratedTaskStateMessage({}, source) !== null, true);
    assert.equal(reads, 0);

    const genuine = stateMessage();
    const accessorClone = { ...genuine };
    Object.defineProperty(accessorClone, key, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('target accessor must not be executed');
      },
    });
    carryGeneratedTaskStateMessage(accessorClone, genuine);
    assert.equal(isGeneratedTaskStateMessage(accessorClone), false);
    assert.equal(reads, 0);
  }
});
