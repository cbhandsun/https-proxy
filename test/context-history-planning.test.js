'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { planWorkBuddyContextRecovery } = require('../lib/proxy/workbuddy-context-recovery');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('../lib/proxy/context-artifact-tool');

const scope = 'hcs_' + 'a'.repeat(32);
function workload() {
  const messages = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'keep raw input' },
  ];
  for (let index = 0; index < 20; index++)
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
        content: `evidence-${index}:` + '证据🙂'.repeat(2500),
      }
    );
  messages.push({ role: 'user', content: 'continue' });
  return { model: 'fixture', messages };
}
const settings = (store, history, extra = {}) => ({
  force: true,
  targetBodyBytes: 70000,
  artifactOwner: 'owner',
  artifactScope: scope,
  artifactStore: store,
  historyBranch: history,
  ...extra,
});

test('synchronous retry and complete page recovery share history/evidence commit, never committing the shell', () => {
  const store = createContextArtifactStore(),
    body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope });
  const first = planWorkBuddyWbipcRequest(body, settings(store, history));
  assert.equal(first.fits, true);
  assert.equal(first.diagnostics.historyTransactionStatus, 'committed');
  assert.equal(history.stats().version, 2);
  assert.equal(JSON.stringify(history.snapshot().body), JSON.stringify(first.body));
  const receipt = collectContextArtifactReferences(first.body.messages, scope)[0];
  const responseBody = JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'recover',
              type: 'function',
              function: {
                name: CONTEXT_ARTIFACT_TOOL_NAME,
                arguments: JSON.stringify(receipt),
              },
            },
          ],
        },
      },
    ],
  });
  // Supply only tool arguments, not receipt's diagnostic fields.
  const response = JSON.parse(responseBody);
  response.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({
    scope,
    locator: receipt.locator,
    digest: receipt.digest,
    limitBytes: 4096,
  });
  const recovered = planWorkBuddyContextRecovery({
    chatBody: first.body,
    responseBody: JSON.stringify(response),
    store,
    owner: 'owner',
    plannerOptions: settings(store, history),
    targetBodyBytes: 70000,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.plan.fits, true);
  assert.equal(recovered.plan.diagnostics.historyTransactionStatus, 'committed');
  assert.equal(history.stats().version, 3, 'two intermediate page plans must not commit history');
  assert.equal(JSON.stringify(history.snapshot().body), JSON.stringify(recovered.plan.body));
  const page = recovered.plan.body.messages.find((message) => message.tool_call_id === 'recover');
  assert.equal(JSON.parse(page.content).ok, true);
  history.close();
  store.close();
});

test('stale planning rolls back artifacts and returns current unlossy history, not the obsolete caller input', () => {
  const store = createContextArtifactStore(),
    body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope });
  let replaced = false;
  const injected = {
    beginTransaction(owner, scope) {
      const transaction = store.beginTransaction(owner, scope);
      return {
        ...transaction,
        put(...args) {
          if (!replaced) {
            replaced = true;
            assert.equal(
              history.replace({ ...body, model: 'new-model' }, history.stats().version).ok,
              true
            );
          }
          return transaction.put(...args);
        },
      };
    },
  };
  const result = planWorkBuddyWbipcRequest(body, settings(injected, history));
  assert.equal(replaced, true);
  assert.equal(result.fits, false);
  assert.equal(result.diagnostics.historyTransactionStatus, 'rolled_back');
  assert.equal(result.diagnostics.reason, 'stale_context_history_snapshot');
  assert.equal(result.body.model, 'new-model');
  assert.equal(result.body.messages.length, body.messages.length);
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().retainedBytes, 0);
  assert.equal(history.stats().stagedEntries, 0);
  history.close();
  store.close();
});

test('foreign ownership, invalid branch and stale caller bodies are rejected before evidence staging', () => {
  const store = createContextArtifactStore(),
    body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope });
  for (const extra of [
    { artifactOwner: 'other' },
    { artifactScope: 'other' },
    { historyBranch: {} },
  ])
    assert.throws(() => planWorkBuddyWbipcRequest(body, settings(store, history, extra)), {
      code: 'context_history_conflict',
    });
  body.model = 'caller-changed-model';
  assert.throws(() => planWorkBuddyWbipcRequest(body, settings(store, history)), {
    code: 'context_history_conflict',
  });
  assert.equal(store.stats().retainedBytes, 0);
  history.close();
  store.close();
});
