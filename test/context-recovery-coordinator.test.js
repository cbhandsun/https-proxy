'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextRecoveryCoordinator } = require('../lib/proxy/context-recovery-coordinator');
const {
  createContextEvidenceTools,
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  restoreContextRecoverySessions,
} = require('../lib/proxy/context-recovery-sessions');
const {
  fingerprintContextData,
  fingerprintRecoveryCheckpoint,
} = require('../lib/proxy/context-recovery-fingerprint');
const { runContextRecovery } = require('../lib/proxy/context-recovery-runner');

const plain = (value) => JSON.parse(JSON.stringify(value));

test('Responses private reader declarations preserve optional fields without changing host validation', () => {
  const { createContextRecoveryTurn } = require('../lib/proxy/context-recovery-turn');
  const { parseContextEvidenceRequest } = require('../lib/proxy/context-evidence-request');
  const readers = createContextEvidenceTools({ list: () => [], read: () => null });
  const external = {
    type: 'function',
    name: 'owned_external',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };
  const input = { input: [{ role: 'user', content: 'recover' }], tools: [external] };
  const before = JSON.stringify(input);
  const adapter = createContextRecoveryTurn('responses', input, readers.definitions);
  assert.equal(adapter.ok, true);
  const request = adapter.request(adapter.history);
  assert.deepEqual(plain(request.tools[0]), external);
  assert.equal(JSON.stringify(input), before);
  for (const definition of readers.definitions) {
    const injected = request.tools.find((tool) => tool.name === definition.name);
    assert.equal(injected.strict, false);
    assert.deepEqual(plain(injected.parameters), plain(definition.inputSchema));
  }
  assert.equal(parseContextEvidenceRequest(LIST, {}).ok, true);
  for (const args of [
    { afterSourceId: null },
    { afterSourceId: '' },
    { afterSourceId: 'hce_' + 'a'.repeat(33) },
    { limit: 0 },
    { limit: 17 },
    { limit: '16' },
    { unexpected: true },
  ])
    assert.equal(parseContextEvidenceRequest(LIST, args).ok, false);
  assert.equal(parseContextEvidenceRequest(READ, {}).ok, false);
  for (const kind of ['chat', 'claude']) {
    const turn = createContextRecoveryTurn(kind, { messages: [] }, readers.definitions);
    const injected = turn.request(turn.history).tools;
    assert.equal(injected.length, 2);
    assert.ok(injected.every((tool) => !Object.hasOwn(tool, 'strict')));
    if (kind === 'chat')
      assert.ok(injected.every((tool) => !Object.hasOwn(tool.function, 'strict')));
  }
});

test('restored legacy binding cannot acquire aggregate long-history admission', () => {
  let runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  const base = {
    principal: 'legacy-owner',
    protocol: 'chat',
    target: 'synthetic',
    history: [{ role: 'user', content: 'short' }],
  };
  const output = [{ role: 'assistant', id: 'observed-legacy', content: 'done' }];
  try {
    const first = runtime.begin(base);
    assert.equal(first.complete(output, [], 'legacy-response').ok, true);
    const state = exportContextRecoveryRoot(runtime, first.snapshotId);
    state.binding.format = 2;
    runtime.close();
    runtime = restoreContextRecoverySessions({ now: () => 101 }, [{ binding: base, state }]);
    const result = runtime.begin({
      ...base,
      history: [
        ...base.history,
        ...output,
        ...Array.from({ length: 3 }, () => ({ role: 'user', content: 'x'.repeat(900 * 1024) })),
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_context_binding');
    assert.equal(runtime.inspect().roots, 1);
  } finally {
    runtime.close();
  }
});

test('owner-selected long history survives a private round while legacy coordinators retain their limit', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const history = Array.from({ length: 3 }, () => ({
      role: 'user',
      content: 'x'.repeat(900 * 1024),
    }));
    const key = kind === 'responses' ? 'input' : 'messages';
    const runtime = createContextRecoverySessions();
    runtime.configure(true);
    try {
      const schema = { type: 'object' };
      const tools = [
        kind === 'chat'
          ? { type: 'function', function: { name: 'shell', parameters: schema } }
          : kind === 'responses'
            ? { type: 'function', name: 'shell', parameters: schema }
            : { name: 'shell', input_schema: schema },
      ];
      const policy = { instructions: null, system: null, tools, toolChoice: null };
      const session = runtime.begin({
        principal: 'long-owner',
        protocol: kind,
        target: 'synthetic',
        policy,
        history,
      });
      assert.equal(session.ok, true);
      assert.equal(session.historyFormat, 3);
      assert.throws(() =>
        createContextRecoveryCoordinator({ kind, body: { [key]: history }, session })
      );
      const run = session.recovery({ [key]: history, tools });
      assert.equal(run.ok, true);
      assert.equal(run.initialRequest[key][2].content, history[2].content);
      const next = run.accept(response(kind, [{ id: 'long-private', name: LIST }]));
      assert.equal(next.mode, 'continue');
      assert.equal(next.request[key][2].content, history[2].content);
      const released = run.accept(
        response(kind, [{ id: 'long-external', name: 'shell' }], { id: 'long-final' })
      );
      assert.equal(released.mode, 'release');
      assert.equal(
        session.complete(
          released.output,
          [
            {
              callId: 'long-external',
              toolName: 'shell',
              arguments: {},
              completed: true,
              output: '',
            },
          ],
          'long-final'
        ).ok,
        true
      );
      const toolResult =
        kind === 'chat'
          ? { role: 'tool', tool_call_id: 'long-external', content: 'synthetic-result' }
          : kind === 'responses'
            ? { type: 'function_call_output', call_id: 'long-external', output: 'synthetic-result' }
            : {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'long-external',
                    content: 'synthetic-result',
                  },
                ],
              };
      const continuedHistory = [
        ...history,
        ...plain(released.output),
        toolResult,
        { role: 'user', content: 'next' },
      ];
      const continuation = runtime.begin({
        principal: 'long-owner',
        protocol: kind,
        target: 'synthetic',
        policy,
        history: continuedHistory,
      });
      assert.equal(continuation.ok, true);
      const nextRun = continuation.recovery({ [key]: continuedHistory, tools });
      assert.equal(nextRun.ok, true);
      assert.equal(nextRun.initialRequest[key][2].content, history[2].content);
      assert.equal(
        nextRun.initialRequest[key].slice(3).some((item) => JSON.stringify(item).includes(LIST)),
        true,
        kind
      );
      nextRun.cancel();
    } finally {
      runtime.close();
    }
  }
});

test('Responses native catalog keeps namespaces, custom input and hosted tools through private reads', () => {
  const tools = [
    { type: 'function', name: 'lookup', parameters: { type: 'object' } },
    {
      type: 'namespace',
      name: 'multi_agent_v1',
      description: 'native group',
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'custom', name: 'patch', format: { type: 'text' } },
      ],
    },
    { type: 'web_search', search_context_size: 'medium', external_web_access: false },
  ];
  const f = fixture('responses', { tools });
  const c = f.create();
  assert.equal(c.ok, true);
  assert.deepEqual(plain(c.initialRequest.tools.slice(0, tools.length)), tools);
  const continued = c.accept(response('responses', [{ id: 'private', name: LIST }]));
  assert.equal(continued.mode, 'continue');
  assert.deepEqual(plain(continued.request.tools.slice(0, tools.length)), tools);
  const external = {
    id: 'ctc-native',
    type: 'custom_tool_call',
    call_id: 'custom-native',
    namespace: 'multi_agent_v1',
    name: 'patch',
    input: '*** Begin Patch\n*** End Patch',
    status: 'completed',
  };
  const release = c.accept({ id: 'r-custom', status: 'completed', output: [external] });
  assert.equal(release.mode, 'release');
  assert.deepEqual(plain(release.response.output), [external]);
  assert.deepEqual(
    f.executed.map((call) => call.name),
    [LIST]
  );
});

test('Responses namespace identity prevents private spoofing and never flattens ambiguous names', () => {
  const tools = [
    { type: 'function', name: 'lookup' },
    { type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'lookup' }] },
    { type: 'namespace', name: 'support', tools: [{ type: 'function', name: 'lookup' }] },
  ];
  for (const namespace of [undefined, 'crm', 'support']) {
    const f = fixture('responses', { tools });
    const c = f.create();
    assert.equal(c.ok, true);
    const call = {
      type: 'function_call',
      id: 'fc',
      call_id: 'qualified',
      name: 'lookup',
      arguments: '{}',
      ...(namespace === undefined ? {} : { namespace }),
    };
    const release = c.accept({ status: 'completed', output: [call] });
    assert.equal(release.mode, 'release');
    assert.deepEqual(plain(release.output), [call]);
    assert.equal(f.executed.length, 0);
  }
  for (const override of [
    { name: LIST, namespace: 'crm' },
    { name: LIST, namespace: '' },
    { name: LIST, namespace: 0 },
    { name: 'lookup', namespace: 'unknown' },
    { name: 'crm.lookup' },
    { name: 'lookup', type: 'custom_tool_call', input: 'opaque' },
    { name: LIST, type: 'custom_tool_call', input: '{}' },
  ]) {
    const f = fixture('responses', { tools });
    const c = f.create();
    assert.equal(c.ok, true);
    const result = c.accept({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'fc',
          call_id: 'spoof',
          name: LIST,
          arguments: '{}',
          ...override,
        },
      ],
    });
    assert.equal(result.mode, 'failed');
    assert.equal(f.executed.length, 0);
  }
});

test('Responses catalog rejects malformed namespaces, reserved aliases and unsupported hosted execution', () => {
  for (const tools of [
    [{ type: 'namespace', name: 'crm', tools: [] }],
    [{ type: 'namespace', name: 'crm', tools: null }],
    [
      {
        type: 'namespace',
        name: 'crm',
        tools: Array.from({ length: 129 }, (_, i) => ({ type: 'function', name: 'f' + i })),
      },
    ],
    [{ type: 'namespace', name: 'crm', tools: [{ type: 'namespace', name: 'nested', tools: [] }] }],
    [{ type: 'namespace', name: 'crm', tools: [{ type: 'function', name: LIST }] }],
    [{ type: 'namespace', name: LIST, tools: [{ type: 'function', name: 'f' }] }],
    [
      {
        type: 'namespace',
        name: 'crm',
        tools: [
          { type: 'function', name: 'f' },
          { type: 'custom', name: 'f' },
        ],
      },
    ],
    [
      { type: 'function', name: 'crm' },
      { type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'f' }] },
    ],
    [{ type: 'web_search' }, { type: 'web_search' }],
    [{ type: 'web_search', name: LIST }],
    [{ type: 'computer_use_preview' }],
    [null],
  ]) {
    const f = fixture('responses', { tools });
    const saved = JSON.stringify(f.body);
    assert.equal(f.create().ok, false);
    assert.equal(JSON.stringify(f.body), saved);
    assert.equal(f.executed.length, 0);
  }
});

test('Responses mixed namespace custom calls remain client-owned across immediate and deferred publication', () => {
  for (const deferMixedResults of [false, true]) {
    const tools = [
      { type: 'namespace', name: 'native', tools: [{ type: 'custom', name: 'patch' }] },
    ];
    const f = fixture('responses', { tools });
    const c = f.create({ deferMixedResults });
    assert.equal(c.ok, true);
    const external = {
      type: 'custom_tool_call',
      id: 'ctc-mixed',
      call_id: 'custom-mixed',
      name: 'patch',
      namespace: 'native',
      input: '',
      status: 'completed',
    };
    const input = response('responses', [{ id: 'internal-mixed', name: LIST }]);
    input.output.push(external);
    let release = c.accept(input);
    if (!deferMixedResults) {
      assert.equal(release.mode, 'continue');
      assert.equal(release.request.tools.length, 2);
      assert.ok(release.request.tools.every((tool) => [LIST, READ].includes(tool.name)));
      release = c.accept(response('responses'));
    }
    assert.equal(release.mode, 'release');
    assert.ok(
      release.response.output.some((item) => JSON.stringify(item) === JSON.stringify(external))
    );
    assert.ok(release.response.output.every((item) => ![LIST, READ].includes(item.name)));
    assert.ok(release.history.every((item) => item.type !== 'custom_tool_call'));
    assert.deepEqual(
      f.executed.map((call) => call.name),
      [LIST]
    );
    if (deferMixedResults) {
      assert.equal(release.deferredInput.length, 1);
      assert.equal(release.deferredInput[0].call_id, 'internal-mixed');
    }
  }
});

test('Responses hosted results release intact and malformed hosted mixed turns fail before reading', () => {
  const hosted = {
    id: 'ws-native',
    type: 'web_search_call',
    status: 'completed',
    action: {
      type: 'search',
      queries: ['synthetic query'],
      sources: [{ type: 'url', url: 'https://example.invalid/' }],
    },
    results: [{ type: 'opaque-fixture', value: 'unchanged' }],
  };
  const f = fixture('responses', { tools: [{ type: 'web_search' }] });
  const c = f.create();
  assert.equal(c.ok, true);
  assert.equal(c.accept(response('responses', [{ id: 'private', name: LIST }])).mode, 'continue');
  const release = c.accept({ status: 'completed', output: [hosted] });
  assert.equal(release.mode, 'release');
  assert.deepEqual(plain(release.output), [hosted]);
  for (const extra of [
    { status: 'in_progress' },
    { action: { type: 'unknown' } },
    { action: { type: 'open_page', url: 'file:///private' } },
  ]) {
    const g = fixture('responses', { tools: [{ type: 'web_search' }] });
    const output = response('responses', [{ id: 'mixed', name: LIST }]).output;
    const result = g.create().accept({
      status: 'completed',
      output: [extra ? { ...hosted, ...extra } : hosted, ...output],
    });
    assert.equal(result.mode, 'failed');
    assert.equal(g.executed.length, 0);
  }
  const absent = fixture('responses');
  assert.equal(absent.create().accept({ status: 'completed', output: [hosted] }).mode, 'failed');
});

test('Responses hosted mixed turns preserve output positions and references in immediate and deferred modes', () => {
  const hosted = {
    id: 'search-mixed',
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: 'owned 🙂' },
    results: [{ exact: '中文' }],
  };
  const message = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'owned answer' }],
  };
  const external = {
    type: 'function_call',
    call_id: 'external-mixed',
    name: 'lookup',
    arguments: '{}',
  };
  for (const deferred of [false, true])
    for (const hostedPosition of [0, 1, 2])
      for (const externalKind of [null, 'function', 'custom']) {
        const includeExternal = externalKind !== null;
        const selectedExternal =
          externalKind === 'custom'
            ? {
                type: 'custom_tool_call',
                call_id: 'custom-hosted',
                name: 'patch',
                namespace: 'native',
                input: 'exact patch 🙂',
              }
            : external;
        const f = fixture('responses', {
          tools: [
            { type: 'web_search' },
            { type: 'function', name: 'lookup', parameters: { type: 'object' } },
            { type: 'namespace', name: 'native', tools: [{ type: 'custom', name: 'patch' }] },
          ],
        });
        const c = f.create({ deferMixedResults: deferred });
        const privateCall = response('responses', [
          { id: 'private-hosted', name: LIST },
        ]).output.find((item) => item.type === 'function_call');
        const output = [privateCall, message];
        output.splice(hostedPosition, 0, hosted);
        if (includeExternal) output.splice(1, 0, selectedExternal);
        let release = c.accept({ id: 'mixed-response', status: 'completed', output });
        const next = release;
        if (!deferred) {
          assert.equal(next.mode, 'continue');
          assert.deepEqual(
            plain(next.request.input.slice(1, 1 + output.length - Number(includeExternal))),
            output.filter((item) => item !== selectedExternal)
          );
          release = c.accept(response('responses'));
        }
        assert.equal(release.mode, 'release');
        assert.deepEqual(
          plain(release.output),
          output.filter((item) => item !== privateCall)
        );
        const refs = release.publicOutputReferences;
        assert.equal(refs.length, includeExternal ? 3 : 2);
        for (const ref of refs)
          assert.deepEqual(
            plain(release.history[ref.historyIndex]),
            plain(release.output[ref.outputIndex])
          );
        assert.equal(release.history.filter((item) => item.type === 'web_search_call').length, 1);
        assert.deepEqual(plain(release.history.slice(1, 1 + output.length)), output);
        assert.equal(f.executed.length, 1);
        assert.ok(release.response.output.every((item) => item.name !== LIST));
      }
  const f = fixture('responses', { tools: [{ type: 'web_search' }] });
  const output = response('responses', [{ id: 'opaque-hosted', name: LIST }]).output;
  assert.equal(
    f.create().accept({
      status: 'completed',
      output: [hosted, { type: 'reasoning', encrypted_content: 'opaque' }, ...output],
    }).code,
    'context_recovery_opaque_mixed_turn'
  );
  assert.equal(f.executed.length, 0);
});

test('real Responses hosted mixed recovery retains exact originals and ordered history through full root restore', async () => {
  for (const deferMixedResults of [false, true]) {
    let runtime = createContextRecoverySessions({ now: () => 1000 });
    runtime.configure(true);
    const tools = [
      { type: 'web_search' },
      { type: 'function', name: 'lookup', parameters: { type: 'object' } },
    ];
    const base = {
      principal: 'hosted-owner',
      protocol: 'responses',
      target: 'hosted-target',
      policy: { instructions: null, system: null, tools, toolChoice: null },
      history: [{ role: 'user', content: 'owned' }],
    };
    try {
      const first = runtime.begin(base);
      const external = {
        type: 'function_call',
        call_id: 'original-call',
        name: 'lookup',
        arguments: '{}',
      };
      assert.equal(
        first.complete(
          [external],
          [
            {
              callId: external.call_id,
              toolName: 'lookup',
              arguments: {},
              output: '',
              completed: true,
            },
          ],
          'original-response'
        ).ok,
        true
      );
      const original = 'Exact hosted recovery original 中文🙂';
      const history = [
        ...base.history,
        external,
        { type: 'function_call_output', call_id: external.call_id, output: original },
      ];
      const session = runtime.begin({ ...base, history }, [
        { callId: external.call_id, output: original },
      ]);
      const body = { model: 'fixture', tools, input: history };
      const run = session.recovery(body, { deferMixedResults });
      assert.equal(run.ok, true, run.code);
      const hosted = {
        type: 'web_search_call',
        id: 'owned-search',
        status: 'completed',
        action: { type: 'search', query: 'owned' },
        results: [{ opaque: 'preserved' }],
      };
      const privateCall = {
        type: 'function_call',
        call_id: 'hosted-list',
        name: LIST,
        arguments: '{}',
      };
      const message = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'owned public answer' }],
      };
      let release = run.accept({
        id: 'mixed-response',
        status: 'completed',
        output: [hosted, privateCall, message],
      });
      if (!deferMixedResults) {
        assert.equal(release.mode, 'continue');
        release = run.accept(response('responses'));
      }
      assert.equal(release.mode, 'release');
      assert.equal(session.complete(release.output, [], 'mixed-response').ok, true);
      assert.equal((await session.finishPublicationAsync()).ok, true);
      const state = exportContextRecoveryRoot(runtime, first.snapshotId);
      assert.equal(state.history.format, 3);
      runtime.close();
      runtime = restoreContextRecoverySessions({ now: () => 1001 }, [{ binding: base, state }]);
      const nextHistory = [...history, ...release.output, { role: 'user', content: 'continue' }];
      const next = runtime.begin({ ...base, history: nextHistory });
      assert.equal(next.ok, true, next.code);
      const resumed = next.recovery({ ...body, input: nextHistory });
      assert.equal(resumed.ok, true, resumed.code);
      assert.deepEqual(plain(resumed.initialRequest.input), [
        ...plain(release.history),
        { role: 'user', content: 'continue' },
      ]);
      assert.equal(
        resumed.initialRequest.input.filter((item) => item.type === 'web_search_call').length,
        1
      );
      const source = JSON.parse(next.reply(LIST, {}).text).sources[0];
      assert.equal(
        JSON.parse(next.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text).page
          .text,
        original
      );
      assert.equal(state.expiresAt, exportContextRecoveryRoot(runtime, first.snapshotId).expiresAt);
    } finally {
      runtime.close();
    }
  }
});
function fixture(kind, overrides = {}) {
  let active = true;
  const executed = [];
  const readers = createContextEvidenceTools({
    list: () => ({ ok: true, sources: [], nextAfterSourceId: null }),
    read: () => ({ ok: false, error: 'context_evidence_unavailable' }),
  });
  const session = {
    definitions: readers.definitions,
    inspect: () => ({ active }),
    reply(name, args) {
      executed.push({ name, args });
      return readers.reply(name, args);
    },
  };
  const tool =
    kind === 'chat'
      ? { type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }
      : kind === 'responses'
        ? { type: 'function', name: 'shell', parameters: { type: 'object' } }
        : { name: 'shell', input_schema: { type: 'object' } };
  const body = {
    model: 'fixture',
    stream: false,
    tools: [tool],
    ...(kind === 'responses'
      ? { input: [{ role: 'user', content: 'continue' }] }
      : { messages: [{ role: 'user', content: 'continue' }] }),
    ...overrides,
  };
  return {
    body,
    session,
    executed,
    revoke: () => {
      active = false;
    },
    create: (options = {}) => createContextRecoveryCoordinator({ kind, body, session, ...options }),
  };
}
function response(kind, calls = [], extra = {}) {
  const content = { type: 'text', text: 'preserved text' };
  if (kind === 'chat')
    return {
      id: 'r1',
      choices: [
        {
          index: 0,
          finish_reason: calls.length ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: content.text,
            ...(calls.length
              ? {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments:
                        typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
                    },
                  })),
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      ...extra,
    };
  if (kind === 'responses')
    return {
      id: 'r1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content.text }],
        },
        ...calls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
        })),
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
      ...extra,
    };
  return {
    id: 'r1',
    role: 'assistant',
    stop_reason: calls.length ? 'tool_use' : 'end_turn',
    content: [
      content,
      ...calls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.args ?? {},
      })),
    ],
    usage: { input_tokens: 7, output_tokens: 3 },
    ...extra,
  };
}

test('WS mixed-turn capability preserves the current response ID without another generation', () => {
  for (const kind of ['chat', 'claude']) {
    const f = fixture(kind);
    assert.throws(() => f.create({ deferMixedResults: true }));
  }
  const f = fixture('responses');
  for (const option of [null, 1, 'true'])
    assert.throws(() => f.create({ deferMixedResults: option }));
  const c = f.create({ deferMixedResults: true });
  const original = response('responses', [
    { id: 'private', name: LIST },
    { id: 'external', name: 'shell' },
  ]);
  const before = JSON.stringify(original);
  const release = c.accept(original);
  assert.equal(release.mode, 'release');
  assert.equal(release.response.id, original.id);
  assert.equal(release.rounds, 1);
  assert.equal(release.usage.length, 1);
  assert.equal(release.calls, 1);
  assert.deepEqual(
    release.deferredInput.map((item) => [item.type, item.call_id]),
    [['function_call_output', 'private']]
  );
  assert.equal(JSON.parse(release.deferredInput[0].output).ok, true);
  assert.equal(f.executed.length, 1);
  assert.equal(f.executed[0].name, LIST);
  assert.equal(JSON.stringify(original), before);
  assert.doesNotMatch(JSON.stringify(release.response), /hpm_list_retained_evidence/);
  assert.match(JSON.stringify(release.response), /external/);
  assert.equal(c.accept(original).code, 'context_recovery_terminal');
});

test('revocation while waiting for deferred mixed results cannot release external calls', async () => {
  const f = fixture('responses');
  let release;
  f.session.replyAsync = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const c = f.create({ deferMixedResults: true });
  const pending = c.acceptAsync(
    response('responses', [
      { id: 'private', name: LIST },
      { id: 'external', name: 'shell' },
    ])
  );
  f.revoke();
  release({ ok: true, text: '{}' });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.deferredInput, undefined);
  assert.equal(result.response, undefined);
});

for (const kind of ['chat', 'responses', 'claude']) {
  test(`${kind}: internal-only continuation preserves controls, exact data and accounts every response`, () => {
    const f = fixture(kind, { temperature: 0, stream: true });
    const c = f.create();
    assert.equal(c.initialRequest.stream, true);
    assert.equal(c.initialRequest.temperature, 0);
    assert.equal(c.initialRequest.tools.length, 3);
    const first = response(kind, [{ id: 'list1', name: LIST }]);
    const saved = JSON.stringify(first);
    const next = c.accept(first);
    assert.equal(next.mode, 'continue');
    assert.equal(JSON.stringify(first), saved);
    assert.equal(f.executed.length, 1);
    assert.equal(f.executed[0].name, LIST);
    const history = kind === 'responses' ? next.request.input : next.request.messages;
    assert.match(JSON.stringify(history), /nextAfterSourceId/);
    const final = response(kind);
    const released = c.accept(final);
    assert.equal(released.mode, 'release');
    assert.deepEqual(plain(released.response), final);
    assert.equal(released.usage.length, 2);
    assert.equal(released.rounds, 2);
    assert.equal(c.accept(final).code, 'context_recovery_terminal');
  });

  test(`${kind}: mixed turn defers original external calls and never executes them`, () => {
    const f = fixture(kind);
    const c = f.create();
    const original = response(kind, [
      { id: 'read1', name: LIST },
      { id: 'shell1', name: 'shell', args: { command: 'client-owned' } },
    ]);
    const next = c.accept(original);
    assert.equal(next.mode, 'continue');
    assert.equal(next.request.tools.length, 2);
    assert.doesNotMatch(
      JSON.stringify(kind === 'responses' ? next.request.input : next.request.messages),
      /client-owned/
    );
    const release = c.accept(response(kind));
    assert.equal(release.mode, 'release');
    assert.equal(release.deferredExternal, true);
    assert.match(JSON.stringify(release.response), /client-owned/);
    assert.doesNotMatch(JSON.stringify(release.response), /hpm_list_retained_evidence/);
    assert.equal(f.executed.length, 1);
    assert.equal(f.executed[0].name, LIST);
    assert.equal(release.usage.length, 2);
  });

  test(`${kind}: forbidden controls and reserved names disable injection without changing input`, () => {
    for (const controls of [
      { tool_choice: 'none' },
      { tool_choice: 'required' },
      { response_format: { type: 'json_object' } },
      { text: { format: { type: 'json_schema' } } },
      { n: 2 },
    ]) {
      const f = fixture(kind, controls);
      const saved = JSON.stringify(f.body);
      assert.equal(f.create().ok, false);
      assert.equal(JSON.stringify(f.body), saved);
    }
    const f = fixture(kind);
    if (kind === 'chat') f.body.tools[0].function.name = LIST;
    else f.body.tools[0].name = LIST;
    assert.equal(f.create().code, 'context_recovery_tool_collision');
  });

  test(`${kind}: repeated calls, duplicate IDs and unknown external tools fail before execution`, () => {
    const f = fixture(kind);
    const c = f.create();
    assert.equal(c.accept(response(kind, [{ id: 'a', name: LIST }])).mode, 'continue');
    assert.equal(c.accept(response(kind, [{ id: 'b', name: LIST }])).code, 'context_recovery_loop');
    assert.equal(f.executed.length, 1);
    for (const calls of [
      [
        { id: 'a', name: LIST },
        { id: 'a', name: READ },
      ],
      [{ id: 'a', name: 'unoffered' }],
    ]) {
      const bad = fixture(kind);
      assert.equal(bad.create().accept(response(kind, calls)).mode, 'failed');
      assert.equal(bad.executed.length, 0);
    }
  });

  test(`${kind}: revoked, cancelled and failed readers cannot release external work`, () => {
    const f = fixture(kind);
    const c = f.create();
    f.revoke();
    assert.equal(c.accept(response(kind)).code, 'context_recovery_unavailable');
    const g = fixture(kind);
    const d = g.create();
    assert.equal(d.cancel().code, 'context_recovery_cancelled');
    assert.equal(d.accept(response(kind)).code, 'context_recovery_terminal');
    const h = fixture(kind);
    h.session.reply = () => {
      throw new Error('secret must not escape');
    };
    const failure = h.create().accept(response(kind, [{ id: 'a', name: LIST }]));
    assert.equal(failure.mode, 'failed');
    assert.doesNotMatch(JSON.stringify(failure), /secret/);
  });
}

test('round limit counts original request and prevents dispatching a ninth response', () => {
  const f = fixture('responses');
  const c = f.create();
  for (let i = 0; i < 7; i++)
    assert.equal(
      c.accept(response('responses', [{ id: `a${i}`, name: LIST, args: { limit: i + 1 } }])).mode,
      'continue'
    );
  assert.equal(
    c.accept(response('responses', [{ id: 'last', name: LIST, args: { limit: 8 } }])).code,
    'context_recovery_round_limit'
  );
  assert.equal(f.executed.length, 7);
});

test('opaque mixed turns fail intact; opaque internal-only state remains byte equivalent', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    for (const mixed of [false, true]) {
      const f = fixture(kind);
      const raw = response(kind, [
        { id: 'a', name: LIST },
        ...(mixed ? [{ id: 'b', name: 'shell' }] : []),
      ]);
      if (kind === 'chat') raw.choices[0].message.reasoning_content = 'opaque reasoning';
      else if (kind === 'responses')
        raw.output.unshift({ type: 'reasoning', encrypted_content: 'opaque' });
      else raw.content.unshift({ type: 'thinking', thinking: 'opaque', signature: 'signed' });
      const saved = JSON.stringify(raw);
      const result = f.create().accept(raw);
      assert.equal(result.mode, mixed ? 'failed' : 'continue');
      assert.equal(JSON.stringify(raw), saved);
      if (!mixed) assert.match(JSON.stringify(result.request), /opaque/);
      assert.equal(f.executed.length, mixed ? 0 : 1);
    }
  }
});

test('malformed, extreme, accessor and forged capabilities fail without evaluating getters', () => {
  const f = fixture('chat');
  let touched = false;
  const body = {
    get messages() {
      touched = true;
      return [];
    },
  };
  assert.throws(() => createContextRecoveryCoordinator({ kind: 'chat', body, session: f.session }));
  assert.equal(touched, false);
  assert.throws(() =>
    createContextRecoveryCoordinator({ kind: 'bad', body: {}, session: f.session })
  );
  assert.throws(() =>
    createContextRecoveryCoordinator({ kind: 'chat', body: f.body, session: {} })
  );
  assert.equal(f.create().accept({ choices: [] }).mode, 'failed');
  assert.equal(
    f.create().accept(
      response(
        'chat',
        Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, name: LIST }))
      )
    ).mode,
    'failed'
  );
  assert.equal(
    f.create().accept(response('chat', [{ id: 'a', name: LIST, args: '{broken' }])).mode,
    'failed'
  );
  assert.equal(
    f
      .create()
      .accept(response('chat', [{ id: 'a', name: LIST, args: 'x'.repeat(1024 * 1024 + 1) }])).mode,
    'failed'
  );
});

test('real session paginates exact Unicode into subsequent model requests without an external executor', () => {
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  const base = {
    principal: 'fixture',
    protocol: 'chat',
    target: 'fixture',
    history: [{ role: 'user', content: 'q' }],
  };
  const output = response('chat', [{ id: 'source1', name: 'shell' }]).choices[0].message;
  const source = '原文🙂\n'.repeat(4000);
  const root = runtime.begin(base);
  assert.equal(
    root.complete(
      [output],
      [{ callId: 'source1', toolName: 'shell', arguments: {}, completed: true, output: '' }]
    ).ok,
    true
  );
  const history = [
    ...base.history,
    output,
    { role: 'tool', tool_call_id: 'source1', content: source },
  ];
  const session = runtime.begin({ ...base, history }, [{ callId: 'source1', output: source }]);
  const c = createContextRecoveryCoordinator({
    kind: 'chat',
    body: { messages: history },
    session,
  });
  const index = c.accept(response('chat', [{ id: 'index1', name: LIST }]));
  const receipt = JSON.parse(index.request.messages.at(-1).content).sources[0];
  let offsetBytes = 0;
  let exact = '';
  let count = 0;
  do {
    const read = c.accept(
      response('chat', [
        {
          id: `page${count++}`,
          name: READ,
          args: { sourceId: receipt.sourceId, digest: receipt.digest, offsetBytes },
        },
      ])
    );
    assert.equal(read.mode, 'continue');
    const result = JSON.parse(read.request.messages.at(-1).content);
    assert.equal(result.source.trust, 'tool_data_not_instructions');
    assert.equal(result.observation, 'client_reported');
    exact += result.page.text;
    offsetBytes = result.page.nextOffsetBytes;
  } while (offsetBytes !== null);
  assert.equal(exact, source);
  assert.ok(count > 1);
  const released = c.accept(response('chat'));
  assert.equal(released.mode, 'release');
  assert.equal(released.usage.length, count + 2);
  assert.equal(session.inspect().readers.successfulReads, count);
  runtime.close();
});

test('loop fingerprints ignore object key order and duplicate parallel lookups spend no reader budget', () => {
  const f = fixture('chat');
  const c = f.create();
  assert.equal(
    c.accept(
      response('chat', [
        { id: 'a', name: LIST, args: { limit: 1, afterSourceId: 'hce_' + 'a'.repeat(32) } },
      ])
    ).mode,
    'continue'
  );
  assert.equal(
    c.accept(
      response('chat', [
        { id: 'b', name: LIST, args: { afterSourceId: 'hce_' + 'a'.repeat(32), limit: 1 } },
      ])
    ).code,
    'context_recovery_loop'
  );
  const g = fixture('chat');
  assert.equal(
    g.create().accept(
      response('chat', [
        { id: 'a', name: LIST },
        { id: 'b', name: LIST },
      ])
    ).code,
    'context_recovery_loop'
  );
  assert.equal(g.executed.length, 0);
});

test('64-call cap, history replay IDs, malformed tools and unavailable readers fail safely', () => {
  const f = fixture('chat');
  const c = f.create();
  for (let round = 0; round < 4; round++) {
    const calls = Array.from({ length: 16 }, (_, i) => ({
      id: `call${round * 16 + i}`,
      name: LIST,
      args: { limit: round * 16 + i + 1 },
    }));
    assert.equal(c.accept(response('chat', calls)).mode, 'continue');
  }
  assert.equal(
    c.accept(response('chat', [{ id: 'last', name: LIST, args: { limit: 65 } }])).mode,
    'failed'
  );
  assert.equal(f.executed.length, 64);
  const g = fixture('chat', { messages: [{ role: 'tool', tool_call_id: 'old', content: 'x' }] });
  assert.equal(g.create().accept(response('chat', [{ id: 'old', name: LIST }])).mode, 'failed');
  assert.throws(() => fixture('chat', { tools: {} }).create());
  assert.throws(() => fixture('chat', { messages: null }).create());
  for (const reply of [null, { ok: true }, { ok: true, text: 'x'.repeat(16385) }]) {
    const h = fixture('chat');
    h.session.reply = () => reply;
    assert.equal(h.create().accept(response('chat', [{ id: 'a', name: LIST }])).mode, 'failed');
  }
});

test('mixed recovery rejects fresh external calls in the private acknowledgement phase', () => {
  const f = fixture('responses');
  const c = f.create();
  assert.equal(
    c.accept(
      response('responses', [
        { id: 'i', name: LIST },
        { id: 'e', name: 'shell' },
      ])
    ).mode,
    'continue'
  );
  assert.equal(c.accept(response('responses', [{ id: 'e2', name: 'shell' }])).mode, 'failed');
  assert.equal(f.executed.length, 1);
});

test('checkpoint fingerprints preserve legacy digests including numeric keys and JSON escaping', () => {
  const { createHash } = require('node:crypto');
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item === null || typeof item !== 'object') return item;
    const result = Object.create(null);
    for (const key of Object.keys(item).sort()) result[key] = ordered(item[key]);
    return result;
  }
  const values = [
    null,
    true,
    false,
    0,
    -0,
    1e30,
    '',
    [],
    {},
    ['🙂', '\ud800', '\udfff', '\u0000\r\n"\\', 1e-8],
    JSON.parse('{"10":1,"2":2,"0":3,"01":4,"4294967294":5,"4294967295":6,"-0":7,"__proto__":8}'),
    { z: { b: false, a: null }, a: [1, { 100: 1, 9: 2, a: 3 }] },
  ];
  for (const value of values) {
    const legacy = createHash('sha256')
      .update(JSON.stringify(ordered(value)))
      .digest('hex');
    assert.equal(fingerprintContextData(value), legacy);
    assert.equal(fingerprintRecoveryCheckpoint(value), legacy);
  }
  assert.deepEqual(
    values.map(fingerprintContextData),
    values.map((value) => fingerprintContextData(value))
  );
});

test('checkpoint fingerprint capability retains default request limits and rejects unsafe data', () => {
  const value = { output: 'x'.repeat(3 * 1024 * 1024) };
  assert.throws(() => fingerprintContextData(value));
  assert.match(fingerprintRecoveryCheckpoint(value), /^[a-f0-9]{64}$/);
  let invoked = 0;
  const cycle = {};
  cycle.self = cycle;
  const getter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      invoked++;
      return 'secret';
    },
  });
  const executable = {
    toJSON() {
      invoked++;
      return 'secret';
    },
  };
  for (const input of [
    undefined,
    NaN,
    Infinity,
    1n,
    cycle,
    getter,
    executable,
    Object.create({ output: 'secret' }),
    { output: '\\'.repeat(6 * 1024 * 1024) },
    { output: 'x'.repeat(12 * 1024 * 1024) },
    Array(2),
  ]) {
    assert.throws(() => fingerprintRecoveryCheckpoint(input));
  }
  assert.equal(invoked, 0);
});

test('fingerprints preserve all values and array order while ignoring only object key order', () => {
  assert.equal(
    fingerprintContextData({ b: [1, null, false], a: { z: '🙂', c: 2 } }),
    fingerprintContextData({ a: { c: 2, z: '🙂' }, b: [1, null, false] })
  );
  assert.notEqual(fingerprintContextData([1, 2]), fingerprintContextData([2, 1]));
  assert.notEqual(fingerprintContextData({ a: '1' }), fingerprintContextData({ a: 1 }));
  let touched = false;
  assert.throws(() =>
    fingerprintContextData({
      get a() {
        touched = true;
        return 1;
      },
    })
  );
  assert.equal(touched, false);
});

function encodeWire(kind, value, stream) {
  if (!stream) return Buffer.from(JSON.stringify(value));
  const event = (item) => 'data: ' + JSON.stringify(item) + '\n\n';
  if (kind === 'chat') return Buffer.from(event({ ...value, object: 'chat.completion' }));
  if (kind === 'responses')
    return Buffer.from(event({ type: 'response.completed', response: value }));
  const events = [
    {
      type: 'message_start',
      message: {
        role: 'assistant',
        id: value.id,
        usage: { input_tokens: value.usage.input_tokens },
      },
    },
  ];
  value.content.forEach((block, index) => {
    events.push(
      { type: 'content_block_start', index, content_block: block },
      { type: 'content_block_stop', index }
    );
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: value.stop_reason },
      usage: { output_tokens: value.usage.output_tokens },
    },
    { type: 'message_stop' }
  );
  return Buffer.from(events.map(event).join(''));
}

for (const kind of ['chat', 'responses', 'claude']) {
  for (const stream of [false, true]) {
    test(`${kind}/${stream ? 'SSE' : 'JSON'}: bounded runner hides private phases and dispatches only continuation requests`, async () => {
      const f = fixture(kind, { stream });
      const controller = f.create();
      let dispatches = 0;
      const result = await runContextRecovery({
        kind,
        body: f.body,
        session: { recovery: () => controller },
        dispatch(request, { signal }) {
          assert.equal(signal.aborted, false);
          if (dispatches) assert.match(JSON.stringify(request), /nextAfterSourceId/);
          const value = dispatches++
            ? response(kind)
            : response(kind, [{ id: 'private', name: LIST }]);
          return { statusCode: 200, wire: encodeWire(kind, value, stream), stream };
        },
      });
      assert.equal(result.mode, 'release');
      assert.equal(dispatches, 2);
      assert.doesNotMatch(JSON.stringify(result.response), /hpm_list_retained_evidence/);
      assert.equal(result.usage.length, 2);
      assert.equal(result.usage[0][kind === 'chat' ? 'prompt_tokens' : 'input_tokens'], 7);
      assert.equal(result.usage[1][kind === 'chat' ? 'completion_tokens' : 'output_tokens'], 3);
    });
  }
}

test('runner cancels a non-cooperative dispatch, bounds timeout and never retries failed upstreams', async () => {
  for (const timed of [false, true]) {
    const f = fixture('chat');
    const controller = f.create();
    const signal = new globalThis.AbortController();
    let dispatches = 0;
    let upstreamSignal;
    const result = await runContextRecovery({
      kind: 'chat',
      body: f.body,
      session: { recovery: () => controller },
      signal: signal.signal,
      timeoutMs: timed ? 20 : 1000,
      dispatch(_request, options) {
        dispatches++;
        upstreamSignal = options.signal;
        if (!timed) queueMicrotask(() => signal.abort());
        return new Promise(() => {});
      },
    });
    assert.equal(result.code, timed ? 'context_recovery_timeout' : 'context_recovery_cancelled');
    assert.equal(dispatches, 1);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(controller.accept(response('chat')).code, 'context_recovery_terminal');
  }
  let getters = 0;
  for (const bad of [
    null,
    {},
    { statusCode: 500, wire: Buffer.from('secret'), stream: false },
    { statusCode: 200, wire: Buffer.from('{}'), stream: false, encoding: 'gzip' },
    {
      get statusCode() {
        getters++;
        return 200;
      },
      wire: Buffer.from('{}'),
      stream: false,
    },
  ]) {
    const f = fixture('chat');
    const result = await runContextRecovery({
      kind: 'chat',
      body: f.body,
      session: { recovery: () => f.create() },
      dispatch: () => bad,
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(getters, 0);
});

test('failed continuation retains completed-round usage and strips hostile usage values', async () => {
  const f = fixture('chat');
  let dispatched = 0;
  const result = await runContextRecovery({
    kind: 'chat',
    body: f.body,
    session: { recovery: () => f.create() },
    dispatch() {
      if (dispatched++) throw new Error('private upstream error');
      return {
        statusCode: 200,
        stream: false,
        wire: encodeWire('chat', response('chat', [{ id: 'i', name: LIST }]), false),
      };
    },
  });
  assert.equal(result.code, 'context_recovery_dispatch_failed');
  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0].prompt_tokens, 7);
  assert.doesNotMatch(JSON.stringify(result), /private upstream error/);
  const g = fixture('chat');
  const rejected = g.create().accept(response('chat', [], { usage: { content: 'secret' } }));
  assert.equal(rejected.mode, 'failed');
  assert.doesNotMatch(JSON.stringify(rejected), /secret/);
});

test('runner rejects configuration, pre-dispatch cancellation and elevated response roles', async () => {
  const f = fixture('responses');
  let dispatched = 0;
  const options = {
    kind: 'responses',
    body: f.body,
    session: { recovery: () => f.create() },
    dispatch: () => {
      dispatched++;
    },
  };
  for (const patch of [{ dispatch: null }, { signal: {} }, { timeoutMs: 0 }, { timeoutMs: 60001 }])
    await assert.rejects(
      runContextRecovery({ ...options, ...patch }),
      /Invalid recovery runner capability/
    );
  const signal = new globalThis.AbortController();
  const pending = runContextRecovery({ ...options, signal: signal.signal });
  signal.abort();
  assert.equal((await pending).code, 'context_recovery_cancelled');
  assert.equal(dispatched, 0);
  const elevated = response('responses');
  elevated.output[0].role = 'system';
  assert.equal(f.create().accept(elevated).mode, 'failed');
  const incomplete = response('responses', [{ id: 'i', name: LIST }]);
  incomplete.output[1].status = 'in_progress';
  assert.equal(f.create().accept(incomplete).mode, 'failed');
  const nullable = response('responses', [], {
    usage: { input_tokens: 1, input_tokens_details: null },
  });
  assert.equal(f.create().accept(nullable).mode, 'release');
});
