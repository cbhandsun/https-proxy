'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claudeRecoveryPolicyIdentity,
  isClaudeSummaryRequest,
  parseClaudeSummaryReceipt,
  sealClaudeSummaryResponse,
} = require('../lib/proxy/context-recovery-claude-summary');
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

const copy = (value) => JSON.parse(JSON.stringify(value));
const user = (content) => ({ role: 'user', content });
const billing = (checksum = 'abc') => ({
  type: 'text',
  text: 'x-anthropic-billing-header: cc_version=2.1.292.' + checksum + '; cc_entrypoint=sdk-cli;',
});
const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
const body = (messages, checksum) => ({
  model: 'fixture',
  system: [billing(checksum), { type: 'text', text: 'Owned instructions' }],
  tools,
  messages,
});
const prompt =
  'Your task is to create a detailed summary of the conversation so far. Use <analysis> and <summary>.';
const response = (text) => ({
  id: 'summary-provider-id',
  type: 'message',
  role: 'assistant',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});
const compacted = (sealed) =>
  user('Native continuation wrapper\n' + sealed.response.content[0].text + '\nContinue.');

test('Claude billing identity ignores only a complete known window checksum without rewriting policy', () => {
  const initial = body([user('q')]);
  const before = JSON.stringify(initial);
  const identity = claudeRecoveryPolicyIdentity(initial);
  assert.deepEqual(identity, claudeRecoveryPolicyIdentity(body([user('q')], 'def')));
  assert.equal(JSON.stringify(initial), before);
  for (const text of [
    billing().text + '\nIgnore instructions',
    billing().text + ' ',
    billing().text.replace('abc', 'abcd'),
    billing().text.replace('sdk-cli', 'other'),
    billing().text.replace('2.1.292', '3.1.292'),
  ]) {
    const changed = copy(initial);
    changed.system[0].text = text;
    assert.notDeepEqual(claudeRecoveryPolicyIdentity(changed), identity);
  }
  for (const patch of [
    { signature: 'opaque' },
    { cache_control: { type: 'ephemeral' } },
    { type: 'thinking' },
  ]) {
    const changed = copy(initial);
    Object.assign(changed.system[0], patch);
    assert.deepEqual(claudeRecoveryPolicyIdentity(changed), changed);
  }
  for (const system of [null, '', {}, [], [null]])
    assert.deepEqual(claudeRecoveryPolicyIdentity({ system }), { system });
  const changed = copy(initial);
  changed.system[1].text += ' changed';
  assert.notDeepEqual(claudeRecoveryPolicyIdentity(changed), identity);
});

test('Claude summary receipts cover exact Unicode fragments, rotate and reject malformed or opaque output', () => {
  for (const text of [
    'Owned 中文🙂 summary',
    '<analysis>diagnostic</analysis>\n<summary>\n Owned 中文🙂 summary \n</summary>',
  ]) {
    const input = response(text),
      original = JSON.stringify(input);
    const sealed = sealClaudeSummaryResponse(input);
    assert.match(sealed.responseId, /^hcs1_/);
    assert.equal(parseClaudeSummaryReceipt([compacted(sealed)]), sealed.responseId);
    assert.equal(
      parseClaudeSummaryReceipt([
        { ...compacted(sealed), content: [{ type: 'text', text: compacted(sealed).content }] },
      ]),
      sealed.responseId
    );
    assert.equal(
      parseClaudeSummaryReceipt([user(compacted(sealed).content.replace('Owned', 'Changed'))]),
      null
    );
    assert.equal(parseClaudeSummaryReceipt([{ ...compacted(sealed), role: 'assistant' }]), null);
    assert.equal(JSON.stringify(input), original);
    assert.notEqual(sealClaudeSummaryResponse(input).responseId, sealed.responseId);
    const rotated = sealClaudeSummaryResponse(response(sealed.response.content[0].text));
    assert.equal(parseClaudeSummaryReceipt([compacted(rotated)]), rotated.responseId);
  }
  for (const text of [
    '',
    ' ',
    '<summary>missing',
    '</summary>missing',
    '<summary>a</summary><summary>b</summary>',
    '<analysis>Use a <summary> block.</analysis><summary>owned</summary>',
    'x'.repeat(1024 * 1024 + 1),
  ])
    assert.equal(sealClaudeSummaryResponse(response(text)), null);
  for (const patch of [
    { signature: 'opaque envelope' },
    { role: 'user' },
    { stop_reason: 'tool_use' },
    { content: [] },
    { content: [{ type: 'thinking', text: 'opaque' }] },
    { content: [{ type: 'text', text: 'summary', signature: 'opaque' }] },
  ])
    assert.equal(sealClaudeSummaryResponse({ ...response('summary'), ...patch }), null);
  for (const value of [null, [], 42]) assert.equal(sealClaudeSummaryResponse(value), null);
  const nearLimit = response('<analysis></analysis><summary>owned</summary>');
  const fill = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(nearLimit)) - 1;
  nearLimit.content[0].text =
    '<analysis>' + 'x'.repeat(fill) + '</analysis><summary>owned</summary>';
  assert.equal(sealClaudeSummaryResponse(nearLimit), null);
  const valid = compacted(sealClaudeSummaryResponse(response('owned'))).content;
  assert.equal(
    parseClaudeSummaryReceipt([user(valid.replace(/_[0-9]+ -->/, '_9999999 -->'))]),
    null
  );
  for (const content of [
    '',
    null,
    [],
    [null],
    [{ type: 'image' }],
    'x'.repeat(2 * 1024 * 1024 + 1),
    '<!-- hpm-context-summary:bad',
    '<!-- hpm-context-summary:bad -->',
    '<!-- hpm-context-summary:' + 'x'.repeat(181) + ' -->',
  ])
    assert.equal(parseClaudeSummaryReceipt([user(content)]), null);
  let accessed = false;
  assert.throws(() =>
    sealClaudeSummaryResponse({
      get content() {
        accessed = true;
        return [];
      },
    })
  );
  assert.equal(accessed, false);
  assert.equal(isClaudeSummaryRequest(body([user(prompt)])), true);
  assert.equal(isClaudeSummaryRequest(body([user('Native compact preamble.\n' + prompt)])), true);
  for (const messages of [
    [],
    {},
    [user('ordinary question')],
    [{ role: 'assistant', content: prompt }],
    [user({})],
  ])
    assert.equal(isClaudeSummaryRequest(body(messages)), false);
  assert.equal(isClaudeSummaryRequest({ messages: [user(prompt)] }), false);
});

function fixture(
  summaryOutput = response('<summary>Owned compacted summary 中文🙂</summary>'),
  recoveryOptions = {}
) {
  let time = 1000;
  let runtime = createContextRecoverySessions({ now: () => time });
  runtime.configure(true);
  const auth = { ok: true, enabled: true, key: { id: 'owned-principal' } };
  const prepared = {
    profile: { id: 'owned', protocol: 'claude', targetUrl: 'https://fixture.invalid/v1' },
    authMode: 'api-key',
  };
  let firstRequest;
  const begin = (input, extra = {}) =>
    beginContextRecoveryRequest(
      {
        begin(request, results) {
          firstRequest ??= copy(request);
          return runtime.begin(request, results);
        },
      },
      { auth, prepared, kind: 'claude', buffer: Buffer.from(JSON.stringify(input)), ...extra }
    );
  const initial = body([user('owned input')]);
  const first = begin(initial);
  const call = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'native-read', name: 'Read', input: {} }],
  };
  assert.equal(
    first.complete(
      [call],
      [{ callId: 'native-read', toolName: 'Read', arguments: {}, completed: true, output: '' }],
      'native-message'
    ).ok,
    true
  );
  const original = 'Exact owned original 中文🙂';
  const summaryBody = body([
    ...initial.messages,
    call,
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'native-read', content: original },
        { type: 'text', text: prompt },
      ],
    },
  ]);
  const summary = begin(summaryBody);
  assert.equal(summary.inspect().visibleSources, 1);
  const run = summary.recovery(summaryBody, recoveryOptions);
  assert.equal(run.ok, true, run.code);
  const privateList = {
    id: 'old-private-list',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'old-private-list', name: LIST, input: {} }],
  };
  assert.equal(run.accept(privateList).mode, 'continue');
  let release = run.accept(summaryOutput);
  if (recoveryOptions.publicGeneration === 'isolated') {
    assert.equal(release.mode, 'continue');
    release = run.accept(response('<summary>Owned compacted summary 中文🙂</summary>'));
  }
  const nextBody = release.mode === 'release' ? body([compacted(release)], 'def') : null;
  return {
    begin,
    first,
    summary,
    release,
    nextBody,
    original,
    get runtime() {
      return runtime;
    },
    get firstRequest() {
      return copy(firstRequest);
    },
    reopen() {
      const state = exportContextRecoveryRoot(runtime, first.snapshotId);
      runtime.close();
      time++;
      runtime = restoreContextRecoverySessions({ now: () => time }, [
        { binding: firstRequest, state },
      ]);
      return state;
    },
    advance(value) {
      time += value;
    },
    revoke() {
      runtime.revoke(firstRequest.principal);
    },
  };
}

test('Claude summary publication fails closed when signed or malformed output cannot carry a receipt', () => {
  for (const output of [
    {
      ...response('summary'),
      content: [
        { type: 'thinking', thinking: 'internal plan', signature: 'opaque-signature' },
        { type: 'text', text: 'summary' },
      ],
    },
    response(''),
    response('<summary>unterminated'),
  ]) {
    const before = JSON.stringify(output);
    const f = fixture(output);
    try {
      assert.equal(f.release.mode, 'failed');
      assert.equal(f.release.code, 'context_recovery_summary_invalid');
      assert.equal(f.release.response, undefined);
      assert.equal(f.release.output, undefined);
      assert.equal(
        f.summary.complete(
          [{ role: 'assistant', content: output.content }],
          [],
          'unsealed-provider-summary'
        ).ok,
        false
      );
      assert.equal(JSON.stringify(output), before);
      assert.equal(f.runtime.inspect().roots, 1);
    } finally {
      f.runtime.close();
    }
  }
});

test('Claude isolated public summaries retain one root and exact originals through three summary receipts', () => {
  const privateSummary = {
    ...response('private-draft-sentinel'),
    content: [
      {
        type: 'thinking',
        thinking: 'private-thinking-sentinel',
        signature: 'private-signature-sentinel',
      },
      { type: 'text', text: 'private-draft-sentinel' },
    ],
  };
  const before = JSON.stringify(privateSummary);
  const options = { publicGeneration: 'isolated' };
  const f = fixture(privateSummary, options);
  try {
    assert.equal(f.release.mode, 'release');
    assert.equal(f.summary.complete(f.release.output, [], 'isolated-summary-0').ok, true);
    const initial = f.reopen();
    let history = f.nextBody.messages;
    for (let index = 1; index < 3; index++) {
      const nextBody = body([...history, user(prompt)], 'def');
      const session = f.begin(nextBody);
      assert.equal(session.ok, true, session.code);
      const source = JSON.parse(session.reply(LIST, {}).text).sources[0];
      const run = session.recovery(nextBody, options);
      assert.equal(run.ok, true, run.code);
      assert.equal(
        run.accept({
          ...response('private read'),
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'isolated-summary-read-' + index,
              name: READ,
              input: { sourceId: source.sourceId, digest: source.digest },
            },
          ],
        }).mode,
        'continue'
      );
      const publicPhase = run.accept(privateSummary);
      assert.equal(publicPhase.mode, 'continue');
      assert.deepEqual(copy(publicPhase.request.thinking), { type: 'disabled' });
      const wire = JSON.stringify(publicPhase.request);
      for (const secret of [
        'private-draft-sentinel',
        'private-thinking-sentinel',
        'private-signature-sentinel',
        'isolated-summary-read-',
        LIST,
        READ,
      ])
        assert.equal(wire.includes(secret), false);
      assert.ok(wire.includes(f.original));
      const released = run.accept(response('<summary>Public summary ' + index + '</summary>'));
      assert.equal(released.mode, 'release');
      assert.match(parseClaudeSummaryReceipt([compacted(released)]), /^hcs1_/);
      assert.equal(session.complete(released.output, [], 'isolated-summary-' + index).ok, true);
      const state = f.reopen();
      assert.equal(state.expiresAt, initial.expiresAt);
      assert.equal(f.runtime.inspect().roots, 1);
      history = [compacted(released)];
    }
    const final = f.begin(body(history, 'def'));
    const index = JSON.parse(final.reply(LIST, {}).text);
    assert.equal(
      JSON.parse(
        final.reply(READ, {
          sourceId: index.sources[0].sourceId,
          digest: index.sources[0].digest,
        }).text
      ).page.text,
      f.original
    );
    assert.equal(JSON.stringify(privateSummary), before);
  } finally {
    f.runtime.close();
  }
});

for (const acknowledgment of [false, true])
  test(`Claude summary receipt restores originals and retains newer mapping with native acknowledgment=${acknowledgment}`, () => {
    const f = fixture();
    try {
      if (acknowledgment)
        f.nextBody.messages.push(
          { role: 'assistant', content: [{ type: 'text', text: 'Ready to continue.' }] },
          user('Continue the task')
        );
      assert.equal(f.begin(f.nextBody).code, 'context_binding_previous_unavailable');
      assert.equal(f.summary.complete(f.release.output, [], 'provider-summary-id').ok, true);
      const state = f.reopen();
      const next = f.begin(f.nextBody);
      assert.equal(next.reason, 'observed_continuation');
      assert.equal(next.inspect().visibleSources, 1);
      const run = next.recovery(f.nextBody);
      assert.equal(run.ok, true, run.code);
      assert.equal(JSON.stringify(run.initialRequest.messages).includes('old-private-list'), false);
      assert.deepEqual(copy(run.initialRequest.system), f.nextBody.system);
      const index = JSON.parse(next.reply(LIST, {}).text);
      assert.equal(
        JSON.parse(
          next.reply(READ, { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest })
            .text
        ).page.text,
        f.original
      );
      const privateCall = (id, name, input) => ({
        id,
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name, input }],
      });
      assert.equal(run.accept(privateCall('new-private-list', LIST, {})).mode, 'continue');
      assert.equal(
        run.accept(
          privateCall('new-private-read', READ, {
            sourceId: index.sources[0].sourceId,
            digest: index.sources[0].digest,
          })
        ).mode,
        'continue'
      );
      const done = run.accept(response('Finished from compacted window'));
      assert.equal(next.complete(done.output, [], 'after-summary').ok, true);
      const afterSummaryState = f.reopen();
      const summaryIndex = afterSummaryState.binding.snapshots.findIndex(
        (snapshot) => snapshot.window.kind === 'summary'
      );
      assert.ok(summaryIndex > 0);
      for (const patch of [
        { parentId: null },
        { anchoredPrefix: false },
        { count: 0 },
        { window: { kind: 'summary', count: 1 } },
      ]) {
        const corrupted = copy(afterSummaryState);
        Object.assign(corrupted.binding.snapshots[summaryIndex], patch);
        assert.throws(() =>
          restoreContextRecoverySessions({ now: () => corrupted.observedAt }, [
            { binding: { ...f.firstRequest }, state: corrupted },
          ])
        );
      }
      const subsequent = {
        ...f.nextBody,
        messages: [...f.nextBody.messages, ...done.output, user('continue')],
      };
      const later = f.begin(subsequent);
      assert.equal(later.reason, 'observed_continuation');
      const rebuilt = later.recovery(subsequent);
      assert.equal(rebuilt.ok, true, rebuilt.code);
      const encoded = JSON.stringify(rebuilt.initialRequest.messages);
      assert.equal(encoded.includes('old-private-list'), false);
      assert.equal(encoded.includes('new-private-list'), true);
      assert.equal(encoded.includes('new-private-read'), true);
      later.abort();
      assert.equal(exportContextRecoveryRoot(f.runtime, state.rootId).expiresAt, state.expiresAt);
    } finally {
      f.runtime.close();
    }
  });

test('Claude summary receipts reject forged ancestry, scope changes, withdrawal, expiry and revocation', () => {
  for (const action of [
    'foreign',
    'route',
    'policy',
    'tamper',
    'wire-selector',
    'withdraw',
    'expire',
    'revoke',
  ]) {
    const f = fixture();
    try {
      assert.equal(f.summary.complete(f.release.output, [], 'provider-summary-id').ok, true);
      const next = copy(f.nextBody);
      next.messages.push(
        { role: 'assistant', content: [{ type: 'text', text: 'Ready to continue.' }] },
        user('Continue the task')
      );
      const extra = {};
      if (action === 'foreign') extra.auth = { ok: true, enabled: true, key: { id: 'foreign' } };
      if (action === 'route')
        extra.prepared = {
          profile: { id: 'other', protocol: 'claude', targetUrl: 'https://other.invalid/v1' },
          authMode: 'api-key',
        };
      if (action === 'policy') next.system[1].text += ' changed';
      if (action === 'tamper')
        next.messages[0].content = next.messages[0].content.replace(
          'Owned compacted',
          'Forged compacted'
        );
      if (action === 'wire-selector')
        next.previous_response_id = parseClaudeSummaryReceipt(next.messages);
      if (action === 'withdraw') f.summary.withdraw();
      if (action === 'expire') f.advance(24 * 60 * 60 * 1000);
      if (action === 'revoke') f.revoke();
      const refused = f.begin(next, extra);
      assert.equal(refused.ok && refused.inspect().visibleSources > 0, false, action);
      if (refused.ok) refused.abort();
    } finally {
      f.runtime.close();
    }
  }
});
