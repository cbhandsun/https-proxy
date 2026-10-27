'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { assertOwnerLaunches } = require('./helpers/physical-owner-receipt.cjs');
const { finishPhysicalOwnerCleanupAsync } = require('./helpers/physical-owner-cleanup.cjs');
const { createPhysicalOwnerFixtureCleanup } = require('./helpers/installed-fixture-cleanup');
const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { tryHandleContextRecoveryHttp } = require('../lib/proxy/context-recovery-http-entry');
const { decodeContextRecoveryResponse } = require('../lib/proxy/context-recovery-protocol');
const {
  isCodexSummaryRequest,
  isCodexSummaryReceipt,
  parseCodexSummaryReceipt,
  sealCodexSummaryResponse,
} = require('../lib/proxy/context-recovery-codex-summary');
const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  restoreContextRecoverySessions,
} = require('../lib/proxy/context-recovery-sessions');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const { RECOVERY_TTL_MS } = require('../lib/proxy/context-recovery-limits');
const { validateRecoveryRootPolicy } = require('../lib/proxy/context-recovery-root-policy');
const {
  CODEX_TOOLS_IDENTITY_FORMAT,
  codexToolInventory,
  codexToolsIdentityFormat,
  codexCompactionItemIdentity,
  codexRecoveryPolicyIdentity,
} = require('../lib/proxy/context-recovery-codex-tools');

const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const prompt = 'CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.';
const policy = {
  instructions: 'owned instructions',
  tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
  tool_choice: 'auto',
};
const body = (input, summary = false) => ({
  model: 'owned-model',
  ...policy,
  ...(summary ? { tools: [] } : {}),
  input,
});
const response = (text, id = 'owned-summary-response') => ({
  id,
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_' + id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
});
const echo = (sealed) => [
  user('native instructions'),
  user('Native wrapper\n' + sealed.response.output[0].content[0].text + '\nContinue.'),
];

test('Codex inline inventory boundary rejects malformed, excessive and executable data', () => {
  const inventory = {
    type: 'additional_tools',
    role: 'developer',
    id: 'tools_owned',
    tools: policy.tools,
  };
  assert.equal(codexToolInventory([]), null);
  assert.equal(codexToolInventory([user('ordinary')]), null);
  assert.deepEqual(JSON.parse(JSON.stringify(codexToolInventory([inventory]))), inventory);
  assert.equal(
    codexToolInventory([{ ...inventory, tools: Array(1024).fill({}) }]).tools.length,
    1024
  );
  for (const value of [
    null,
    {},
    Array(1),
    [null],
    [Object.create({ type: 'additional_tools' })],
    [user('before'), inventory],
    [inventory, inventory],
    [{ ...inventory, role: 'user' }],
    [{ ...inventory, id: '' }],
    [{ ...inventory, id: 'x'.repeat(257) }],
    [{ ...inventory, id: 'bad\n' }],
    [{ ...inventory, tools: null }],
    [{ ...inventory, tools: [1] }],
    [{ ...inventory, tools: Array(1025).fill({}) }],
    [{ ...inventory, extra: true }],
    [{ ...inventory, tools: [{ text: 'x'.repeat(2 * 1024 * 1024) }] }],
  ])
    assert.throws(() => codexToolInventory(value));
  let touched = false;
  const history = [];
  Object.defineProperty(history, '0', {
    enumerable: true,
    get() {
      touched = true;
      return inventory;
    },
  });
  const item = {
    get type() {
      touched = true;
      return 'additional_tools';
    },
  };
  const executablePolicy = {
    get codexAdditionalTools() {
      touched = true;
      return inventory;
    },
  };
  assert.throws(() => codexToolInventory(history));
  assert.throws(() => codexToolInventory([item]));
  assert.throws(() => codexToolsIdentityFormat('responses', executablePolicy));
  assert.throws(() => codexCompactionItemIdentity(item, 0, CODEX_TOOLS_IDENTITY_FORMAT));
  assert.equal(touched, false);
  assert.equal(codexToolsIdentityFormat('chat', {}), undefined);
  assert.throws(() => codexToolsIdentityFormat('chat', { codexAdditionalTools: inventory }));
  assert.throws(() => codexRecoveryPolicyIdentity({ codexAdditionalTools: inventory }, []));
  assert.throws(() => codexRecoveryPolicyIdentity(null, []));
  const bound = codexRecoveryPolicyIdentity(policy, [inventory]);
  assert.equal(codexToolsIdentityFormat('responses', bound), CODEX_TOOLS_IDENTITY_FORMAT);
  assert.deepEqual(codexCompactionItemIdentity(inventory, 0, CODEX_TOOLS_IDENTITY_FORMAT), {
    type: 'additional_tools',
    role: 'developer',
    tools: [],
  });
  assert.equal(codexCompactionItemIdentity(inventory, 1, CODEX_TOOLS_IDENTITY_FORMAT), inventory);
  assert.equal(codexCompactionItemIdentity(inventory, 0, undefined), inventory);
  assert.equal(codexCompactionItemIdentity(null, 0, CODEX_TOOLS_IDENTITY_FORMAT), null);
  const ordinary = user('ordinary');
  assert.equal(codexCompactionItemIdentity(ordinary, 0, CODEX_TOOLS_IDENTITY_FORMAT), ordinary);
  const compact = { ...body([inventory, user(prompt)], true), tools: [] };
  assert.equal(isCodexSummaryRequest(compact), false);
  compact.input[0] = { ...inventory, id: 'tools_empty', tools: [] };
  assert.equal(isCodexSummaryRequest(compact), true);
});

test('Codex local-summary classifier bounds untrusted inputs and distinguishes ordinary controls', () => {
  assert.equal(isCodexSummaryRequest(body([user(prompt)], true)), true);
  const omitted = body([user(prompt)], true);
  delete omitted.tools;
  assert.equal(isCodexSummaryRequest(omitted), true);
  assert.equal(isCodexSummaryRequest({ ...omitted, tool_choice: 'none' }), false);
  assert.equal(isCodexSummaryRequest({ ...omitted, previous_response_id: 'r' }), false);
  assert.equal(isCodexSummaryRequest({ ...omitted, input: [user('ordinary')] }), false);
  for (const patch of [
    { tools: policy.tools },
    { tools: null },
    { tool_choice: 'none' },
    { previous_response_id: 'r' },
    { input: [] },
    { input: [user('ordinary')] },
    { input: [{ role: 'assistant', content: [{ type: 'input_text', text: prompt }] }] },
  ])
    assert.equal(isCodexSummaryRequest({ ...body([user(prompt)], true), ...patch }), false);
  let accessed = false;
  assert.equal(
    isCodexSummaryRequest({
      get input() {
        accessed = true;
        return [];
      },
    }),
    false
  );
  assert.equal(accessed, false);
  for (const value of [
    null,
    [],
    1,
    {},
    { input: 'x' },
    body([user('x'.repeat(2 * 1024 * 1024) + prompt)], true),
  ])
    assert.equal(isCodexSummaryRequest(value), false);
});

test('Codex summary preserves supported assistant phases and rejects invalid phase values', () => {
  for (const phase of [undefined, null, 'analysis', 'final', 'commentary', 'final_answer']) {
    const initial = response('phase-preserving summary');
    if (phase !== undefined) initial.output[0].phase = phase;
    const before = JSON.stringify(initial);
    const sealed = sealCodexSummaryResponse(initial);
    assert.ok(sealed);
    assert.equal(sealed.response.output[0].phase, phase);
    assert.equal(parseCodexSummaryReceipt(echo(sealed)), sealed.responseId);
    assert.equal(JSON.stringify(initial), before);
  }
  for (const phase of ['', 'FINAL_ANSWER', 'final_answer\n', {}, [], 1]) {
    const initial = response('invalid phase');
    initial.output[0].phase = phase;
    assert.equal(sealCodexSummaryResponse(initial), null);
  }
});

test('Codex summary preserves an empty probability array and refuses unaligned or executable data', () => {
  const initial = response('中文🙂 summary');
  initial.output[0].phase = 'final_answer';
  initial.output[0].content[0].logprobs = [];
  const before = JSON.stringify(initial);
  const sealed = sealCodexSummaryResponse(initial);
  assert.ok(sealed);
  assert.deepEqual(sealed.output[0].content[0].logprobs, []);
  assert.equal(parseCodexSummaryReceipt(echo(sealed)), sealed.responseId);
  assert.equal(JSON.stringify(initial), before);
  for (const logprobs of [null, {}, '', 0, [0], [{ token: 'summary', logprob: -1 }]]) {
    const changed = response('summary');
    changed.output[0].content[0].logprobs = logprobs;
    assert.equal(sealCodexSummaryResponse(changed), null);
  }
  const unknown = response('summary');
  unknown.output[0].content[0].signature = 'opaque';
  assert.equal(sealCodexSummaryResponse(unknown), null);
  let touched = false;
  const executable = response('summary');
  Object.defineProperty(executable.output[0].content[0], 'logprobs', {
    enumerable: true,
    get() {
      touched = true;
      return [];
    },
  });
  assert.equal(sealCodexSummaryResponse(executable), null);
  assert.equal(touched, false);
});

test('Codex receipt binds exact Unicode summary, rejects tampering, duplicates and opaque output', () => {
  const initial = response('Original 中文🙂 summary\n');
  const before = JSON.stringify(initial);
  const sealed = sealCodexSummaryResponse(initial);
  assert.equal(JSON.stringify(initial), before);
  assert.equal(isCodexSummaryReceipt(sealed.responseId), true);
  assert.equal(parseCodexSummaryReceipt(echo(sealed)), sealed.responseId);
  assert.notEqual(sealCodexSummaryResponse(initial).responseId, sealed.responseId);
  const changed = echo(sealed);
  changed[1].content[0].text = changed[1].content[0].text.replace('Original', 'Tampered');
  assert.equal(parseCodexSummaryReceipt(changed), null);
  assert.equal(parseCodexSummaryReceipt([...echo(sealed), ...echo(sealed)]), null);
  assert.equal(
    parseCodexSummaryReceipt([...echo(sealed), { type: 'function_call', call_id: 'call' }]),
    null
  );
  for (const value of [
    null,
    [],
    {},
    'x',
    [{ role: 'user', content: [{ type: 'input_text', text: '<!-- hpm-codex-summary:bad -->' }] }],
  ])
    assert.equal(parseCodexSummaryReceipt(value), null);
  for (const value of [
    null,
    {},
    response(''),
    response('x'.repeat(1024 * 1024 + 1)),
    response(sealed.response.output[0].content[0].text),
    { ...initial, status: 'incomplete' },
    { ...initial, output: [...initial.output, { type: 'reasoning', encrypted_content: 'opaque' }] },
    { ...initial, output: [{ ...initial.output[0], signature: 'opaque' }] },
    {
      ...initial,
      output: [
        {
          ...initial.output[0],
          content: [{ type: 'output_text', text: 'summary', annotations: [{}] }],
        },
      ],
    },
  ])
    assert.equal(sealCodexSummaryResponse(value), null);
});

function fixture(
  startTime = 1000,
  omitSummaryTools = false,
  inlineTools = false,
  original = 'Exact original 中文🙂 content'
) {
  let time = startTime;
  let runtime = createContextRecoverySessions({ now: () => time });
  runtime.configure(true);
  const auth = { ok: true, enabled: true, key: { id: 'owned-principal' } };
  const prepared = {
    profile: { id: 'owned', protocol: 'openai', targetUrl: 'https://fixture.invalid/v1' },
    authMode: 'api-key',
  };
  let initialRequest;
  const begin = (value, extra = {}) =>
    beginContextRecoveryRequest(
      {
        begin(request, results) {
          initialRequest ??= JSON.parse(JSON.stringify(request));
          return runtime.begin(request, results);
        },
        beginCompaction(request, results) {
          return runtime.beginCompaction(request, results);
        },
      },
      {
        auth,
        prepared,
        kind: 'responses',
        buffer: Buffer.from(JSON.stringify(value)),
        ...extra,
      }
    );
  function wireBody(history, summary = false) {
    const value = body(history, summary);
    if (summary && omitSummaryTools) delete value.tools;
    if (inlineTools) {
      delete value.tools;
      const rest = history[0]?.type === 'additional_tools' ? history.slice(1) : history;
      value.input = [
        {
          type: 'additional_tools',
          role: 'developer',
          id: summary ? 'tools_empty' : 'tools_owned',
          tools: summary ? [] : policy.tools,
        },
        ...rest,
      ];
    }
    return value;
  }
  const initial = wireBody([user('original question')]);
  const first = begin(initial);
  const call = {
    type: 'function_call',
    id: 'fc_owned',
    call_id: 'owned_read',
    name: 'Read',
    arguments: '{}',
  };
  assert.equal(
    first.complete(
      [call],
      [{ callId: call.call_id, toolName: call.name, arguments: {}, completed: true, output: '' }],
      'owned-first'
    ).ok,
    true
  );
  const summaryBody = wireBody(
    [
      ...initial.input,
      call,
      { type: 'function_call_output', call_id: call.call_id, output: original },
      user(prompt),
    ],
    true
  );
  if (omitSummaryTools) delete summaryBody.tools;
  return {
    body: wireBody,
    begin,
    initial,
    first,
    call,
    original,
    summaryBody,
    auth,
    prepared,
    get runtime() {
      return runtime;
    },
    get initialRequest() {
      return initialRequest;
    },
    now: () => time,
    advance(value) {
      time += value;
    },
    reopen() {
      const state = exportContextRecoveryRoot(runtime, first.snapshotId);
      runtime.close();
      time++;
      runtime = restoreContextRecoverySessions({ now: () => time }, [
        { binding: initialRequest, state },
      ]);
      return state;
    },
  };
}

for (const [omitSummaryTools, inlineTools] of [
  [false, false],
  [true, false],
  [true, true],
])
  test(`native Codex local compaction preserves one root and exact originals through repeated receipt windows (omitted tools: ${omitSummaryTools}, inline tools: ${inlineTools})`, () => {
    const f = fixture(1000, omitSummaryTools, inlineTools);
    let nextBody;
    try {
      const summary = f.begin(f.summaryBody);
      assert.equal(summary.ok, true, summary.code);
      assert.equal(summary.inspect().visibleSources, 1);
      const run = summary.recovery(f.summaryBody);
      assert.equal(run.ok, true, run.code);
      const release = run.accept(response('Summary 中文🙂'));
      assert.equal(release.mode, 'release', release.code);
      nextBody = f.body(echo(release));
      assert.equal(f.begin(nextBody).code, 'context_binding_previous_unavailable');
      assert.equal(summary.complete(release.output, [], release.response.id).ok, true);
      for (let round = 0; round < 4; round++) {
        const next = f.begin(nextBody);
        assert.equal(next.ok, true, next.code);
        assert.equal(next.reason, 'observed_continuation');
        assert.equal(next.inspect().visibleSources, 1);
        const index = JSON.parse(next.reply(LIST, {}).text);
        assert.equal(
          JSON.parse(
            next.reply(READ, {
              sourceId: index.sources[0].sourceId,
              digest: index.sources[0].digest,
            }).text
          ).page.text,
          f.original
        );
        const answer = response('answer', 'owned-answer-' + round);
        assert.equal(next.complete(answer.output, [], answer.id).ok, true);
        const compactBody = f.body([...nextBody.input, ...answer.output, user(prompt)], true);
        if (omitSummaryTools) delete compactBody.tools;
        const compact = f.begin(compactBody);
        assert.equal(compact.ok, true, compact.code);
        const phase = compact.recovery(compactBody);
        assert.equal(phase.ok, true, phase.code);
        const released = phase.accept(response('summary-' + round, 'summary-' + round));
        assert.equal(released.mode, 'release', released.code);
        assert.equal(compact.complete(released.output, [], released.response.id).ok, true);
        nextBody = f.body(echo(released));
        f.reopen();
        assert.equal(f.runtime.inspect().roots, 1);
        assert.equal(
          exportContextRecoveryRoot(f.runtime, f.first.snapshotId).binding.identityFormat,
          inlineTools ? CODEX_TOOLS_IDENTITY_FORMAT : undefined
        );
      }
    } finally {
      f.runtime.close();
    }
  });

test('consecutive native summaries bind observed receipts across tool omission and checkpoint reconstruction', () => {
  const f = fixture(1000, true, true);
  let compactBody = f.summaryBody;
  let released;
  try {
    const expiry = exportContextRecoveryRoot(f.runtime, f.first.snapshotId).expiresAt;
    for (let round = 0; round < 3; round++) {
      const compact = f.begin(compactBody);
      assert.equal(compact.ok, true, compact.code);
      assert.equal(compact.inspect().localSummary, true);
      assert.equal(compact.inspect().visibleSources, 1);
      const run = compact.recovery(compactBody);
      assert.equal(run.ok, true, run.code);
      released = run.accept(response('Consecutive summary ' + round, 'consecutive-' + round));
      assert.equal(released.mode, 'release', released.code);
      assert.equal(compact.complete(released.output, [], released.response.id).ok, true);
      const state = f.reopen();
      assert.equal(state.expiresAt, expiry);
      assert.match(state.binding.snapshots.at(-1).summaryResponseKey, /^[a-f0-9]{64}$/);
      assert.equal(f.runtime.inspect().roots, 1);
      compactBody = f.body([...echo(released), user(prompt)], true);
      const changed = JSON.parse(JSON.stringify(compactBody));
      changed.instructions += ' changed';
      assert.equal(f.begin(changed).code, 'context_binding_previous_unavailable');
      const malformed = JSON.parse(JSON.stringify(state));
      malformed.binding.snapshots.at(-1).summaryResponseKey = 'invalid';
      assert.throws(() =>
        restoreContextRecoverySessions({ now: () => 1000 + round + 1 }, [
          { binding: f.initialRequest, state: malformed },
        ])
      );
    }
    const next = f.begin(f.body(echo(released)));
    assert.equal(next.ok, true, next.code);
    const index = JSON.parse(next.reply(LIST, {}).text);
    assert.equal(
      JSON.parse(
        next.reply(READ, { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest })
          .text
      ).page.text,
      f.original
    );
    next.abort();
  } finally {
    f.runtime.close();
  }
});

test('inline tool compaction preserves exact ancestry, policy isolation and ambiguity refusal', () => {
  const f = fixture(1000, true, true);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  try {
    const original = exportContextRecoveryRoot(f.runtime, f.first.snapshotId);
    const ordinary = f.body([
      ...f.initial.input,
      f.call,
      { type: 'function_call_output', call_id: f.call.call_id, output: f.original },
      user('continue'),
    ]);
    ordinary.input[0].tools = [{ ...policy.tools[0], name: 'Different' }];
    const isolated = f.begin(ordinary);
    assert.equal(isolated.ok, true, isolated.code);
    assert.equal(isolated.inspect().visibleSources, 0);
    assert.equal(isolated.reason, 'isolated_request');
    isolated.abort();
    const remoteChangedTools = JSON.parse(JSON.stringify(ordinary));
    delete remoteChangedTools.tool_choice;
    assert.equal(
      f.begin(remoteChangedTools, { compaction: true }).code,
      'context_binding_compaction_policy_conflict'
    );
    for (const change of [
      (value) => {
        value.instructions += ' changed';
      },
      (value) => {
        value.system = 'changed';
      },
      (value) => {
        value.input[1].content[0].text += ' changed';
      },
    ]) {
      const changed = clone(f.summaryBody);
      change(changed);
      assert.equal(f.begin(changed).code, 'context_binding_compaction_unobserved');
    }
    assert.equal(
      f.begin(f.summaryBody, { auth: { ok: true, enabled: true, key: { id: 'other-principal' } } })
        .code,
      'context_binding_compaction_unobserved'
    );
    assert.equal(
      f.begin(f.summaryBody, {
        prepared: {
          ...f.prepared,
          profile: { ...f.prepared.profile, targetUrl: 'https://other.invalid/v1' },
        },
      }).code,
      'context_binding_compaction_unobserved'
    );
    for (const marker of [undefined, 'unknown-format']) {
      const changed = clone(original);
      if (marker === undefined) delete changed.binding.identityFormat;
      else changed.binding.identityFormat = marker;
      assert.throws(() =>
        restoreContextRecoverySessions({ now: () => 1000 }, [
          { binding: f.initialRequest, state: changed },
        ])
      );
    }
    const secondBody = clone(f.initial);
    secondBody.input[0].tools = [{ ...policy.tools[0], name: 'Second' }];
    const second = f.begin(secondBody);
    assert.equal(second.ok, true, second.code);
    assert.equal(
      second.complete(
        [f.call],
        [
          {
            callId: f.call.call_id,
            toolName: f.call.name,
            arguments: {},
            completed: true,
            output: '',
          },
        ],
        'second-anchored'
      ).ok,
      true
    );
    assert.equal(f.begin(f.summaryBody).code, 'context_binding_compaction_ambiguous');
    assert.equal(
      exportContextRecoveryRoot(f.runtime, f.first.snapshotId).expiresAt,
      original.expiresAt
    );
  } finally {
    f.runtime.close();
  }
});

test('Responses summary checkpoints declare their schema and reject version relabelling', () => {
  const f = fixture();
  try {
    const legacy = exportContextRecoveryRoot(f.runtime, f.first.snapshotId);
    assert.equal(legacy.version, 10);
    for (const snapshots of [null, {}, [], Array(513).fill(null)]) {
      const malformed = JSON.parse(JSON.stringify(legacy));
      malformed.binding.snapshots = snapshots;
      assert.throws(() => validateRecoveryRootPolicy(malformed), {
        code: 'context_recovery_storage_unavailable',
      });
    }
    let accessed = false;
    const accessor = JSON.parse(JSON.stringify(legacy));
    Object.defineProperty(accessor.binding, 'snapshots', {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error('synthetic-private-content');
      },
    });
    assert.throws(() => validateRecoveryRootPolicy(accessor), {
      code: 'context_recovery_storage_unavailable',
      message: 'context_recovery_storage_unavailable',
    });
    assert.equal(accessed, false);
    const summary = f.begin(f.summaryBody);
    const released = summary.recovery(f.summaryBody).accept(response('summary'));
    assert.equal(summary.complete(released.output, [], released.response.id).ok, true);
    const next = f.begin(body(echo(released)));
    assert.equal(next.ok, true);
    const answer = response('answer', 'schema-answer');
    assert.equal(next.complete(answer.output, [], answer.id).ok, true);
    const state = exportContextRecoveryRoot(f.runtime, f.first.snapshotId);
    assert.equal(state.version, 10);
    assert.equal(validateRecoveryRootPolicy(state), 10);
    assert.equal(state.expiresAt, legacy.expiresAt);
    for (const version of [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, null, '9']) {
      const changed = JSON.parse(JSON.stringify(state));
      changed.version = version;
      assert.throws(() => validateRecoveryRootPolicy(changed));
      assert.throws(
        () =>
          restoreContextRecoverySessions({ now: () => 1001 }, [
            { binding: f.initialRequest, state: changed },
          ]),
        { code: 'invalid_context_recovery_root_state' }
      );
    }
    // Validation failure must not revoke the live owner's original authority.
    assert.equal(f.runtime.inspect().roots, 1);
    assert.equal(f.reopen().version, 10);
  } finally {
    f.runtime.close();
  }
});

for (const [forced, inlineTools] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])
  test(
    (forced
      ? 'v7 summary survives owner force-kill and preserves committed revocation after another force-kill'
      : 'v7 summary survives two physical owners through real encrypted storage without extending expiry') +
      ` (inline tools: ${inlineTools})`,
    { timeout: 90000 },
    async () => {
      const f = fixture(Date.now(), inlineTools, inlineTools);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-v7-owner-'));
      const primaryFailures = [];
      let cleanup;
      try {
        cleanup = createPhysicalOwnerFixtureCleanup(directory);
        const summary = f.begin(f.summaryBody);
        const released = summary.recovery(f.summaryBody).accept(response('summary'));
        assert.equal(summary.complete(released.output, [], released.response.id).ok, true);
        const nextBody = f.body(echo(released));
        const next = f.begin(nextBody);
        const answer = response('answer', 'persisted-answer');
        assert.equal(next.complete(answer.output, [], answer.id).ok, true);
        const state = exportContextRecoveryRoot(f.runtime, f.first.snapshotId);
        assert.equal(state.version, 10);
        f.runtime.close();
        const payload = {
          state,
          binding: f.initialRequest,
          auth: f.auth,
          prepared: f.prepared,
          body: f.body([...nextBody.input, ...answer.output, user('after owner restart')]),
          original: f.original,
        };
        const reports = [];
        const launches = [];
        for (const operation of forced
          ? ['save-crash', 'read', 'revoke-crash', 'read-revoked']
          : ['save', 'read']) {
          const runId = randomBytes(16).toString('hex');
          launches.push({ runId, operation });
          const result = spawnSync(
            process.execPath,
            [
              path.resolve(__dirname, 'helpers/context-recovery-v7-owner.cjs'),
              operation,
              path.join(directory, 'context'),
            ],
            {
              env: {
                ...getDefaultEnvironment(),
                ...(process.env.NODE_V8_COVERAGE
                  ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }
                  : {}),
              },
              input: JSON.stringify({ ...payload, runId }),
              encoding: 'utf8',
              windowsHide: true,
              shell: false,
              timeout: 30000,
            }
          );
          assert.equal(result.error, undefined);
          if (process.platform !== 'win32') {
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            assert.equal(result.stderr, 'v7_owner_failed\n');
            return;
          }
          if (operation.endsWith('-crash')) assert.notEqual(result.status, 0);
          else assert.equal(result.status, 0, 'isolated encrypted owner must exit successfully');
          const report = JSON.parse(result.stdout);
          assert.equal(report.runId, runId);
          assert.equal(report.operation, operation);
          assert.equal(report.closeSkipped, operation.endsWith('-crash'));
          assert.equal(report.commitAcknowledged, operation.endsWith('-crash'));
          assert.equal(report.version, 10);
          assert.equal(report.expiresAt, state.expiresAt);
          assert.notEqual(report.pid, process.pid);
          reports.push(report);
        }
        assertOwnerLaunches(reports, launches, process.pid);
        assert.equal(reports[1].exactRead, true);
        if (forced) {
          assert.equal(reports.length, 4);
          assert.equal(reports[3].revoked, true);
        }
        const files = fs.readdirSync(directory, { recursive: true });
        for (const relative of files) {
          const file = path.join(directory, relative);
          if (fs.statSync(file).isFile())
            assert.equal(fs.readFileSync(file).includes(Buffer.from(f.original)), false);
        }
      } catch (error) {
        primaryFailures.push(error);
        throw error;
      } finally {
        await finishPhysicalOwnerCleanupAsync(primaryFailures, [
          () => f.runtime.close(),
          () => {
            assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
            assert.ok(path.basename(directory).startsWith('hpm-v7-owner-'));
            if (cleanup) return cleanup();
          },
        ]);
      }
    }
  );

test('summary prompt alone grants no authority; full policy, owner, expiry and publication remain required', () => {
  const f = fixture();
  try {
    const unobserved = f.begin(body([user(prompt)], true));
    assert.equal(unobserved.ok, false);
    const summary = f.begin(f.summaryBody);
    assert.equal(summary.ok, true, summary.code);
    const released = summary.recovery(f.summaryBody).accept(response('summary'));
    assert.equal(summary.complete(released.output, [], released.response.id).ok, true);
    const nextBody = body(echo(released));
    for (const changed of [
      { ...nextBody, instructions: 'different' },
      { ...nextBody, tools: [] },
      { ...nextBody, tool_choice: 'none' },
    ])
      assert.equal(f.begin(changed).ok, false);
    assert.equal(
      f.begin(nextBody, { auth: { ok: true, enabled: true, key: { id: 'other' } } }).ok,
      false
    );
    assert.equal(
      f.begin({ ...nextBody, previous_response_id: parseCodexSummaryReceipt(nextBody.input) }).ok,
      false
    );
    f.advance(RECOVERY_TTL_MS);
    assert.equal(f.begin(nextBody).ok, false);
  } finally {
    f.runtime.close();
  }
});

test('unsealed, mixed, cancelled and withdrawn summaries never publish recovery authority', () => {
  for (const mode of ['unsealed', 'mixed', 'invalid', 'cancelled', 'withdrawn', 'revoked']) {
    const f = fixture();
    try {
      const summary = f.begin(f.summaryBody);
      assert.equal(summary.ok, true, summary.code);
      if (mode === 'unsealed') {
        assert.equal(summary.complete(response('raw').output, [], 'raw').ok, false);
        summary.abort();
        continue;
      }
      const run = summary.recovery(f.summaryBody);
      assert.equal(run.ok, true, run.code);
      if (mode === 'mixed') {
        const invalid = run.accept({
          id: 'mixed',
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'external', name: 'Read', arguments: '{}' }],
        });
        assert.equal(invalid.mode, 'failed');
        summary.abort();
        continue;
      }
      if (mode === 'invalid') {
        assert.equal(run.accept(response('')).mode, 'failed');
        summary.abort();
        continue;
      }
      const released = run.accept(response('owned summary'));
      assert.equal(released.mode, 'release');
      if (mode === 'cancelled') summary.abort();
      else {
        assert.equal(summary.complete(released.output, [], released.response.id).ok, true);
        if (mode === 'withdrawn') summary.withdraw();
        else f.runtime.configure(false);
      }
      assert.equal(f.begin(body(echo(released))).ok, false);
    } finally {
      f.runtime.close();
    }
  }
});

test('an already observed summary with no sources still seals a receipt and retains isolation', () => {
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  const auth = { ok: true, enabled: true, key: { id: 'zero-source-owner' } };
  const prepared = {
    profile: { id: 'zero', protocol: 'openai', targetUrl: 'https://fixture.invalid/v1' },
    authMode: 'api-key',
  };
  const begin = (value) =>
    beginContextRecoveryRequest(runtime, {
      auth,
      prepared,
      kind: 'responses',
      buffer: Buffer.from(JSON.stringify(value)),
    });
  try {
    const originalBody = body([user('question')]);
    const original = begin(originalBody);
    const answer = response('answer');
    assert.equal(original.complete(answer.output, [], answer.id).ok, true);
    const compactBody = body([...originalBody.input, ...answer.output, user(prompt)], true);
    const compact = begin(compactBody);
    assert.equal(compact.inspect().localSummary, true);
    assert.equal(compact.inspect().visibleSources, 0);
    const result = compact.recovery(compactBody).accept(response('summary'));
    assert.equal(result.mode, 'release');
    assert.equal(compact.complete(result.output, [], result.response.id).ok, true);
    const continued = begin(body(echo(result)));
    assert.equal(continued.reason, 'observed_continuation');
    assert.equal(continued.inspect().visibleSources, 0);
    assert.equal(runtime.inspect().roots, 1);
  } finally {
    runtime.close();
  }
});

test('actual HTTP recovery boundary publishes local-summary receipts for JSON and SSE', async () => {
  for (const stream of [false, true]) {
    const f = fixture();
    try {
      const session = f.begin(f.summaryBody);
      const req = new EventEmitter();
      const res = new EventEmitter();
      res.writeHead = (status) => {
        res.statusCode = status;
        res.headersSent = true;
      };
      res.end = (wire) => {
        res.wire = wire;
        res.writableEnded = true;
        res.emit('finish');
      };
      res.destroy = () => {
        res.destroyed = true;
        res.emit('close');
      };
      let finish;
      const outcome = new Promise((resolve) => {
        finish = resolve;
      });
      assert.equal(
        tryHandleContextRecoveryHttp({
          kind: 'responses',
          session,
          observer: { detach: () => true },
          clientReq: req,
          clientRes: res,
          prepared: { buffer: Buffer.from(JSON.stringify(f.summaryBody)) },
          requestOptions: { headers: {} },
          stream,
          authorized: () => true,
          setActive() {},
          onOutcome: finish,
          dispatch: async () => ({
            statusCode: 200,
            wire: Buffer.from(JSON.stringify(response('HTTP owned summary'))),
            stream: false,
          }),
        }),
        true
      );
      await outcome;
      assert.equal(res.statusCode, 200);
      assert.equal(res.destroyed, undefined);
      const decoded = decodeContextRecoveryResponse('responses', res.wire, stream);
      const next = f.begin(body(echo({ response: { output: decoded.output } })));
      assert.equal(next.ok, true, next.code);
      assert.equal(next.inspect().visibleSources, 1);
      assert.equal(f.runtime.inspect().roots, 1);
      assert.equal(res.wire.includes(Buffer.from(LIST)), false);
      assert.equal(res.wire.includes(Buffer.from(READ)), false);
    } finally {
      f.runtime.close();
    }
  }
});

test('restored Codex summary completes isolated READ and encrypted public publication', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { randomBytes } = require('node:crypto');
  const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
  const {
    attachContextRecoveryStorage,
    exportContextRecoveryRootMetadata,
  } = require('../lib/proxy/context-recovery-sessions');
  const { validateRecoveryRootMetadata } = require('../lib/proxy/context-recovery-root-state');
  const { runContextRecovery } = require('../lib/proxy/context-recovery-runner');
  const { encodeContextRecoveryClientWire } = require('../lib/proxy/context-recovery-client-wire');
  const database = new DatabaseSync(':memory:');
  const f = fixture(
    1000,
    false,
    false,
    'N09_PRIVATE_CONTENT synthetic ' + 'synthetic-evidence '.repeat(256)
  );
  // The owner and storage observe one clock, as in the real worker. A future
  // storage observation must remain a refusal, not a valid restored READ.
  const storage = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: f.now,
  });
  let dispatches = 0;
  try {
    const compact = f.begin(f.summaryBody);
    const summary = compact.recovery(f.summaryBody).accept(response('summary for restored owner'));
    assert.equal(summary.mode, 'release');
    assert.equal(compact.complete(summary.output, [], summary.response.id).ok, true);
    f.reopen();
    attachContextRecoveryStorage(f.runtime, storage);
    const continuedBody = f.body(echo(summary));
    const next = f.begin(continuedBody);
    assert.equal(next.ok, true, next.code);
    const run = next.recovery(continuedBody, { publicGeneration: 'isolated' });
    const result = await runContextRecovery({
      kind: 'responses',
      session: { recovery: () => run },
      dispatch(request) {
        const output = response('private completion', 'restored-round-' + dispatches);
        if (dispatches < 2) {
          let args = { limit: 1 };
          if (dispatches === 1) {
            const index = JSON.parse(request.input.at(-1).output);
            assert.equal(index.ok, true);
            assert.equal(index.sources.length, 1);
            args = {
              sourceId: index.sources[0].sourceId,
              digest: index.sources[0].digest,
              offsetBytes: 0,
              limitBytes: 8192,
            };
          }
          output.output = [
            {
              type: 'function_call',
              call_id: dispatches === 0 ? 'index' : 'page',
              name: dispatches === 0 ? LIST : READ,
              arguments: JSON.stringify(args),
            },
          ];
        } else if (dispatches === 2) {
          assert.equal(JSON.parse(request.input.at(-1).output).page.text, f.original);
        } else {
          assert.equal(dispatches, 3);
          assert.ok(JSON.stringify(request).includes(f.original));
          assert.ok(!(request.tools ?? []).some((tool) => [LIST, READ].includes(tool.name)));
          output.output[0].content[0].text = 'public restored answer';
        }
        dispatches++;
        return { statusCode: 200, wire: Buffer.from(JSON.stringify(output)), stream: false };
      },
    });
    assert.equal(result.ok, true, result.code);
    assert.equal(dispatches, 4);
    const encoded = encodeContextRecoveryClientWire(
      'responses',
      result.response,
      result.usage,
      false
    );
    const decoded = decodeContextRecoveryResponse('responses', encoded.wire, false);
    assert.deepEqual(await next.completeAsync(decoded.output, decoded.calls, decoded.responseId), {
      ok: true,
    });
    assert.deepEqual(await next.startPublicationAsync(), { ok: true });
    assert.deepEqual(await next.finishPublicationAsync(), { ok: true });
    assert.ok(!encoded.wire.includes(Buffer.from(LIST)));
    assert.ok(!encoded.wire.includes(Buffer.from(READ)));
    const stream = encodeContextRecoveryClientWire(
      'responses',
      result.response,
      result.usage,
      true
    );
    assert.deepEqual(
      decodeContextRecoveryResponse('responses', stream.wire, true).output,
      decoded.output
    );
    assert.ok(!stream.wire.includes(Buffer.from(LIST)));
    assert.ok(!stream.wire.includes(Buffer.from(READ)));
    const state = exportContextRecoveryRootMetadata(f.runtime, f.first.snapshotId);
    assert.doesNotThrow(() => validateRecoveryRootMetadata(state));
    const answerIndex = state.metadata.snapshots.findIndex((view) => view.publicResponse);
    const summaryIndex = state.metadata.binding.snapshots.findIndex((view) =>
      Object.hasOwn(view, 'summaryResponseKey')
    );
    assert.ok(answerIndex >= 0);
    assert.ok(summaryIndex >= 0);
    assert.equal(state.metadata.binding.snapshots[answerIndex].window.kind, 'summary');
    assert.equal(state.metadata.snapshots[answerIndex].pendingReady, true);
    const mappingId = state.metadata.snapshots[answerIndex].mappingId;
    const entryIndex = state.metadata.history.entries.findIndex((entry) => entry.id === mappingId);
    assert.ok(entryIndex >= 0);
    for (const mutate of [
      (value) => {
        value.metadata.snapshots[summaryIndex].publicResponse = true;
      },
      (value) => {
        value.metadata.binding.snapshots[answerIndex].responseKey = null;
      },
      (value) => {
        value.metadata.binding.snapshots[answerIndex].window.kind = 'compaction';
      },
      (value) => {
        value.metadata.history.entries[entryIndex].window.scope = 'a'.repeat(64);
      },
      (value) => {
        value.metadata.history.entries[entryIndex].window.frontier = 'b'.repeat(64);
      },
      (value) => {
        value.metadata.history.entries[entryIndex].window.publishedFrontier = 'c'.repeat(64);
      },
      (value) => {
        value.metadata.history.entries[entryIndex].window.count++;
      },
      (value) => {
        value.metadata.history.entries[entryIndex].offset++;
      },
      (value) => {
        value.metadata.history.entries[entryIndex].parentId =
          value.metadata.history.entries[entryIndex].id;
      },
    ]) {
      const invalid = JSON.parse(JSON.stringify(state));
      mutate(invalid);
      assert.throws(() => validateRecoveryRootMetadata(invalid));
    }
    const scope = database.prepare('SELECT scope FROM recovery_state').get().scope;
    const saved = storage.execute({ operation: 'load', scope });
    const reopened = restoreContextRecoverySessions({ now: () => 1002 }, [
      { binding: f.initialRequest, state: saved.state.root },
    ]);
    try {
      const followingBody = {
        ...f.body([user('continue after public publication')]),
        previous_response_id: result.response.id,
      };
      const following = beginContextRecoveryRequest(reopened, {
        auth: f.auth,
        prepared: f.prepared,
        kind: 'responses',
        buffer: Buffer.from(JSON.stringify(followingBody)),
      });
      assert.equal(following.ok, true, following.code);
      assert.equal(following.recovery(followingBody, { publicGeneration: 'isolated' }).ok, true);
      assert.equal(
        exportContextRecoveryRoot(reopened, f.first.snapshotId).expiresAt,
        state.metadata.expiresAt
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.runtime.close();
    storage.close();
    database.close();
  }
});
