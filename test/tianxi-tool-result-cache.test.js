'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createTianxiToolResultCache,
  REFERENCE_PATTERN,
} = require('../lib/proxy/tianxi-tool-result-cache');
const {
  createTianxiResultCall,
  parseTianxiResultContinuation,
} = require('../lib/proxy/tianxi-tool-result-continuation');

function answer(status = 'completed', text = 'OK') {
  return {
    status,
    output: [
      {
        id: 'msg_fixture',
        type: 'message',
        status: status === 'completed' ? 'completed' : 'incomplete',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
  };
}

test('serial cache validates bindings, issued references, retries, terminal failures and bounded queues', () => {
  for (const serialResultTool of [null, {}, [], 42, 'secret', { name: 'Bash' }]) {
    if (serialResultTool === null) continue;
    assert.equal(createTianxiToolResultCache().begin('owner', { serialResultTool }), null);
  }
  const binding = { namespace: 'functions', name: 'exec', kind: 'code_mode' };
  for (const status of ['completed', 'failed', 'incomplete']) {
    let clock = 0;
    const cache = createTianxiToolResultCache({ maxOperations: 512, now: () => clock, ttlMs: 10 });
    const task = cache.begin('owner', { serialResultTool: binding });
    const one = cache.start('owner', task, 'one', 'Read');
    const two = cache.start('owner', task, 'two', 'Grep');
    assert.equal(cache.continuation('owner', [two.reference]), null);
    assert.equal(cache.continuation('other', [one.reference]), null);
    assert.equal(cache.continuation('owner', [one.reference]).nextCall, undefined);
    assert.equal(cache.settle('owner', task, status, answer(status)), true);
    const first = cache.continuation('owner', [one.reference]);
    assert.equal(first.nextCall.call_id, createTianxiResultCall(two.reference, binding).call_id);
    first.nextCall.input = 'PRIVATE_INJECTION';
    assert.equal(
      cache.continuation('owner', [one.reference]).nextCall.input.includes('PRIVATE'),
      false
    );
    assert.equal(cache.continuation('owner', [two.reference]).nextCall, undefined);
    clock = 10;
    assert.equal(cache.continuation('owner', [one.reference]), null);
  }
  const cache = createTianxiToolResultCache({ maxOperations: 512 });
  const task = cache.begin('owner', { serialResultTool: binding });
  for (let index = 0; index < 128; index++)
    assert.ok(cache.start('owner', task, String(index), 'Read'));
  assert.equal(cache.start('owner', task, 'overflow', 'Read'), null);
  assert.equal(cache.begin('owner', []), null);
  assert.equal(cache.begin('owner', null), null);
  const otherTask = cache.begin('owner', { serialResultTool: binding });
  const other = cache.start('owner', otherTask, 'other', 'Read');
  const first = cache.start('owner', task, '0', 'Read');
  assert.equal(cache.continuation('owner', [first.reference, other.reference]), null);
  assert.equal(cache.continuation('owner', []), null);
});

test('result cache isolates owners and returns only safe operation metadata', () => {
  const cache = createTianxiToolResultCache();
  const task = cache.begin('entry-a/profile-a');
  const operation = cache.start('entry-a/profile-a', task, 'native-id', 'Read');
  assert.match(operation.reference, REFERENCE_PATTERN);
  assert.equal(operation.status, 'in_progress');
  assert.equal(cache.lookup('entry-b/profile-a', operation.reference), null);
  assert.equal(cache.lookup('entry-a/profile-b', operation.reference), null);
  assert.equal(cache.finish('other', task, 'native-id', 'completed'), false);
  assert.equal(cache.settle('other', task, 'completed', answer()), false);
  assert.equal(cache.discard('other', task), false);
  operation.tool = 'tampered';
  assert.equal(cache.lookup('entry-a/profile-a', operation.reference).tool, 'Read');
  const unsafe = cache.start('entry-a/profile-a', task, 'another-id', 'token=secret/path');
  assert.equal(unsafe.tool, 'Operation');
  assert.deepEqual(Object.keys(unsafe).sort(), [
    'ordinal',
    'reference',
    'status',
    'taskStatus',
    'tool',
  ]);
  assert.equal(JSON.stringify(unsafe).includes('secret'), false);
});

test('operation starts and returns are idempotent across frame replay', () => {
  const cache = createTianxiToolResultCache();
  const task = cache.begin('owner');
  const first = cache.start('owner', task, 'one', 'Read');
  assert.deepEqual(cache.start('owner', task, 'one', 'Grep'), first);
  assert.equal(cache.finish('owner', task, 'one', 'completed'), true);
  assert.equal(cache.finish('owner', task, 'one', 'completed'), true);
  assert.equal(cache.finish('owner', task, 'one', 'failed'), false);
  assert.equal(cache.start('owner', task, 'one', 'Read').status, 'completed');
  assert.equal(cache.start('owner', task, 'two', 'Grep').ordinal, 2);
  assert.equal(cache.finish('owner', task, 'unknown', 'completed'), false);
  assert.equal(cache.finish('owner', task, 'two', 'invented'), false);
});

test('completion cache replays detached final answers without tool redispatch', () => {
  const cache = createTianxiToolResultCache();
  const task = cache.begin('owner');
  const operation = cache.start('owner', task, 'one', 'Read');
  assert.deepEqual(cache.continuation('owner', [operation.reference]), {
    status: 'in_progress',
    response: null,
  });
  cache.finish('owner', task, 'one', 'completed');
  const response = answer();
  assert.equal(cache.settle('owner', task, 'completed', response), true);
  response.output.length = 0;
  const retained = cache.continuation('owner', [operation.reference]);
  assert.equal(retained.response.output[0].content[0].text, 'OK');
  retained.response.output.length = 0;
  assert.equal(cache.continuation('owner', [operation.reference]).response.output.length, 1);
  assert.equal(cache.settle('owner', task, 'completed', answer('completed', 'different')), true);
  assert.equal(cache.settle('owner', task, 'failed'), false);
  assert.equal(cache.start('owner', task, 'later', 'Read'), null);
  assert.equal(cache.continuation('other', [operation.reference]), null);
  assert.equal(cache.discard('owner', task), true);
  assert.equal(cache.lookup('owner', operation.reference), null);
  assert.equal(cache.discard('owner', task), false);
});

test('missing native returns remain incomplete; failures never become success', () => {
  for (const status of ['completed', 'failed', 'canceled', 'incomplete']) {
    const cache = createTianxiToolResultCache();
    const task = cache.begin('owner');
    const operation = cache.start('owner', task, 'one', 'Read');
    assert.equal(cache.settle('owner', task, status), true);
    const result = cache.lookup('owner', operation.reference);
    assert.equal(result.status, status === 'completed' ? 'incomplete' : status);
    assert.equal(result.taskStatus, status);
    assert.deepEqual(cache.continuation('owner', [operation.reference]), {
      status,
      response: null,
    });
  }
});

test('expiry is absolute, unaffected by polling or replay, and handles clock rollback', () => {
  let clock = 1000;
  const cache = createTianxiToolResultCache({ now: () => clock, ttlMs: 100 });
  const task = cache.begin('owner');
  const operation = cache.start('owner', task, 'one', 'Read');
  clock = 1099;
  assert.ok(cache.lookup('owner', operation.reference));
  cache.start('owner', task, 'one', 'Read');
  clock = 1100;
  assert.equal(cache.lookup('owner', operation.reference), null);
  assert.equal(cache.settle('owner', task, 'completed'), false);
  const nextTask = cache.begin('owner');
  const nextOperation = cache.start('owner', nextTask, 'one', 'Read');
  clock = 1099;
  assert.equal(cache.continuation('owner', [nextOperation.reference]), null);
});

test('capacity rejects new active tasks, evicts terminal tasks, and caps operation count', () => {
  const cache = createTianxiToolResultCache({ maxTasks: 1, maxOperations: 1 });
  const task = cache.begin('owner');
  const first = cache.start('owner', task, 'one', 'Read');
  assert.equal(cache.begin('other'), null);
  assert.equal(cache.start('owner', task, 'two', 'Read'), null);
  assert.equal(cache.start('owner', task, 'one', 'Read').reference, first.reference);
  cache.settle('owner', task, 'failed');
  assert.ok(cache.begin('other'));
  assert.equal(cache.lookup('owner', first.reference), null);
});

test('response budgets reject oversized or aggregate overflow without changing task state', () => {
  const bytes = Buffer.byteLength(JSON.stringify(answer()));
  const cache = createTianxiToolResultCache({ maxBytes: bytes, maxResponseBytes: bytes });
  const firstTask = cache.begin('owner');
  const first = cache.start('owner', firstTask, 'one', 'Read');
  assert.equal(
    cache.settle('owner', firstTask, 'completed', answer('completed', 'x'.repeat(1024))),
    false
  );
  assert.equal(cache.lookup('owner', first.reference).taskStatus, 'in_progress');
  assert.equal(cache.settle('owner', firstTask, 'completed', answer()), true);
  const secondTask = cache.begin('owner');
  cache.start('owner', secondTask, 'two', 'Read');
  assert.equal(cache.settle('owner', secondTask, 'completed', answer()), false);
  cache.discard('owner', firstTask);
  assert.equal(cache.settle('owner', secondTask, 'completed', answer()), true);
});

test('invalid identities, references and cross-task continuations fail closed', () => {
  const cache = createTianxiToolResultCache({ ttlMs: -1, maxTasks: NaN, maxOperations: 0 });
  for (const value of [null, undefined, '', {}, [], 'x'.repeat(257)]) {
    assert.equal(cache.begin(value), null);
    assert.equal(cache.lookup('owner', value), null);
  }
  const one = cache.begin('owner');
  const two = cache.begin('owner');
  const first = cache.start('owner', one, 'one', 'Read');
  const second = cache.start('owner', two, 'two', 'Read');
  assert.equal(cache.start('owner', one, 'x'.repeat(129), 'Read'), null);
  assert.equal(cache.start('owner', 'invalid', 'one', 'Read'), null);
  for (const refs of [
    null,
    [],
    ['invalid'],
    [first.reference, second.reference],
    Array(129).fill(first.reference),
  ]) {
    assert.equal(cache.continuation('owner', refs), null);
  }
  assert.equal(cache.settle('owner', one, 'made-up'), false);
});

test('cached responses reject malformed, cyclic, mismatched and redispatching output', () => {
  const cache = createTianxiToolResultCache();
  const task = cache.begin('owner');
  const cyclic = answer();
  cyclic.circular = cyclic;
  const invalid = [
    [],
    123,
    answer('failed'),
    { status: 'completed', output: 'bad' },
    cyclic,
    { status: 'completed', output: [createTianxiResultCall('txr_' + 'a'.repeat(32))] },
    { status: 'completed', output: [null] },
    { status: 'completed', output: [{ type: 'message', role: 'user' }] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'commentary' }] },
    { status: 'completed', output: [], toJSON: () => undefined },
    { status: 'completed', output: [], toJSON: () => ({ status: 'failed', output: [] }) },
  ];
  for (const response of invalid)
    assert.equal(cache.settle('owner', task, 'completed', response), false);
  assert.equal(cache.settle('owner', task, 'completed', { status: 'completed', output: [] }), true);
});

test('bridge call uses the namespace and only an opaque cache reference', () => {
  const reference = 'txr_' + 'a'.repeat(32);
  const call = createTianxiResultCall(reference);
  assert.equal(call.namespace, 'mcp__tianxi_progress');
  assert.equal(call.name, 'read_result');
  assert.deepEqual(JSON.parse(call.arguments), { reference });
  assert.equal(call.call_id, 'call_tianxi_result_' + reference);
  assert.equal(call.status, 'completed');
  for (const value of ['', null, {}, 'txr_secret', reference + '/path']) {
    assert.equal(createTianxiResultCall(value), null);
  }
});

test('continuation parser ignores old turns and deduplicates current bridge outputs', () => {
  const first = createTianxiResultCall('txr_' + 'a'.repeat(32));
  const second = createTianxiResultCall('txr_' + 'b'.repeat(32));
  const old = { type: 'function_call_output', call_id: first.call_id, output: 'untrusted' };
  const current = { type: 'function_call_output', call_id: second.call_id, output: 'untrusted' };
  assert.deepEqual(parseTianxiResultContinuation([old, { role: 'user', content: 'new task' }]), {
    kind: 'none',
  });
  assert.deepEqual(
    parseTianxiResultContinuation([old, { role: 'user' }, second, current, current]),
    {
      kind: 'bridge',
      references: ['txr_' + 'b'.repeat(32)],
    }
  );
  assert.deepEqual(parseTianxiResultContinuation([current]), {
    kind: 'bridge',
    references: ['txr_' + 'b'.repeat(32)],
  });
});

test('malformed reserved call ids fail closed rather than falling through to native execution', () => {
  for (const input of [
    null,
    'text',
    {},
    [{ type: 'function_call_output', call_id: 'unrelated' }],
    [null],
  ]) {
    assert.deepEqual(parseTianxiResultContinuation(input), { kind: 'none' });
  }
  assert.deepEqual(
    parseTianxiResultContinuation([
      { type: 'function_call_output', call_id: 'call_tianxi_result_invalid' },
    ]),
    { kind: 'invalid' }
  );
  assert.deepEqual(parseTianxiResultContinuation(Array(4097).fill(null)), { kind: 'invalid' });
  const outputs = Array.from({ length: 129 }, (_, i) => ({
    type: 'function_call_output',
    call_id: createTianxiResultCall('txr_' + i.toString(16).padStart(32, '0')).call_id,
  }));
  assert.deepEqual(parseTianxiResultContinuation(outputs), { kind: 'invalid' });
});

test('mixed tool outputs cannot silently disappear into cached final answers', () => {
  const bridge = {
    type: 'function_call_output',
    call_id: createTianxiResultCall('txr_' + 'a'.repeat(32)).call_id,
  };
  for (const unrelated of [
    { type: 'function_call_output', call_id: 'call_other' },
    { type: 'custom_tool_call_output', call_id: 'call_other' },
  ]) {
    assert.deepEqual(parseTianxiResultContinuation([bridge, unrelated]), { kind: 'invalid' });
    assert.deepEqual(parseTianxiResultContinuation([unrelated, bridge]), { kind: 'invalid' });
  }
  assert.deepEqual(
    parseTianxiResultContinuation([{ ...bridge, role: 'user', call_id: 'call_tianxi_result_bad' }]),
    { kind: 'invalid' }
  );
});
