'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createDeferredGeminiOutput,
  createGeminiOutputRecovery,
  isEmptyGeminiBudgetResponse,
  observeGeminiRecoveryEvent,
} = require('../lib/proxy/handlers/gemini-output-recovery');

function recoveryHarness(overrides = {}) {
  const clientReq = {};
  const clientRes = {};
  const events = [];
  let calls = 0;
  const options = {
    clientReq,
    clientRes,
    prepared: {},
    model: 'gemini-3.8-flash-tiered',
    codeAssist: true,
    requestedTokens: 65536,
    budget: { effectiveTokens: 32768 },
    startTime: 1000,
    now: () => 2000,
    logProxyEvent: (type, data) => events.push({ type, ...data }),
    retry: () => {
      calls++;
    },
    ...overrides,
  };
  return {
    options,
    clientReq,
    clientRes,
    events,
    calls: () => calls,
    recovery: createGeminiOutputRecovery(options),
  };
}

test('zero-output exhaustion recovers only once and logs numeric diagnostics', () => {
  const h = recoveryHarness();
  assert.equal(
    h.recovery.retryEmpty({
      stopReason: 'max_tokens',
      usage: { reasoning_tokens: 32768, content: 'secret' },
    }),
    true
  );
  assert.equal(h.recovery.retryEmpty({ stopReason: 'max_tokens' }), false);
  const second = createGeminiOutputRecovery(h.options);
  assert.equal(second.options.recovery, true);
  assert.equal(second.retryEmpty({ stopReason: 'max_tokens' }), false);
  assert.equal(h.calls(), 1);
  assert.equal(h.events[0].nextMaxOutputTokens, 65536);
  assert.equal(h.events[0].discardedReasoningTokens, 32768);
  assert.equal(JSON.stringify(h.events).includes('secret'), false);
});

test('retry never exceeds client token limits or silently lowers thinking', () => {
  const h = recoveryHarness({ requestedTokens: 16384, budget: { effectiveTokens: 16384 } });
  assert.equal(h.recovery.retryEmpty({ stopReason: 'max_tokens' }), true);
  assert.equal(h.events[0].nextMaxOutputTokens, 16384);
  assert.equal(h.events[0].retainedThinkingLevel, true);
});

test('output, thinking, whitespace, tool calls, completed turns, and committed metadata prevent replay', () => {
  for (const key of [
    'hasVisibleText',
    'hasThinkingOutput',
    'hasToolUse',
    'textOpen',
    'thinkingOpen',
    'pendingToolCall',
  ]) {
    const h = recoveryHarness();
    assert.equal(
      h.recovery.retryEmpty({ stopReason: 'max_tokens', state: { [key]: true } }),
      false
    );
    assert.equal(h.calls(), 0);
  }
  assert.equal(recoveryHarness().recovery.retryEmpty({ stopReason: 'end_turn' }), false);
  assert.equal(
    recoveryHarness().recovery.retryEmpty({ stopReason: 'max_tokens', committed: true }),
    false
  );
});

test('invalid capabilities, small budgets, cancellation, closed clients, and deadlines prevent retry', () => {
  for (const overrides of [
    { model: 'gemini-4-flash' },
    { codeAssist: false },
    { budget: null },
    { budget: { effectiveTokens: 256 } },
    { now: () => 170001 },
    { clientReq: { aborted: true } },
    { clientRes: { destroyed: true } },
    { clientRes: { headersSent: true } },
    { clientRes: { writableEnded: true } },
  ]) {
    assert.equal(
      recoveryHarness(overrides).recovery.retryEmpty({ stopReason: 'max_tokens' }),
      false
    );
  }
});

test('raw JSON responses must be an unambiguous empty MAX_TOKENS candidate', () => {
  assert.equal(
    isEmptyGeminiBudgetResponse({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
    }),
    true
  );
  assert.equal(isEmptyGeminiBudgetResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), true);
  for (const payload of [
    null,
    [],
    {},
    { candidates: [] },
    { candidates: [null] },
    { candidates: [{ finishReason: 'STOP' }] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: null }] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: 'bad' } }] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ functionCall: {} }] } }] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: ' ' }] } }] },
    { candidates: [{ finishReason: 'MAX_TOKENS' }, { finishReason: 'MAX_TOKENS' }] },
  ]) {
    assert.equal(isEmptyGeminiBudgetResponse(payload), false);
  }
});

test('deferred metadata is discarded on recovery and flushed in order on first content', () => {
  const writes = [];
  const res = { writeHead: () => writes.push('headers'), write: (s) => writes.push(s) };
  const gate = createDeferredGeminiOutput(res, {});
  gate.sink.write('created');
  assert.deepEqual(writes, []);
  gate.discard();
  gate.sink.write('created2');
  gate.sink.write('delta');
  gate.commitIfOutput({ textOpen: true });
  gate.sink.write('tail');
  gate.commit();
  assert.deepEqual(writes, ['headers', 'created2', 'delta', 'tail']);
  assert.equal(gate.isCommitted(), true);
});

test('metadata buffering is bounded and closed clients are never written to', () => {
  const writes = [];
  const res = { writeHead: () => writes.push('headers'), write: (s) => writes.push(s) };
  const gate = createDeferredGeminiOutput(res, {});
  gate.sink.write('x'.repeat(65536));
  gate.sink.write('overflow');
  assert.equal(gate.isCommitted(), true);
  assert.equal(writes.length, 3);
  res.destroyed = true;
  assert.equal(gate.sink.write('closed'), false);
  const closed = createDeferredGeminiOutput(res, {});
  closed.commit();
  assert.equal(writes.length, 3);
});

test('malformed and error events are never eligible for recovery', () => {
  for (const data of [
    '{invalid',
    'null',
    '[]',
    '{}',
    '{"error":{"message":"private"}}',
    '{"promptFeedback":{"blockReason":"SAFETY"}}',
    '{"candidates":"bad"}',
    '{"candidates":[{"content":[]}]}',
  ]) {
    const state = {};
    observeGeminiRecoveryEvent('data: ' + data, state);
    assert.equal(state.outputRecoveryUnsafe, true);
  }
  const safe = {};
  observeGeminiRecoveryEvent(
    'data: {"usageMetadata":{"thoughtsTokenCount":8192}}\n\ndata: [DONE]',
    safe
  );
  assert.equal(safe.outputRecoveryUnsafe, undefined);
  assert.equal(
    isEmptyGeminiBudgetResponse({ error: {}, candidates: [{ finishReason: 'MAX_TOKENS' }] }),
    false
  );
});
