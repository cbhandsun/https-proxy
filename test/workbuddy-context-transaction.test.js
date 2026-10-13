'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { planWorkBuddyContextRecovery } = require('../lib/proxy/workbuddy-context-recovery');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('../lib/proxy/context-artifact-tool');

function workload(policy = 'Keep authentication boundaries.') {
  const messages = [
    { role: 'system', content: policy },
    { role: 'user', content: '保留这条原文要求。' },
  ];
  for (let index = 0; index < 20; index += 1)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: `call-${index}`,
        content: `evidence-${index}-` + '证据🙂'.repeat(3000),
      }
    );
  messages.push({ role: 'user', content: '继续，禁止自动重跑外部工具。' });
  return { messages };
}
function settings(store, extra = {}) {
  return {
    force: true,
    targetBodyBytes: 60000,
    artifactStore: store,
    artifactOwner: 'owner',
    artifactScope: 'scope',
    ...extra,
  };
}

test('planner commits only final referenced evidence after admission, preserving original input', () => {
  const store = createContextArtifactStore();
  const body = workload();
  const original = JSON.stringify(body);
  const plan = planWorkBuddyWbipcRequest(body, settings(store, { maxChars: 2000 }));
  assert.equal(plan.fits, true);
  assert.equal(plan.diagnostics.artifactTransactionStatus, 'committed');
  const references = collectContextArtifactReferences(plan.body.messages, 'scope');
  assert.ok(references.length > 0);
  assert.ok(
    plan.diagnostics.artifactsDiscarded > 0,
    'candidates not retained in the checkpoint release quota'
  );
  assert.equal(store.stats().entries, references.length);
  assert.equal(plan.diagnostics.artifactsStored, references.length);
  for (const receipt of references)
    assert.equal(store.read('owner', 'scope', receipt.locator, receipt.digest).ok, true);
  assert.equal(JSON.stringify(body), original);
  assert.equal(plan.body.messages[0], body.messages[0]);
  assert.ok(!JSON.stringify(plan.diagnostics).includes('证据'));
});

test('byte, token and checkpoint admission failures roll back; rejected plan returns original request', () => {
  for (const extra of [{ targetBodyBytes: 100 }, { operationalInputTokens: 1 }, { maxChars: 1 }]) {
    const store = createContextArtifactStore();
    const live = store.put('owner', 'scope', 'existing live evidence');
    const body = workload('p'.repeat(1000));
    const original = JSON.stringify(body);
    const plan = planWorkBuddyWbipcRequest(body, settings(store, extra));
    assert.equal(plan.fits, false);
    assert.equal(plan.changed, false);
    assert.equal(plan.body, body);
    assert.equal(plan.diagnostics.artifactTransactionStatus, 'rolled_back');
    assert.equal(plan.diagnostics.artifactsStored, 0);
    assert.equal(store.stats().entries, 1);
    assert.equal(
      store.read('owner', 'scope', live.locator, live.digest).value,
      'existing live evidence'
    );
    assert.equal(JSON.stringify(body), original);
  }
});

test('exception propagates while finally releases reservations', () => {
  const store = createContextArtifactStore({ maxEntries: 2 });
  let writes = 0;
  const throwing = {
    beginTransaction(owner, scope) {
      const tx = store.beginTransaction(owner, scope);
      return {
        ...tx,
        put(...args) {
          writes += 1;
          if (writes === 2) throw new Error('fixture-admission-failure');
          return tx.put(...args);
        },
      };
    },
  };
  assert.throws(
    () => planWorkBuddyWbipcRequest(workload(), settings(throwing)),
    /fixture-admission-failure/
  );
  assert.equal(store.stats().entries, 0);
  assert.ok(store.put('owner', 'scope', 'quota released'));
  assert.ok(store.put('owner', 'scope', 'quota released again'));
});

test('commit failure cannot publish a lossy request or manufacture a successful plan', () => {
  const store = createContextArtifactStore();
  const cancelled = {
    beginTransaction(owner, scope) {
      const tx = store.beginTransaction(owner, scope);
      return {
        ...tx,
        commit(references) {
          store.discardSession(owner, scope);
          return tx.commit(references);
        },
      };
    },
  };
  const body = workload();
  const plan = planWorkBuddyWbipcRequest(body, settings(cancelled));
  assert.equal(plan.fits, false);
  assert.equal(plan.body, body);
  assert.equal(plan.changed, false);
  assert.equal(plan.diagnostics.reason, 'artifact_commit_failed');
  assert.equal(store.stats().entries, 0);
});

test('empty or invalid requests and nullable options preserve existing behavior without staging', () => {
  const store = createContextArtifactStore();
  assert.equal(planWorkBuddyWbipcRequest(null, settings(store)).fits, false);
  assert.equal(planWorkBuddyWbipcRequest({ messages: [] }, settings(store)).fits, true);
  assert.equal(store.stats().entries, 0);
  assert.equal(planWorkBuddyWbipcRequest({ messages: [] }, null).fits, true);
});

test('recovery shell and actual-page planning share one transaction, including failure and exception paths', () => {
  for (const failure of ['oversized-page', 'read-error']) {
    const store = createContextArtifactStore();
    const scope = 'hcs_' + 'a'.repeat(32);
    const live = store.put('owner', scope, 'original evidence');
    let writes = 0;
    let reads = 0;
    const stagedStore = {
      beginTransaction(owner, session) {
        const tx = store.beginTransaction(owner, session);
        return {
          ...tx,
          put(...args) {
            writes += 1;
            return tx.put(...args);
          },
        };
      },
    };
    const body = workload();
    const responseBody = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'recovery',
                type: 'function',
                function: {
                  name: CONTEXT_ARTIFACT_TOOL_NAME,
                  arguments: JSON.stringify({ locator: live.locator, digest: live.digest, scope }),
                },
              },
            ],
          },
        },
      ],
    });
    const options = {
      responseBody,
      chatBody: body,
      owner: 'owner',
      targetBodyBytes: 60000,
      plannerOptions: settings(stagedStore, { artifactScope: scope }),
      store: {
        readPage() {
          reads += 1;
          if (failure === 'read-error') throw new Error('fixture-read-failure');
          return { ok: true, page: { text: 'x'.repeat(100000), offsetBytes: 0 } };
        },
      },
    };
    if (failure === 'read-error')
      assert.throws(() => planWorkBuddyContextRecovery(options), /fixture-read-failure/);
    else {
      const result = planWorkBuddyContextRecovery(options);
      assert.equal(result.plan.fits, false);
      assert.equal(result.plan.body, body);
      assert.equal(result.plan.diagnostics.finalBodyBytes, Buffer.byteLength(JSON.stringify(body)));
      assert.equal(result.plan.diagnostics.artifactTransactionStatus, 'rolled_back');
      assert.equal(result.plan.diagnostics.artifactsStored, 0);
    }
    assert.ok(writes > 0, 'shell planned staged history before attempting the real page');
    assert.equal(reads, 1);
    assert.equal(store.stats().entries, 1, 'shell must not publish an intermediate candidate');
    assert.equal(store.read('owner', scope, live.locator, live.digest).value, 'original evidence');
  }
});
