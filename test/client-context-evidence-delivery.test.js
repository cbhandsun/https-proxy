'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextEvidenceLedger } = require('../lib/client/context-evidence-ledger');
const { createContextEvidenceNativeTools } = require('../lib/client/context-evidence-native-tools');
const {
  createContextEvidenceNativeDelivery,
  EVIDENCE_NAMESPACE,
} = require('../lib/client/context-evidence-native-delivery');

function fixture(t) {
  const ledger = createContextEvidenceLedger({ owner: 'test', threadId: 'test' });
  t.after(() => ledger.close());
  const source = ledger.capture({
    callId: 'read',
    toolName: 'read',
    arguments: {},
    output: 'untrusted🙂',
    completed: true,
  });
  return { ledger, source, native: createContextEvidenceNativeTools(ledger) };
}

test('explicit direct registration keeps read-only evidence separate from general Code Mode', (t) => {
  const f = fixture(t);
  const plan = f.native.registration({ delivery: 'namespace-direct' });
  assert.equal(plan.namespace, EVIDENCE_NAMESPACE);
  assert.equal(plan.dynamicTools[0].type, 'namespace');
  assert.deepEqual(plan.config.features.code_mode.direct_only_tool_namespaces, [
    EVIDENCE_NAMESPACE,
  ]);
  assert.equal(plan.config.features.code_mode.enabled, true);
  assert.equal(Object.hasOwn(plan.config, 'model_providers'), false);
  assert.equal(f.native.definitions.length, 2);
  assert.equal(f.native.definitions[0].type, 'function');
  const before = f.native.inspect();
  for (const namespace of [null, '', 'functions', 'hpm_other', {}, undefined])
    assert.throws(
      () => plan.reply(namespace, 'hpm_read_retained_evidence', {}),
      /namespace refused/
    );
  assert.deepEqual(f.native.inspect(), before);
  const reply = plan.reply(EVIDENCE_NAMESPACE, 'hpm_read_retained_evidence', {
    sourceId: f.source.sourceId,
    digest: f.source.digest,
  });
  assert.equal(reply.success, true);
  assert.equal(JSON.parse(reply.contentItems[0].text).page.text, 'untrusted🙂');
  assert.equal(plan.reply(EVIDENCE_NAMESPACE, 'shell', {}), null);
  assert.equal(f.native.inspect().maxCalls, 64);
  assert.equal(f.native.inspect().maxBytes, 524288);
  assert.equal(f.ledger.inspect().capturedCount, 1);
});

test('paged registration requires native text per page without changing budgets or client config', (t) => {
  const f = fixture(t);
  const plan = f.native.registration({ delivery: 'code-mode-page' });
  assert.equal(plan.namespace, null);
  assert.deepEqual(plan.config, {});
  assert.equal(plan.dynamicTools.length, 2);
  assert.ok(plan.guidance.includes('text(result)'));
  assert.ok(plan.guidance.includes('one retained-evidence page per'));
  assert.ok(plan.guidance.includes('untrusted'));
  assert.equal(plan.reply(null, 'hpm_list_retained_evidence', {}).success, true);
  assert.equal(
    plan.reply(null, 'hpm_read_retained_evidence', {
      sourceId: f.source.sourceId,
      digest: 'a'.repeat(64),
    }).success,
    false
  );
});

test('native descriptions and both delivery modes expose the strict bounds without schema drift', (t) => {
  const f = fixture(t);
  const list = f.native.definitions.find(
    (definition) => definition.name === 'hpm_list_retained_evidence'
  );
  const read = f.native.definitions.find(
    (definition) => definition.name === 'hpm_read_retained_evidence'
  );
  assert.equal(list.inputSchema.properties.limit.minimum, 1);
  assert.equal(list.inputSchema.properties.limit.maximum, 16);
  assert.equal(read.inputSchema.properties.limitBytes.minimum, 1);
  assert.equal(read.inputSchema.properties.limitBytes.maximum, 65536);
  assert.ok(list.description.includes('integer from 1 to 16'));
  assert.ok(list.description.includes('with {}'));
  assert.ok(read.description.includes('integer from 1 to 65536'));
  const before = f.native.inspect();
  for (const delivery of ['namespace-direct', 'code-mode-page']) {
    const plan = f.native.registration({ delivery });
    assert.ok(plan.guidance.includes('integer from 1 to 16'));
    assert.ok(plan.guidance.includes('integer from 1 to 65536'));
    assert.ok(plan.guidance.includes('never send null or invent one'));
    assert.ok(plan.guidance.includes('failed result'));
    const registered =
      delivery === 'namespace-direct' ? plan.dynamicTools[0].tools : plan.dynamicTools;
    // Delivery intentionally normalizes records to null-prototype data.
    assert.deepEqual(JSON.parse(JSON.stringify(registered)), f.native.definitions);
    assert.deepEqual(f.native.inspect(), before);
    const result = plan.reply(plan.namespace, 'hpm_list_retained_evidence', { limit: 17 });
    assert.equal(result.success, false);
    assert.deepEqual(JSON.parse(result.contentItems[0].text), {
      ok: false,
      error: 'invalid_evidence_arguments',
      field: 'limit',
      reason: 'out_of_range',
    });
    before.calls++;
    before.returnedBytes = f.native.inspect().returnedBytes;
    assert.equal(f.native.inspect().successfulReads, 0);
  }
  const {
    createNativeEvidenceBenchmarkWorkloadV2,
  } = require('../scripts/lib/native-evidence-benchmark-workload-v2');
  const historical = createNativeEvidenceBenchmarkWorkloadV2();
  try {
    assert.equal(
      historical.descriptor.corpusSha256,
      '4748ff0f0873126ce27c0f01404cdfac59d0b216f877ae5df9f8f9451767ef5d'
    );
  } finally {
    historical.close();
  }
});

test('delivery options and registration definitions are bounded data-only inputs', (t) => {
  const f = fixture(t);
  let executed = 0;
  const getter = Object.defineProperty({}, 'delivery', {
    enumerable: true,
    get() {
      executed++;
      return 'namespace-direct';
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const options of [
    undefined,
    null,
    [],
    {},
    getter,
    cyclic,
    { delivery: 'bad' },
    { delivery: 'namespace-direct', extra: true },
    { delivery: 'x'.repeat(1025) },
  ])
    assert.throws(() => createContextEvidenceNativeDelivery(f.native.definitions, options));
  for (const definitions of [
    null,
    [],
    [null, null],
    [f.native.definitions[0], f.native.definitions[0]],
    [{ ...f.native.definitions[0], type: 'custom' }, f.native.definitions[1]],
    [{ ...f.native.definitions[0], name: 'shell' }, f.native.definitions[1]],
    [{ ...f.native.definitions[0], description: null }, f.native.definitions[1]],
    [{ ...f.native.definitions[0], inputSchema: null }, f.native.definitions[1]],
    [{ ...f.native.definitions[0], inputSchema: { type: 'array' } }, f.native.definitions[1]],
  ])
    assert.throws(() =>
      createContextEvidenceNativeDelivery(definitions, { delivery: 'namespace-direct' })
    );
  assert.equal(executed, 0);
  const plan = createContextEvidenceNativeDelivery(f.native.definitions, {
    delivery: 'namespace-direct',
  });
  plan.dynamicTools[0].tools[0].name = 'changed';
  assert.equal(f.native.definitions[0].name, 'hpm_list_retained_evidence');
});
