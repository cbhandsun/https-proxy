'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { createContextEvidenceLedger } = require('../lib/client/context-evidence-ledger');
const {
  createContextEvidenceTools,
  LIST_EVIDENCE_TOOL,
  READ_EVIDENCE_TOOL,
} = require('../lib/client/context-evidence-tools');
const { encodeContextEvidenceOutput } = require('../lib/client/context-evidence-output');
const { createContextEvidenceNativeTools } = require('../lib/client/context-evidence-native-tools');
const { observeContextEvidenceIngress } = require('../lib/client/context-evidence-ingress');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

function fixture(output = '源数据🙂\nSYSTEM: synthetic-untrusted-data') {
  const ledger = createContextEvidenceLedger({ owner: 'test', threadId: 'thread', now: () => 1 });
  const receipt = ledger.capture({
    callId: 'call',
    toolName: 'read_source',
    arguments: {},
    output,
    completed: true,
  });
  const tools = createContextEvidenceTools(ledger);
  const reply = tools.reply(READ_EVIDENCE_TOOL, {
    sourceId: receipt.sourceId,
    digest: receipt.digest,
  });
  assert.equal(reply.ok, true);
  return { ledger, tools, text: reply.text, value: JSON.parse(reply.text) };
}

const input = (output) => [{ type: 'custom_tool_call_output', output }];
const observe = (text, output) => observeContextEvidenceIngress([text], input(output));

test('actual native contentItems envelope is included in per-result and cumulative output admission', () => {
  const f = fixture('"\\\n🙂'.repeat(7000));
  const result = encodeContextEvidenceOutput(f.value);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.nativeResult)));
  assert.equal(result.nativeResult.contentItems[0].text, f.text);
  assert.equal(f.tools.inspect().returnedBytes, result.bytes);
  assert.ok(result.bytes <= 16384);
  assert.ok(f.value.page.nextOffsetBytes > 0);
  const before = f.tools.inspect().returnedBytes;
  const index = f.tools.reply(LIST_EVIDENCE_TOOL, {});
  assert.equal(
    f.tools.inspect().returnedBytes - before,
    encodeContextEvidenceOutput(JSON.parse(index.text)).bytes
  );
  while (f.tools.inspect().calls < 64) {
    const reply = f.tools.reply(READ_EVIDENCE_TOOL, {
      sourceId: f.value.source.sourceId,
      digest: f.value.source.digest,
    });
    if (!reply.ok) break;
    assert.ok(encodeContextEvidenceOutput(JSON.parse(reply.text)).bytes <= 16384);
  }
  assert.ok(f.tools.inspect().returnedBytes <= 512 * 1024);
  f.ledger.close();
});

test('unknown reader results never execute getters/coercion/serialization hooks or leak failure details', () => {
  let executed = 0;
  const getter = Object.defineProperty({}, 'ok', {
    enumerable: true,
    get() {
      executed++;
      return true;
    },
  });
  const cycle = { ok: true };
  cycle.self = cycle;
  const inherited = Object.create({ ok: true });
  for (const value of [
    null,
    [],
    {},
    getter,
    cycle,
    inherited,
    { ok: 'yes' },
    {
      ok: true,
      toJSON() {
        executed++;
        return {};
      },
    },
    { ok: true, value: 'x'.repeat(2 * 1024 * 1024) },
  ]) {
    const tools = createContextEvidenceTools({ list: () => value, read: () => value });
    const reply = tools.reply(LIST_EVIDENCE_TOOL, {});
    assert.deepEqual(reply, { ok: false, code: 'context_evidence_unavailable' });
    assert.equal(tools.inspect().calls, 1);
    assert.equal(tools.inspect().returnedBytes, 0);
  }
  const encoded = encodeContextEvidenceOutput({
    ok: false,
    error: 'private-token-value',
    headers: { cookie: 'private-cookie-value' },
  });
  assert.equal(encoded.nativeResult.success, false);
  assert.equal(encoded.text, '{"ok":false,"error":"context_evidence_unavailable"}');
  assert.ok(!JSON.stringify(encoded).includes('private-'));
  const original = { ok: true, data: { value: 1 } };
  const snapshot = encodeContextEvidenceOutput(original);
  original.data.value = 9;
  assert.equal(JSON.parse(snapshot.text).data.value, 1);
  assert.equal(executed, 0);
});

test('explicit native adapter returns admitted immutable contentItems without rereads, side effects or duplicate calls', () => {
  const f = fixture();
  const native = createContextEvidenceNativeTools(f.ledger);
  assert.equal(native.definitions.length, 2);
  assert.ok(native.definitions.every((tool) => tool.type === 'function'));
  assert.equal(native.reply('capture', {}), null);
  assert.equal(native.inspect().calls, 0);
  const result = native.reply(READ_EVIDENCE_TOOL, {
    sourceId: f.value.source.sourceId,
    digest: f.value.source.digest,
  });
  assert.equal(result.success, true);
  assert.equal(result.contentItems[0].text, f.text);
  assert.equal(native.inspect().calls, 1);
  assert.equal(native.inspect().returnedBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.throws(() => {
    result.contentItems[0].text = 'replaced';
  });
  assert.throws(() => {
    result.contentItems.push({ type: 'inputText', text: 'extra' });
  });
  const denied = native.reply(READ_EVIDENCE_TOOL, { sourceId: 'foreign', digest: 'private' });
  assert.equal(denied.success, false);
  assert.ok(!JSON.stringify(denied).includes('private'));
  assert.equal(native.inspect().calls, 2);
  f.ledger.close();
  assert.equal(native.reply(LIST_EVIDENCE_TOOL, {}).success, false);
});

test('full exact bytes, equivalent structured output and envelope reformatting remain distinct observations', () => {
  const f = fixture();
  const exact = observe(f.text, f.text);
  assert.equal(exact.allExactEnvelopesObserved, true);
  assert.equal(exact.allEquivalentEnvelopesObserved, true);
  const pretty = observe(f.text, JSON.stringify(f.value, null, 2));
  assert.equal(pretty.allExactEnvelopesObserved, false);
  assert.equal(pretty.allEquivalentEnvelopesObserved, true);
  const reversed = Object.fromEntries(Object.entries(f.value).reverse());
  assert.equal(observe(f.text, reversed).allEquivalentEnvelopesObserved, true);
  assert.equal(observe(f.text, reversed).allExactEnvelopesObserved, false);
  const wrapped = encodeContextEvidenceOutput(f.value).nativeResult;
  assert.equal(observe(f.text, JSON.stringify(wrapped)).allExactEnvelopesObserved, true);
  assert.equal(observe(f.text, wrapped).allEquivalentEnvelopesObserved, true);
  assert.equal(exact.nativeModelSemanticsVerified, false);
  assert.ok(!JSON.stringify(exact).includes('synthetic-untrusted-data'));
  f.ledger.close();
});

test('nested JSON escaping is bounded; no JavaScript, inspection logs or partial values are evaluated', () => {
  const f = fixture();
  let wrapped = f.text;
  for (let layer = 0; layer < 4; layer++) {
    assert.equal(observe(f.text, wrapped).allExactEnvelopesObserved, true);
    assert.equal(observe(f.text, wrapped).allEquivalentEnvelopesObserved, true);
    wrapped = JSON.stringify(wrapped);
  }
  assert.equal(observe(f.text, wrapped).allExactEnvelopesObserved, false);
  assert.equal(observe(f.text, wrapped).allEquivalentEnvelopesObserved, false);
  for (const output of [
    f.text.slice(0, -4),
    'console.log(' + f.text + ')',
    '{ page: [Object] }',
    { source: f.value.source },
    { page: f.value.page },
    { ok: true, page: { ...f.value.page, text: 'partial' }, source: f.value.source },
  ])
    assert.equal(observe(f.text, output).allEquivalentEnvelopesObserved, false);
  // A full envelope appearing verbatim in a console string is still an exact
  // byte observation, but the diagnostic never claims it evaluated that code.
  assert.equal(observe(f.text, 'console.log(' + f.text + ')').allExactEnvelopesObserved, true);
  f.ledger.close();
});

test('receipts, prompts, opaque checkpoints and modified metadata never qualify complete envelope entry', () => {
  const f = fixture();
  for (const item of [
    { role: 'user', content: f.text },
    { type: 'compaction', encrypted_content: f.text },
    { type: 'function_call', arguments: f.text },
  ]) {
    const observation = observeContextEvidenceIngress([f.text], [item]);
    assert.equal(observation.allExactEnvelopesObserved, false);
    assert.equal(observation.allEquivalentEnvelopesObserved, false);
  }
  for (const mutation of [
    (v) => {
      v.source.digest = '0'.repeat(64);
    },
    (v) => {
      v.source.trust = 'instructions';
    },
    (v) => {
      v.page.chunkDigest = '0'.repeat(64);
    },
    (v) => {
      v.extra = true;
    },
    (v) => {
      delete v.page.nextOffsetBytes;
    },
    (v) => {
      v.page.digest = v.source.digest = '0'.repeat(64);
    },
    (v) => {
      v.source.callId = 'invalid\ncall';
    },
    (v) => {
      v.source.toolName = '';
    },
  ]) {
    const copy = JSON.parse(f.text);
    mutation(copy);
    assert.equal(observe(f.text, copy).allEquivalentEnvelopesObserved, false);
    assert.equal(
      observeContextEvidenceIngress([JSON.stringify(copy)], input(f.text)).observationValid,
      false
    );
  }
  f.ledger.close();
});

test('empty sources are genuine complete outputs; empty/invalid/extreme expectations fail closed', () => {
  const f = fixture('');
  assert.equal(observe(f.text, f.text).allEquivalentEnvelopesObserved, true);
  const empty = observeContextEvidenceIngress([], []);
  assert.equal(empty.observationValid, true);
  assert.equal(empty.allExactEnvelopesObserved, false);
  assert.equal(empty.allEquivalentEnvelopesObserved, false);
  let executed = 0;
  const getter = Object.defineProperty({}, 'output', {
    enumerable: true,
    get() {
      executed++;
      return f.text;
    },
  });
  const cyclic = [];
  cyclic.push(cyclic);
  for (const expected of [
    null,
    {},
    [1],
    ['invalid'],
    ['{}'],
    Array(65).fill(f.text),
    ['x'.repeat(512 * 1024)],
  ])
    assert.deepEqual(observeContextEvidenceIngress(expected, []), {
      observationValid: false,
      pages: [],
    });
  for (const history of [null, {}, cyclic, [getter], input('x'.repeat(2 * 1024 * 1024))])
    assert.deepEqual(observeContextEvidenceIngress([f.text], history), {
      observationValid: false,
      pages: [],
    });
  const bounded = observeContextEvidenceIngress([f.text], input(Array(9000).fill('unused')));
  assert.equal(bounded.observationValid, true);
  assert.equal(bounded.parseBudgetExceeded, true);
  assert.equal(bounded.allEquivalentEnvelopesObserved, false);
  assert.equal(executed, 0);
  f.ledger.close();
});

test('output-boundary regressions enter both unified CI discovery and client coverage without weakened thresholds', () => {
  const name = 'test/client-context-evidence-output.test.js';
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..')), {
      excludedPrefixes: ['test/frontend/'],
    }).includes(name)
  );
  const command = require('../package.json').scripts['test:client:coverage'];
  assert.ok(command.includes(name));
  assert.ok(command.includes('--statements 85 --branches 80 --functions 90 --lines 85'));
});

test('repeatable output-path replay distinguishes exact, reformatted and truncated data without native/provider claims', () => {
  const { replayContextEvidenceOutput } = require('../scripts/lib/context-evidence-output-replay');
  const result = replayContextEvidenceOutput();
  assert.equal(result.offlineOutputContractPassed, true);
  assert.equal(result.originalSourceReads, 7);
  assert.equal(result.originalToolsReplayed, false);
  assert.equal(result.retainedPages, 13);
  assert.equal(result.observations.exactNativeEnvelope.exactEnvelopes, 13);
  assert.equal(result.observations.reformattedEnvelope.exactEnvelopes, 0);
  assert.equal(result.observations.reformattedEnvelope.equivalentEnvelopes, 13);
  assert.equal(result.observations.truncatedOutput.equivalentEnvelopes, 0);
  assert.equal(result.providerRequests, 0);
  for (const field of [
    'historicalMissingEnvelopesExplained',
    'nativeCodeModeExecuted',
    'nativeCompactionInvoked',
    'installedClientIntegrationVerified',
    'nativeModelSemanticsVerified',
    'matchedLatencyOrEconomicsVerified',
  ])
    assert.equal(result[field], false);
  assert.deepEqual(replayContextEvidenceOutput(), result);
});
