'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeRecoveryUsage,
  parseRecoveryProgress,
} = require('../lib/proxy/context-recovery-progress');
const { encodeContextRecoveryClientWire } = require('../lib/proxy/context-recovery-client-wire');
const { createContextRecoveryCoordinator } = require('../lib/proxy/context-recovery-coordinator');
const { createContextEvidenceTools } = require('../lib/proxy/context-evidence-tools');
const { createContextEvidenceLedger } = require('../lib/proxy/context-evidence-ledger');

const counts = { input_tokens: 6, cached_tokens: 2, cache_write_tokens: 0, output_tokens: 3 };
const attribution = {
  items: { 'input[0]/msg_private-id': { ...counts, content: [counts] } },
  request_fields: { tools: counts },
};
const usage = { input_tokens: 6, output_tokens: 3, total_tokens: 9, attribution };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Anthropic service tier is validated separately from counters and only the final tier is published', () => {
  for (const tier of [null, 'standard', 'priority', 'batch']) {
    assert.deepEqual(plain(safeRecoveryUsage({ input_tokens: 2, service_tier: tier })), {
      input_tokens: 2,
    });
    const response = {
      id: 'msg_tier',
      type: 'message',
      model: 'synthetic',
      role: 'assistant',
      content: [{ type: 'text', text: 'READY' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 3, service_tier: tier },
    };
    for (const stream of [false, true]) {
      const encoded = encodeContextRecoveryClientWire(
        'claude',
        response,
        [{ input_tokens: 2, service_tier: 'priority' }, response.usage],
        stream
      );
      assert.deepEqual(plain(encoded.response.usage), {
        input_tokens: 2,
        output_tokens: 3,
        service_tier: tier,
      });
    }
  }
  for (const tier of [
    '',
    'auto',
    'standard_only',
    'private-content',
    {},
    [],
    -1,
    'x'.repeat(17000),
  ]) {
    assert.throws(() => safeRecoveryUsage({ service_tier: tier }));
    assert.throws(() =>
      encodeContextRecoveryClientWire(
        'claude',
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'READY' }],
          stop_reason: 'end_turn',
          usage: { service_tier: tier },
        },
        [{}],
        false
      )
    );
  }
  assert.throws(() => safeRecoveryUsage({ nested: { service_tier: 'standard' } }));
  let invoked = false;
  assert.throws(() =>
    safeRecoveryUsage({
      get service_tier() {
        invoked = true;
        return 'standard';
      },
    })
  );
  assert.equal(invoked, false);
});

test('official item attribution is validated without double counting or exposing private identities', () => {
  const before = JSON.stringify(usage);
  assert.deepEqual(plain(safeRecoveryUsage(usage)), {
    input_tokens: 6,
    output_tokens: 3,
    total_tokens: 9,
  });
  assert.equal(JSON.stringify(usage), before);
  assert.deepEqual(plain(safeRecoveryUsage({ attribution: { items: {} } })), {});
  assert.deepEqual(
    plain(safeRecoveryUsage({ input_tokens_details: { cached_tokens: 2 }, absent: null })),
    { input_tokens_details: { cached_tokens: 2 }, absent: null }
  );
  const result = parseRecoveryProgress({ rounds: 1, calls: 0, usage: [usage] });
  assert.equal(JSON.stringify(result).includes('private-id'), false);
});

test('attribution refuses malformed, executable, unsafe and excessive structures', () => {
  for (const value of [
    null,
    [],
    {},
    { items: [] },
    { items: {}, extra: 1 },
    { items: { 'bad\u0000id': counts } },
    { items: { '': counts } },
    { items: { ['x'.repeat(257)]: counts } },
    { items: { id: {} } },
    { items: { id: { input_tokens: -1 } } },
    { items: { id: { input_tokens: 1.5 } } },
    { items: { id: { input_tokens: Number.MAX_SAFE_INTEGER + 1 } } },
    { items: { id: { text: 'private content' } } },
    { items: { id: { content: 'private content' } } },
    { items: { id: { content: [{ content: [] }] } } },
    { items: { id: { content: [null] } } },
    { items: { id: { content: Array(16385).fill(counts) } } },
  ])
    assert.throws(() => safeRecoveryUsage({ attribution: value }));
  let executed = false;
  assert.throws(() =>
    safeRecoveryUsage({
      attribution: {
        get items() {
          executed = true;
          return {};
        },
      },
    })
  );
  assert.equal(executed, false);
  assert.throws(() =>
    safeRecoveryUsage({ attribution: { items: { ['x'.repeat(17000)]: counts } } })
  );
  assert.throws(() => safeRecoveryUsage({ other: 'private content' }));
  assert.throws(() => safeRecoveryUsage({ nested: { attribution } }));
});

test('request field attribution accepts observed tool counters and rejects unsafe extensions', () => {
  for (const request_fields of [
    {},
    { tools: counts },
    { tools: { input_tokens: 0 } },
    { tools: { input_tokens: Number.MAX_SAFE_INTEGER } },
  ]) {
    assert.deepEqual(plain(safeRecoveryUsage({ attribution: { request_fields, items: {} } })), {});
  }
  for (const request_fields of [
    null,
    [],
    0,
    { tools: {} },
    { tools: null },
    { tools: { input_tokens: -1 } },
    { tools: { input_tokens: 1.5 } },
    { tools: { input_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { tools: { content: [] } },
    { tools: { text: 'private' } },
    { unknown: counts },
    { tools: counts, unknown: counts },
  ]) {
    assert.throws(() => safeRecoveryUsage({ attribution: { items: {}, request_fields } }));
  }
  let executed = false;
  assert.throws(() =>
    safeRecoveryUsage({
      attribution: {
        items: {},
        request_fields: {
          get tools() {
            executed = true;
            return counts;
          },
        },
      },
    })
  );
  assert.equal(executed, false);
  const cyclic = {};
  cyclic.tools = cyclic;
  assert.throws(() => safeRecoveryUsage({ attribution: { items: {}, request_fields: cyclic } }));
  assert.throws(() =>
    safeRecoveryUsage({
      attribution: { items: {}, request_fields: { ['x'.repeat(17000)]: counts } },
    })
  );
});

test('actual recovery coordinator and JSON/SSE release accept official attribution and publish aggregate counters only', async () => {
  const readers = createContextEvidenceTools(
    createContextEvidenceLedger({ owner: 'synthetic-owner', threadId: 'synthetic-thread' })
  );
  const coordinator = createContextRecoveryCoordinator({
    kind: 'responses',
    body: { input: [{ role: 'user', content: 'synthetic' }], tools: [] },
    session: {
      definitions: readers.definitions,
      inspect: () => ({ active: true }),
      reply: () => {
        throw Error('unexpected reader');
      },
    },
  });
  assert.equal(coordinator.ok, true);
  const response = {
    id: 'resp_synthetic',
    status: 'completed',
    output: [
      {
        id: 'msg_synthetic',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'READY', annotations: [] }],
        metadata: {},
        internal_chat_message_metadata_passthrough: {},
        phase: 'final',
      },
    ],
    usage,
  };
  const result = await coordinator.acceptAsync(response);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'release');
  for (const stream of [false, true]) {
    const encoded = encodeContextRecoveryClientWire(
      'responses',
      result.response,
      result.usage,
      stream
    );
    assert.equal(encoded.wire.includes('private-id'), false);
    assert.equal(encoded.wire.includes('attribution'), false);
    assert.deepEqual(plain(encoded.response.usage), {
      input_tokens: 6,
      output_tokens: 3,
      total_tokens: 9,
    });
  }
});
