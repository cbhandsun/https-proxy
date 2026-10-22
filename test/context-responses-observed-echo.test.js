'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observedResponsesEcho } = require('../lib/proxy/context-responses-observed-echo');
const {
  createContextBindingRegistry,
  exportContextBindingRegistry,
  restoreContextBindingRegistry,
  prepareContextBindingAdoption,
  probeContextBindingRegistry,
} = require('../lib/proxy/context-binding');
const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
const { parseApiEvidenceCalls } = require('../lib/proxy/context-api-evidence-protocol');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const {
  createContextHistoryMap,
  exportContextHistoryMap,
  restoreContextHistoryMap,
} = require('../lib/proxy/context-history-map');
const { publicWindowFrontiers, parsePublicWindow } = require('../lib/proxy/context-public-window');
const {
  sealCodexSummaryResponse,
  parseCodexSummaryReceipt,
} = require('../lib/proxy/context-recovery-codex-summary');
const { normalizeCodexResponsesRequest } = require('../lib/proxy/codex-responses-contract');
const initial = [{ role: 'user', content: 'synthetic original only' }];
const raw = {
  type: 'custom_tool_call',
  id: 'ctc_echo',
  call_id: 'outer_echo',
  name: 'exec',
  input: 'text(await tools.synthetic({}));',
  status: 'completed',
  metadata: { provider: 'synthetic' },
  internal_chat_message_metadata_passthrough: { classifier: 'synthetic' },
};
const echo = Object.fromEntries(
  Object.entries(raw).filter(
    ([key]) => !['metadata', 'internal_chat_message_metadata_passthrough'].includes(key)
  )
);
const request = (history) => ({
  principal: 'owner',
  protocol: 'responses',
  target: 'target',
  history,
});
function fixture() {
  const registry = createContextBindingRegistry({ now: () => 100 });
  const root = registry.begin(request(initial));
  assert.equal(registry.commit(root.token, [raw], 'observed-response').ok, true);
  return { registry, root };
}

test('only an observed Responses output mints complete native echo and exact original frontiers', () => {
  const { registry, root } = fixture();
  const before = JSON.stringify(raw);
  for (const candidate of [raw, echo]) {
    const next = registry.begin(request([...initial, candidate]));
    assert.equal(next.parentSnapshotId, root.snapshotId);
    assert.equal(registry.publicWindow(next.token).count, initial.length + 1);
    registry.rollback(next.token);
  }
  assert.equal(JSON.stringify(raw), before);
  const compact = registry.beginCompaction(request([...initial, echo]));
  assert.equal(compact.parentSnapshotId, root.snapshotId);
  registry.rollback(compact.token);
  registry.close();
});

test('native echo matching retains exact payload, identity, ancillary values and owner/policy boundaries', () => {
  const { registry } = fixture();
  const partial = { ...raw };
  delete partial.metadata;
  const candidates = [
    partial,
    { ...raw, metadata: { provider: 'changed' } },
    { ...echo, metadata: null },
    { ...echo, input: raw.input + ' ' },
    { ...echo, name: 'other' },
    { ...echo, id: 'other' },
    { ...echo, call_id: 'other' },
    { ...echo, status: 'in_progress' },
    { ...echo, opaque: 'extra' },
  ];
  for (const candidate of candidates) {
    const next = registry.begin(request([...initial, candidate]));
    assert.equal(next.parentSnapshotId, null);
    registry.rollback(next.token);
  }
  for (const changed of [
    { principal: 'foreign' },
    { target: 'foreign' },
    { policy: { instructions: 'changed' } },
  ]) {
    const next = registry.begin({ ...request([...initial, echo]), ...changed });
    assert.equal(next.parentSnapshotId, null);
    registry.rollback(next.token);
  }
  registry.close();
});

test('observed echo indices survive validated JSON restore and owner adoption without new snapshots', () => {
  const { registry, root } = fixture();
  const state = JSON.parse(JSON.stringify(exportContextBindingRegistry(registry, root.snapshotId)));
  assert.equal(state.snapshots.length, 1);
  assert.match(state.snapshots[0].echoFrontier, /^[a-f0-9]{64}$/);
  const restored = restoreContextBindingRegistry(
    { now: () => 101, binding: request(initial) },
    state
  ).registry;
  const next = restored.begin(request([...initial, echo]));
  assert.equal(next.parentSnapshotId, root.snapshotId);
  restored.rollback(next.token);
  const target = createContextBindingRegistry({ now: () => 101 });
  const probe = probeContextBindingRegistry(target, request([...initial, echo]), [restored], false);
  assert.equal(probe.parentSnapshotId, root.snapshotId);
  const adoption = prepareContextBindingAdoption(target, restored);
  adoption.check();
  adoption.commit();
  const adopted = target.begin(request([...initial, echo]));
  assert.equal(adopted.parentSnapshotId, root.snapshotId);
  registry.close();
  restored.close();
  target.close();
});

test('restore refuses partial, malformed and non-Responses echo aliases', () => {
  const { registry, root } = fixture();
  const state = exportContextBindingRegistry(registry, root.snapshotId);
  for (const mutate of [
    (snapshot) => {
      delete snapshot.echoFrontier;
    },
    (snapshot) => {
      delete snapshot.echoContinuityFrontier;
    },
    (snapshot) => {
      snapshot.echoFrontier = '';
    },
    (snapshot) => {
      snapshot.echoContinuityFrontier = 0;
    },
    (snapshot) => {
      snapshot.echoExtra = 'unexpected';
    },
    (snapshot) => {
      snapshot.protocol = 'chat';
    },
  ]) {
    const altered = JSON.parse(JSON.stringify(state));
    mutate(altered.snapshots[0]);
    assert.throws(
      () => restoreContextBindingRegistry({ now: () => 101, binding: request(initial) }, altered),
      /invalid_context_binding_state/
    );
  }
  registry.close();
});

test('Code Mode array original is captured exactly after native drops only observed server metadata', () => {
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  const options = {
    auth: { ok: true, enabled: true, key: { id: 'owner' } },
    kind: 'responses',
    prepared: {
      profile: { id: 'fixture', protocol: 'openai', targetUrl: 'https://api.openai.com/v1' },
    },
  };
  const body = { model: 'synthetic', input: initial, tools: [], tool_choice: 'auto' };
  const begin = (value) =>
    beginContextRecoveryRequest(runtime, {
      ...options,
      buffer: Buffer.from(JSON.stringify(value)),
    });
  const first = begin(body);
  assert.equal(
    first.complete(
      [raw],
      parseApiEvidenceCalls('responses', { status: 'completed', output: [raw] }),
      'observed-response'
    ).ok,
    true
  );
  const payload = [{ type: 'input_text', text: 'exact Unicode\r\n中文🙂' }];
  const next = begin({
    ...body,
    input: [
      ...initial,
      echo,
      { type: 'custom_tool_call_output', call_id: raw.call_id, output: payload },
    ],
  });
  assert.equal(next.inspect().visibleSources, 1);
  assert.equal(runtime.inspect().roots, 1);
  const listed = JSON.parse(next.reply(LIST, {}).text);
  const source = listed.sources[0];
  const read = JSON.parse(
    next.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text
  );
  assert.equal(read.page.text, JSON.stringify(payload));
  runtime.close();
});

test('echo projection validates bounded data and preserves unknown, user and opaque fields', () => {
  for (const value of [
    null,
    {},
    [],
    [null],
    [{ type: 'message', role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) }],
  ])
    assert.throws(() => observedResponsesEcho(value));
  let reads = 0;
  const accessor = {
    type: 'custom_tool_call',
    get metadata() {
      reads++;
      return {};
    },
  };
  assert.throws(() => observedResponsesEcho([accessor]));
  assert.equal(reads, 0);
  assert.equal(observedResponsesEcho([echo]), null);
  assert.equal(
    observedResponsesEcho([{ ...raw, type: 'compaction', encrypted_content: 'opaque' }]),
    null
  );
  assert.equal(
    observedResponsesEcho([{ type: 'message', role: 'user', metadata: { user: 'exact' } }]),
    null
  );
  const signed = { ...raw, signature: 'exact-signature', extra: { opaque: 'exact' } };
  const projected = observedResponsesEcho([signed])[0];
  assert.equal(projected.signature, signed.signature);
  assert.deepEqual(JSON.parse(JSON.stringify(projected.extra)), signed.extra);
});

test('private history raw and native echo windows survive JSON restore and chained publication', () => {
  const scope = { principal: 'owner', protocol: 'responses', target: 'target', policy: 'policy' };
  const map = createContextHistoryMap({ now: () => 100 });
  const seed = 'a'.repeat(64);
  const message = {
    type: 'message',
    id: 'msg_echo',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'answer' }],
    metadata: { provider: 'exact' },
    internal_chat_message_metadata_passthrough: null,
    phase: 'final',
  };
  const native = observedResponsesEcho([message])[0];
  const hidden = (id) => [
    { type: 'function_call', call_id: id, name: READ, arguments: '{}' },
    { type: 'function_call_output', call_id: id, output: 'private exact\r\n中文🙂' },
  ];
  const prepare = (history, parent, id) =>
    map.prepare({
      scope,
      clientHistory: history,
      hiddenTail: hidden(id),
      ...(parent ? { parent } : {}),
      publicWindow: {
        scope: seed,
        frontier: publicWindowFrontiers(seed, history).at(-1),
        count: history.length,
        publishedFrontier: null,
      },
    });
  const first = prepare(initial, null, 'read_1');
  assert.equal(first.ok, true);
  const committed = map.commit(first.token, [message]);
  assert.equal(committed.ok, true);
  for (const output of [message, native])
    assert.equal(
      map.rebuild({ scope, snapshot: committed.snapshot, clientHistory: [...initial, output] }).ok,
      true
    );
  assert.equal(
    map.rebuild({
      scope,
      snapshot: committed.snapshot,
      clientHistory: [...initial, { ...message, metadata: { provider: 'tampered' } }],
    }).ok,
    false
  );
  const nextHistory = [...initial, native, { role: 'user', content: 'next' }];
  const second = prepare(nextHistory, committed.snapshot, 'read_2');
  assert.equal(second.ok, true);
  const finalMessage = { ...message, id: 'msg_next' };
  const final = map.commit(second.token, [finalMessage]);
  assert.equal(final.ok, true);
  const state = JSON.parse(JSON.stringify(exportContextHistoryMap(map, scope, [final.snapshot])));
  assert.ok(
    state.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.window.echoPublishedFrontier))
  );
  const restored = restoreContextHistoryMap({ now: () => 101, scope }, state);
  const history = [...nextHistory, observedResponsesEcho([finalMessage])[0]];
  const result = restored.historyMap.rebuild({
    scope,
    snapshot: restored.snapshots.get(state.tips[0]),
    clientHistory: history,
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.history.filter(
      (item) => item.type === 'function_call_output' && item.output === 'private exact\r\n中文🙂'
    ).length,
    2
  );
  map.close();
  restored.historyMap.close();
});

test('private window echo metadata rejects malformed and uncommitted alias authority', () => {
  const window = {
    scope: 'a'.repeat(64),
    frontier: 'b'.repeat(64),
    count: 2,
    publishedFrontier: 'c'.repeat(64),
    echoPublishedFrontier: 'd'.repeat(64),
  };
  assert.equal(parsePublicWindow(window).echoPublishedFrontier, window.echoPublishedFrontier);
  for (const value of ['', null, 1, 'x'.repeat(65)])
    assert.throws(() => parsePublicWindow({ ...window, echoPublishedFrontier: value }));
  assert.throws(() => parsePublicWindow({ ...window, publishedFrontier: null }, false));
});

test('Codex summary receipt preserves server metadata and phase while refusing nested opaque signatures', () => {
  const initialResponse = {
    id: 'summary_observed',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_summary',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'exact summary\r\n中文🙂', annotations: [] }],
        metadata: { provider: 'exact' },
        internal_chat_message_metadata_passthrough: { category: 'exact' },
        phase: 'final',
      },
    ],
  };
  const before = JSON.stringify(initialResponse);
  const sealed = sealCodexSummaryResponse(initialResponse);
  assert.ok(sealed);
  assert.equal(JSON.stringify(initialResponse), before);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sealed.output[0].metadata)),
    initialResponse.output[0].metadata
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sealed.output[0].internal_chat_message_metadata_passthrough)),
    initialResponse.output[0].internal_chat_message_metadata_passthrough
  );
  assert.equal(sealed.output[0].phase, 'final');
  assert.equal(
    parseCodexSummaryReceipt([
      { role: 'user', content: [{ type: 'input_text', text: sealed.output[0].content[0].text }] },
    ]),
    sealed.responseId
  );
  for (const extra of [
    { phase: 'unexpected' },
    { metadata: [] },
    { metadata: 'invalid' },
    { internal_chat_message_metadata_passthrough: 1 },
    { metadata: { nested: [{ signature: 'opaque' }] } },
    { internal_chat_message_metadata_passthrough: { encrypted_content: 'opaque' } },
    { extra: true },
  ])
    assert.equal(
      sealCodexSummaryResponse({
        ...initialResponse,
        output: [{ ...initialResponse.output[0], ...extra }],
      }),
      null
    );
});

test('official HTTP composition normalizes absent instructions before strict recovery policy matching', () => {
  for (const normalized of [false, true]) {
    const runtime = createContextRecoverySessions({ now: () => 100 });
    runtime.configure(true);
    const prepared = {
      profile: {
        id: 'official',
        protocol: 'openai',
        targetUrl: 'https://chatgpt.com/backend-api/codex',
      },
      authMode: 'official-login',
      authProvider: 'openai',
    };
    const body = { model: 'synthetic', input: initial, tools: [], tool_choice: 'auto' };
    const parse = (value) => {
      const candidate = { ...prepared, buffer: Buffer.from(JSON.stringify(value)) };
      return normalized
        ? normalizeCodexResponsesRequest(candidate, {
            target: { path: '/backend-api/codex' },
            isResponsesRequest: true,
          })
        : candidate;
    };
    const begin = (candidate) =>
      beginContextRecoveryRequest(runtime, {
        auth: { ok: true, enabled: true, key: { id: 'owner' } },
        kind: 'responses',
        prepared: candidate,
        buffer: candidate.buffer,
      });
    const first = begin(parse(body));
    assert.equal(
      first.complete(
        [raw],
        parseApiEvidenceCalls('responses', { status: 'completed', output: [raw] })
      ).ok,
      true
    );
    const nextPrepared = parse({
      ...body,
      input: [
        ...initial,
        echo,
        {
          type: 'custom_tool_call_output',
          call_id: raw.call_id,
          output: [{ type: 'input_text', text: 'exact original' }],
        },
      ],
    });
    const next = begin(nextPrepared);
    assert.equal(next.inspect().visibleSources, 1);
    const result = next.recovery(JSON.parse(nextPrepared.buffer));
    assert.equal(result.ok, normalized);
    if (!normalized) assert.equal(result.code, 'context_recovery_policy_conflict');
    else result.cancel();
    runtime.close();
  }
});
