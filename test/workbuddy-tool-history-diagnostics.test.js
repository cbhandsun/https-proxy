'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeWorkBuddyToolHistory: normalize,
  workBuddyToolHistoryError,
} = require('../lib/proxy/workbuddy-tool-history');
const {
  sanitizeToolHistoryDiagnostics: sanitize,
  inspectWorkBuddyToolHistoryConversion: inspect,
} = require('../lib/proxy/workbuddy-tool-history-diagnostics');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');

const call = (id = 'SECRET_CALL') => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'SECRET_NAME', arguments: '{}' } }],
});
const result = (id = 'SECRET_CALL') => ({
  role: 'tool',
  tool_call_id: id,
  content: 'SECRET_OUTPUT',
});
function rejected(messages, options) {
  let failure;
  assert.throws(
    () => normalize(messages, options),
    (error) => {
      failure = workBuddyToolHistoryError(error);
      return failure !== null;
    }
  );
  assert.ok(!JSON.stringify(failure).includes('SECRET'));
  return failure;
}

test('unseen result diagnostics contain only bounded indices and a fixed relationship', () => {
  const failure = rejected([result()]);
  assert.equal(failure.reason, 'orphan_result');
  assert.deepEqual(failure.diagnostics, {
    messageIndex: 0,
    messageCount: 1,
    callsSeen: 0,
    activeCalls: 0,
    orphanRelation: 'no_prior_call',
  });
  assert.equal(failure.payload.error.diagnostics, undefined, 'diagnostics remain server-side');
});

test('late results identify the boundary of their own call, not a later unrelated boundary', () => {
  for (const role of ['user', 'system', 'developer']) {
    const messages = [
      call(),
      result(),
      { role, content: 'SECRET_POLICY' },
      call('other'),
      result(),
    ];
    const failure = rejected(messages);
    assert.equal(failure.reason, 'orphan_result');
    assert.deepEqual(failure.diagnostics, {
      messageIndex: 4,
      messageCount: 5,
      callsSeen: 2,
      activeCalls: 1,
      callMessageIndex: 0,
      boundaryMessageIndex: 2,
      resultsSeenForCall: 1,
      boundaryType: role,
      orphanRelation: 'closed_call_batch',
    });
  }
});

test('new calls, empty batches and strict narration closures have distinct fixed labels', () => {
  for (const [boundary, expected, options] of [
    [call('next'), 'new_call_batch', undefined],
    [{ role: 'assistant', content: null, tool_calls: [] }, 'empty_call_batch', undefined],
    [{ role: 'assistant', content: 'SECRET_PROGRESS' }, 'assistant', { repair: false }],
  ]) {
    const failure = rejected([call(), result(), boundary, result()], options || { repair: false });
    assert.equal(failure.diagnostics.boundaryType, expected);
    assert.equal(failure.diagnostics.orphanRelation, 'closed_call_batch');
    assert.equal(failure.diagnostics.boundaryMessageIndex, 2);
  }
});

test('missing results identify the original call and the actual closing boundary', () => {
  for (const [messages, boundary, index] of [
    [[call()], 'end_of_history', 1],
    [[call(), { role: 'user', content: 'SECRET_NEXT' }], 'user', 1],
    [[call(), call('other')], 'new_call_batch', 1],
    [[call(), { role: 'assistant', tool_calls: [], content: null }], 'empty_call_batch', 1],
  ]) {
    const failure = rejected(messages);
    assert.equal(failure.reason, 'missing_result');
    assert.equal(failure.diagnostics.callMessageIndex, 0);
    assert.equal(failure.diagnostics.messageIndex, index);
    assert.equal(failure.diagnostics.boundaryType, boundary);
    assert.equal(failure.diagnostics.resultsSeenForCall, 0);
  }
});

test('sanitization ignores arbitrary fields, invalid values, inherited values and getters', () => {
  let invoked = false;
  const hostile = Object.defineProperty(
    { token: 'SECRET', messageIndex: -1, messageCount: Infinity, callsSeen: 'SECRET' },
    'activeCalls',
    {
      get() {
        invoked = true;
        return 1;
      },
    }
  );
  assert.deepEqual(sanitize(hostile), {});
  assert.equal(invoked, false);
  for (const value of [
    null,
    undefined,
    42,
    'SECRET',
    new Date(),
    Object.create({ messageIndex: 1 }),
  ])
    assert.deepEqual(sanitize(value), {});
  assert.deepEqual(
    sanitize({ boundaryType: 'SECRET', orphanRelation: 'SECRET', activeCalls: 1048577 }),
    {}
  );
  assert.deepEqual(sanitize({ messageCount: 16384, callsSeen: 1048576, activeCalls: 64 }), {
    messageCount: 16384,
    callsSeen: 1048576,
    activeCalls: 64,
  });
  const error = new TypeError('SECRET');
  error.code = 'invalid_workbuddy_tool_history';
  error.reason = 'orphan_result';
  Object.defineProperty(error, 'diagnostics', {
    get() {
      invoked = true;
      return hostile;
    },
  });
  assert.deepEqual(workBuddyToolHistoryError(error).diagnostics, {});
  assert.equal(invoked, false);
});

test('source diagnostics distinguish absent calls, dropped nested calls and unnamed call items', () => {
  const protocol = createOpenAIProtocol({
    fallbackId: (prefix) => `${prefix}_fixture`,
    cleanToolArgs: (_name, args) => args,
    stableCreated: () => 1,
  });
  const output = {
    type: 'custom_tool_call_output',
    call_id: 'SECRET_CALL',
    output: 'SECRET_OUTPUT',
  };
  for (const [input, expected] of [
    [[output], [0, 0, 0]],
    [
      [call(), output],
      [0, 1, 0],
    ],
    [
      [{ type: 'custom_tool_call', call_id: 'SECRET_CALL', input: 'SECRET_INPUT' }, output],
      [1, 0, 1],
    ],
  ]) {
    const before = JSON.stringify(input);
    const messages = protocol.openAIResponsesToChat({ input, model: 'fixture' }).messages;
    const failure = rejected(messages);
    const diagnostics = inspect(input, messages, failure.diagnostics);
    assert.equal(diagnostics.sourceMatchingCallCount, expected[0]);
    assert.equal(diagnostics.sourceMatchingNestedCallCount, expected[1]);
    assert.equal(diagnostics.sourceMatchingUnnamedCallCount, expected[2]);
    assert.equal(diagnostics.sourceMatchingResultCount, 1);
    assert.equal(diagnostics.convertedMatchingCallCount, 0);
    assert.equal(diagnostics.sourceScanComplete, true);
    assert.equal(diagnostics.convertedScanComplete, true);
    assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
    assert.equal(JSON.stringify(input), before);
  }
});

test('source and converted counters preserve fixed call-type distinctions and ID fallback', () => {
  const input = [
    { type: 'function_call', id: 'SECRET_CALL', name: 'SECRET_NAME' },
    { type: 'custom_tool_call', call_id: 'SECRET_CALL', name: 'SECRET_NAME' },
    { type: 'tool_call', call_id: 'other' },
    { type: 'call', call_id: 'other' },
    { type: 'function_call_output', id: 'SECRET_CALL' },
    { type: 'custom_tool_call_output', call_id: 'SECRET_CALL' },
    { type: 'tool_result', call_id: 'other' },
    { type: 'reasoning', content: 'SECRET_REASONING' },
  ];
  const diagnostics = inspect(input, [call(), result()], { messageIndex: 1 });
  assert.equal(diagnostics.sourceCallItemCount, 4);
  assert.equal(diagnostics.sourceResultItemCount, 3);
  assert.equal(diagnostics.sourceMatchingCallCount, 2);
  assert.equal(diagnostics.sourceMatchingResultCount, 2);
  assert.equal(diagnostics.sourceMatchingCallFirstIndex, 0);
  assert.equal(diagnostics.convertedCallCount, 1);
  assert.equal(diagnostics.convertedResultCount, 1);
  assert.equal(diagnostics.convertedMatchingCallCount, 1);
  assert.equal(diagnostics.convertedMatchingCallFirstIndex, 0);
  assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
});

test('a call occurring after the result is not reported as a prior call', () => {
  const messages = [result(), call()];
  const failure = rejected(messages);
  assert.equal(failure.diagnostics.orphanRelation, 'no_prior_call');
  const diagnostics = inspect([], messages, failure.diagnostics);
  assert.equal(diagnostics.convertedMatchingCallCount, 1);
  assert.equal(diagnostics.convertedMatchingCallFirstIndex, 1);
});

test('empty, scalar and unavailable structures never produce identifiers or false matches', () => {
  for (const input of [[], '', null, undefined, 42, {}, Array(16385)]) {
    const diagnostics = inspect(input, [], {});
    assert.equal(diagnostics.sourceMatchingCallCount, 0);
    assert.equal(diagnostics.convertedMatchingCallCount, 0);
    assert.equal(diagnostics.convertedScanComplete, true);
  }
  for (const messages of [null, {}, Array(16385)]) {
    assert.equal(inspect([], messages, { messageIndex: 0 }).convertedScanComplete, false);
  }
  for (const id of ['', ' ', 'SECRET\n', 'x'.repeat(4097), 42, null]) {
    const diagnostics = inspect([{ type: 'function_call', call_id: id }], [result(id)], {
      messageIndex: 0,
    });
    assert.equal(diagnostics.sourceMatchingCallCount, 0);
  }
});

test('source inspection never invokes getters, toJSON hooks or walks content', () => {
  let invoked = false;
  const hostile = Object.defineProperty({ type: 'function_call', token: 'SECRET' }, 'call_id', {
    get() {
      invoked = true;
      return 'SECRET_CALL';
    },
  });
  const cycle = {
    toJSON() {
      invoked = true;
      return 'SECRET';
    },
  };
  cycle.content = cycle;
  const input = [hostile, { role: 'assistant', tool_calls: [hostile], content: cycle }];
  const sparse = Array(1);
  Object.defineProperty(sparse, '0', {
    get() {
      invoked = true;
      return call();
    },
  });
  for (const source of [input, sparse, [new Date()], [null]]) {
    const diagnostics = inspect(source, [result()], { messageIndex: 0 });
    assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
  }
  assert.equal(inspect(sparse, [], {}).sourceScanComplete, false);
  assert.equal(invoked, false);
});

test('invalid nested-call lists are marked incomplete and not traversed', () => {
  for (const calls of [{}, Array(65), Object.assign([], { extra: 'SECRET' })]) {
    const diagnostics = inspect([{ role: 'assistant', tool_calls: calls }], [], {});
    if (!Array.isArray(calls) || calls.length > 64)
      assert.equal(diagnostics.sourceScanComplete, false);
    assert.equal(diagnostics.sourceMatchingNestedCallCount, 0);
  }
  const sparseCalls = Array(1);
  assert.equal(
    inspect([], [{ role: 'assistant', tool_calls: sparseCalls }], {}).convertedScanComplete,
    false
  );
});

test('maximum message counts and pathological nested calls have a shared bounded scan budget', () => {
  const input = Array.from({ length: 16384 }, () => ({
    role: 'assistant',
    tool_calls: Array(64).fill({ id: 'SECRET_CALL' }),
  }));
  const diagnostics = inspect(input, [result()], { messageIndex: 0 });
  assert.equal(diagnostics.sourceItemCount, 16384);
  assert.equal(diagnostics.sourceScanComplete, false);
  assert.equal(diagnostics.convertedScanComplete, false);
  assert.ok(diagnostics.sourceNestedCallCount < 262144);
  assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
});
