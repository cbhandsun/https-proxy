'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createContextToolCatalogStore,
  TOOL_DISCOVERY_CAPABILITY,
  TOOL_DISCOVERY_NAME,
} = require('../lib/proxy/context-tool-catalog');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('../lib/proxy/context-artifact-tool');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const { createContextRecoveryGuard } = require('../lib/proxy/workbuddy-context-recovery');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { planWorkBuddyToolDiscovery } = require('../lib/proxy/workbuddy-tool-discovery');
const {
  applyResponsesHistoryPolicy,
  responsesTruncation,
  shouldStoreResponsesHistory,
} = require('../lib/proxy/responses-history-policy');

const owner = 'owner',
  scope = 'hcs_' + 'a'.repeat(32);
function setup({ signal, now = Date.now } = {}) {
  const store = createContextArtifactStore(),
    catalogs = createContextToolCatalogStore({ now });
  const tools = Array.from({ length: 40 }, (_entry, index) => ({
    type: 'function',
    function: {
      name: `read_${index}`,
      description: 'FULL schema metadata. '.repeat(100),
      strict: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: 'preserve🙂', enum: ['安全🙂', 'b'] } },
        required: ['path'],
        $defs: { exact: { type: 'string', minLength: 2, maxLength: 40 } },
      },
    },
  }));
  const body = {
    model: 'fixture',
    tools,
    messages: [
      { role: 'system', content: 'do not execute external tools' },
      { role: 'user', content: '保留约束' },
    ],
  };
  for (let index = 0; index < 20; index++)
    body.messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `read-${index}`, type: 'function', function: { name: 'read_0', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `read-${index}`, content: '原始证据🙂'.repeat(1500) }
    );
  body.messages.push({ role: 'user', content: '继续，不要执行外部命令。' });
  const opened = catalogs.open(body, {
    owner,
    scope,
    capability: TOOL_DISCOVERY_CAPABILITY,
    initialNames: ['read_0'],
  });
  const history = createContextHistoryBranch(opened.body, { owner, scope });
  const plannerOptions = {
    artifactStore: store,
    artifactOwner: owner,
    artifactScope: scope,
    historyBranch: history,
    force: true,
    preserveToolSchemas: true,
    targetBodyBytes: 70000,
    signal,
  };
  const initial = planWorkBuddyWbipcRequest(opened.body, plannerOptions);
  assert.equal(initial.fits, true);
  const receipt = collectContextArtifactReferences(initial.body.messages, scope)[0];
  return {
    tools,
    store,
    catalogs,
    history,
    catalog: opened.catalog,
    body: initial.body,
    receipt,
    plannerOptions,
    cleanup() {
      catalogs.close();
      store.close();
      history.close();
    },
  };
}
const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const wire = (calls, extra = {}) =>
  JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: calls },
        ...extra,
      },
    ],
  });
function plan(fixture, responseBody, extra = {}) {
  return planWorkBuddyToolDiscovery({
    responseBody,
    chatBody: fixture.body,
    catalog: fixture.catalog,
    owner,
    scope,
    plannerOptions: fixture.plannerOptions,
    recoveryGuard: createContextRecoveryGuard(),
    maxBytes: 16 * 1024 * 1024,
    targetBodyBytes: 70000,
    ...extra,
  });
}

test('schema discovery and authenticated cross-compaction evidence use the separate bound read store', () => {
  const f = setup();
  const {
    localCompactionEvidenceOwner,
    createLocalCompactionEvidenceReader,
  } = require('../lib/proxy/context-compaction-evidence');
  const binding = { owner, provider: 'workbuddy-wbipc', model: 'fixture', endpoint: 'host/v2' };
  const privateScope = 'hcs_' + 'b'.repeat(32);
  try {
    const stored = f.store.put(
      localCompactionEvidenceOwner(binding),
      privateScope,
      '私有跨轮证据🙂'.repeat(100)
    );
    const receipt = {
      kind: 'local_compaction_evidence',
      locator: stored.locator,
      digest: stored.digest,
      bytes: stored.bytes,
      scope: privateScope,
    };
    assert.equal(f.store.read(owner, privateScope, receipt.locator, receipt.digest).ok, false);
    f.plannerOptions.artifactReadStore = createLocalCompactionEvidenceReader(f.store, binding, [
      receipt,
    ]);
    const result = plan(
      f,
      wire([
        call('schema-private', TOOL_DISCOVERY_NAME, { names: ['read_39'] }),
        call('page-private', CONTEXT_ARTIFACT_TOOL_NAME, {
          scope: privateScope,
          locator: receipt.locator,
          digest: receipt.digest,
          limitBytes: 1024,
        }),
      ])
    );
    assert.equal(result.ok, true);
    assert.equal(result.plan.fits, true);
    assert.equal(result.resolvedCount, 1);
    const recovered = result.plan.body.messages.find((m) => m.tool_call_id === 'page-private');
    assert.ok(JSON.parse(recovered.content).page.text.includes('私有跨轮证据🙂'));
    assert.deepEqual(
      result.plan.body.tools.find((tool) => tool.function.name === 'read_39'),
      f.tools[39]
    );
  } finally {
    f.cleanup();
  }
});

test('schema loading and simultaneous paged evidence commit once with original full schema constraints', () => {
  const fixture = setup();
  try {
    const result = plan(
      fixture,
      wire([
        call('schema', TOOL_DISCOVERY_NAME, { names: ['read_39'] }),
        call('page', CONTEXT_ARTIFACT_TOOL_NAME, {
          scope,
          locator: fixture.receipt.locator,
          digest: fixture.receipt.digest,
          limitBytes: 4096,
        }),
      ])
    );
    assert.equal(result.ok, true);
    assert.equal(result.plan.fits, true);
    assert.equal(result.resolvedCount, 1);
    assert.equal(fixture.history.stats().version, 3, 'no intermediate shell/history commits');
    assert.equal(fixture.catalog.stats().version, 2);
    assert.deepEqual(
      result.plan.body.tools.find((tool) => tool.function.name === 'read_39'),
      fixture.tools[39]
    );
    const page = result.plan.body.messages.find((message) => message.tool_call_id === 'page');
    assert.equal(JSON.parse(page.content).ok, true);
    assert.ok(JSON.parse(page.content).page.text.includes('原始证据'));
    assert.ok(result.plan.body.messages.find((message) => message.tool_call_id === 'schema'));
    assert.equal(
      result.plan.diagnostics.finalBodyBytes,
      Buffer.byteLength(JSON.stringify(result.plan.body))
    );
    assert.equal(JSON.stringify(fixture.history.snapshot().body), JSON.stringify(result.plan.body));
    assert.ok(!JSON.stringify(result.plan.diagnostics).includes('原始证据'));
  } finally {
    fixture.cleanup();
  }
});

test('budget, cancellation, stale history, expiry and publication failures cannot partially publish schemas or history', () => {
  for (const mode of ['budget', 'cancel', 'stale', 'expiry', 'publication', 'throw']) {
    let now = 1;
    const controller = new globalThis.AbortController();
    const fixture = setup({ signal: controller.signal, now: () => now });
    const before = fixture.history.snapshot(),
      entries = fixture.store.stats().entries;
    const original = fixture.plannerOptions.artifactStore;
    if (['stale', 'expiry', 'publication', 'throw'].includes(mode))
      fixture.plannerOptions.artifactStore = {
        beginTransaction(requestOwner, requestScope) {
          const tx = original.beginTransaction(requestOwner, requestScope);
          return {
            ...tx,
            stats() {
              if (mode === 'stale')
                fixture.history.replace(
                  { ...fixture.body, model: 'new-model' },
                  fixture.history.stats().version
                );
              if (mode === 'expiry') now += 300000;
              return tx.stats();
            },
            commit(refs) {
              if (mode === 'throw') throw new Error('publication fixture');
              return mode === 'publication' ? { ok: false } : tx.commit(refs);
            },
          };
        },
      };
    if (mode === 'cancel') controller.abort();
    const run = () =>
      plan(
        fixture,
        wire([call('schema', TOOL_DISCOVERY_NAME, { names: ['read_39'] })]),
        mode === 'budget' ? { targetBodyBytes: 100 } : {}
      );
    try {
      if (mode === 'throw') assert.throws(run, /publication fixture/);
      else {
        const result = run();
        if (mode === 'cancel') assert.equal(result.ok, false);
        else {
          assert.equal(result.plan.fits, false, mode);
          assert.equal(result.plan.changed, false);
          assert.equal(
            JSON.stringify(result.plan.body),
            JSON.stringify(fixture.history.snapshot().body)
          );
          assert.equal(
            result.plan.diagnostics.finalBodyBytes,
            Buffer.byteLength(JSON.stringify(result.plan.body))
          );
        }
      }
      assert.equal(fixture.catalog.stats().version, 1, mode);
      assert.equal(fixture.store.stats().entries, entries, mode);
      assert.equal(
        fixture.history.stats().version,
        mode === 'stale' ? before.version + 1 : before.version,
        mode
      );
      assert.equal(fixture.history.stats().stagedEntries, 0);
      assert.equal(fixture.catalog.stats().pending, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test('unknown tools, duplicate/history IDs, incomplete turns and foreign catalogs reject before staging', () => {
  const fixture = setup();
  try {
    const schema = call('schema', TOOL_DISCOVERY_NAME, { names: ['read_39'] });
    for (const response of [
      wire([schema, { ...schema }]),
      wire([{ ...schema, id: 'read-0' }]),
      wire([schema, call('external', 'read_0', {})]),
      wire([schema], { finish_reason: 'length' }),
      wire([call('schema', TOOL_DISCOVERY_NAME, { names: ['foreign'] })]),
    ]) {
      assert.equal(plan(fixture, response).ok, false);
      assert.equal(fixture.catalog.stats().pending, false);
    }
    assert.equal(plan(fixture, wire([schema]), { catalog: { ...fixture.catalog } }).ok, false);
    assert.throws(() => plan(fixture, wire([schema]), { owner: 'other' }), {
      code: 'context_history_conflict',
    });
    assert.equal(fixture.history.stats().version, 2);
    assert.equal(fixture.catalog.stats().rounds, 0);
  } finally {
    fixture.cleanup();
  }
});

test('negotiated tool selection preserves all loaded schemas under pressure and history policy survives negotiation', () => {
  const fixture = setup();
  try {
    const noToolsDropped = planWorkBuddyWbipcRequest(
      { model: 'fixture', tools: fixture.tools, messages: [{ role: 'user', content: 'keep' }] },
      { force: true, preserveToolSchemas: true, targetBodyBytes: 200000 }
    );
    assert.equal(noToolsDropped.fits, true);
    assert.deepEqual(noToolsDropped.body.tools, fixture.tools);
    const impossible = planWorkBuddyWbipcRequest(
      { model: 'fixture', tools: fixture.tools, messages: [{ role: 'user', content: 'keep' }] },
      { force: true, preserveToolSchemas: true, targetBodyBytes: 1000 }
    );
    assert.equal(impossible.fits, false);
    assert.deepEqual(impossible.body.tools, fixture.tools, 'no chopping schemas to fake a fit');
    const body = applyResponsesHistoryPolicy(
      { messages: [], tools: fixture.tools },
      { store: false, truncation: 'disabled' }
    );
    const opened = fixture.catalogs.open(body, {
      owner,
      scope: 'policy',
      capability: TOOL_DISCOVERY_CAPABILITY,
    });
    assert.equal(
      opened.applied,
      true,
      'validated policy metadata must not silently disable discovery'
    );
    assert.equal(shouldStoreResponsesHistory(opened.body), false);
    assert.equal(responsesTruncation(opened.body), 'disabled');
  } finally {
    fixture.cleanup();
  }
});

test('forced and disabled tool choices cannot be bypassed by an internal discovery turn', () => {
  for (const tool_choice of ['none', { type: 'function', function: { name: 'read_0' } }]) {
    const fixture = setup();
    try {
      const body = { ...fixture.body, tool_choice };
      assert.equal(fixture.history.replace(body, fixture.history.stats().version).ok, true);
      fixture.body = fixture.history.snapshot().body;
      const result = plan(
        fixture,
        wire([call('schema', TOOL_DISCOVERY_NAME, { names: ['read_39'] })])
      );
      assert.equal(result.ok, false);
      assert.equal(fixture.catalog.stats().rounds, 0);
      assert.equal(fixture.catalog.stats().pending, false);
    } finally {
      fixture.cleanup();
    }
  }
});
