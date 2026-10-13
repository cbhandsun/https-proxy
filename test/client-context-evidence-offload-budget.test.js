'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createContextEvidenceLedger } = require('../lib/proxy/context-evidence-ledger');
const { createContextEvidenceTools } = require('../lib/proxy/context-evidence-tools');
const { encodeContextEvidenceOutput } = require('../lib/proxy/context-evidence-output');
const {
  planCompleteEvidenceRead,
  createContextEvidenceOffloadBudget,
} = require('../lib/client/context-evidence-offload-budget');
const { discoverTestFiles } = require('../lib/test-discovery');
const READ = 'hpm_read_retained_evidence';
const sha = (value) => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  let now = 0;
  let calls = 0;
  const ledger = createContextEvidenceLedger({
    owner: 'offload-fixture',
    threadId: 'isolated',
    now: () => now,
    ttlMs: 100,
  });
  const tools = createContextEvidenceTools(ledger);
  const budget = createContextEvidenceOffloadBudget({ inspectReader: tools.inspect, ttlMs: 100 });
  t.after(() => {
    budget.close();
    ledger.close();
  });
  return {
    ledger,
    tools,
    budget,
    time: (value) => {
      now = value;
    },
    source: (output) =>
      ledger.capture({
        callId: 'call_' + ++calls,
        toolName: 'lookup',
        arguments: {},
        completed: true,
        output,
      }),
    read: (source, offsetBytes = 0, limitBytes = 16384) =>
      tools.reply(READ, {
        sourceId: source.sourceId,
        digest: source.digest,
        offsetBytes,
        limitBytes,
      }),
  };
}

test('full-read plan matches real encoded reader bytes for empty, escaped and paged Unicode sources without reading', (t) => {
  for (const output of ['', 'x'.repeat(2048), '"\\\n'.repeat(2000), '中文🙂'.repeat(4000)]) {
    const f = fixture(t);
    const source = f.source(output);
    const plan = planCompleteEvidenceRead({ output, source, reader: f.tools.inspect() });
    assert.equal(plan.ok, true);
    assert.equal(f.ledger.inspect().readCount, 0);
    assert.equal(f.tools.inspect().calls, 0);
    let offset = 0;
    let recovered = '';
    let bytes = 0;
    let calls = 0;
    do {
      const reply = f.read(source, offset, plan.limitBytes);
      assert.equal(reply.ok, true);
      const value = JSON.parse(reply.text);
      recovered += value.page.text;
      offset = value.page.nextOffsetBytes;
      bytes += encodeContextEvidenceOutput(value).bytes;
      calls++;
    } while (offset !== null);
    assert.equal(recovered === output, true);
    assert.equal(bytes, plan.readBytes);
    assert.equal(calls, plan.readCalls);
  }
});

test('planner refuses unescaped size, encoded size, exhausted budgets and invalid unknown data without getters', (t) => {
  const f = fixture(t);
  const output = 'fresh';
  const source = f.source(output);
  const reader = f.tools.inspect();
  let invoked = 0;
  const getter = Object.defineProperty({}, 'output', {
    enumerable: true,
    get() {
      invoked++;
      return output;
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const input of [
    null,
    [],
    {},
    getter,
    cyclic,
    { output, source, reader, extra: true },
    { output: 1, source, reader },
    { output: 'different', source, reader },
    { output, source: null, reader },
    { output, source: { ...source, sourceId: 'foreign' }, reader },
    { output, source: { ...source, digest: 'bad' }, reader },
    { output, source: { ...source, digest: '0'.repeat(64) }, reader },
    { output, source: { ...source, bytes: -1 }, reader },
    { output, source: { ...source, toolName: 'bad tool' }, reader },
    { output, source: { ...source, callId: '' }, reader },
    { output, source: { ...source, argumentsDigest: 'bad' }, reader },
    { output, source: { ...source, expiresAt: Infinity }, reader },
    { output, source: { ...source, trust: 'instructions' }, reader },
    { output, source, reader: null },
    { output, source, reader: { ...reader, extra: true } },
    { output, source, reader: { ...reader, maxCalls: 65 } },
    { output, source, reader: { ...reader, maxBytes: reader.maxBytes + 1 } },
    { output, source, reader: { ...reader, calls: '1' } },
    { output, source, reader: { ...reader, calls: 64 } },
    { output, source, reader: { ...reader, returnedBytes: reader.maxBytes } },
    { output, source, reader: { ...reader, successfulReads: 1 } },
  ])
    assert.deepEqual(planCompleteEvidenceRead(input), {
      ok: false,
      code: 'evidence_offload_read_budget_unavailable',
    });
  for (const large of ['x'.repeat(600 * 1024), '"'.repeat(100 * 1024)]) {
    const serialized = JSON.stringify({ content: [{ type: 'text', text: large }] });
    assert.equal(
      planCompleteEvidenceRead({ output: serialized, source: f.source(serialized), reader }).ok,
      false
    );
  }
  const invalidUtf8 = '\ud800';
  assert.equal(
    planCompleteEvidenceRead({
      output: invalidUtf8,
      source: { ...source, bytes: Buffer.byteLength(invalidUtf8), digest: sha(invalidUtf8) },
      reader,
    }).ok,
    false
  );
  assert.equal(invoked, 0);
  assert.equal(f.tools.inspect().calls, 0);
});

test('pending complete reads consume shared admission capacity and only full digest-verified reading releases it', (t) => {
  const f = fixture(t);
  const output = 'x'.repeat(300 * 1024);
  const source = f.source(output);
  assert.equal(f.budget.admit(output, source), true);
  assert.equal(f.budget.admit(output, f.source(output)), false);
  const initial = f.budget.inspect();
  let offset = 0;
  do {
    const reply = f.read(source, offset);
    assert.equal(reply.ok, true);
    const page = JSON.parse(reply.text).page;
    f.budget.observeRead(reply);
    offset = page.nextOffsetBytes;
    if (offset !== null) assert.deepEqual(f.budget.inspect(), initial);
  } while (offset !== null);
  assert.deepEqual(f.budget.inspect(), { pendingSources: 0, reservedCalls: 0, reservedBytes: 0 });
  const smaller = 'x'.repeat(100 * 1024);
  assert.equal(f.budget.admit(smaller, f.source(smaller)), true);
  assert.ok(f.tools.inspect().returnedBytes > 300 * 1024);
  assert.equal(f.tools.inspect().maxBytes, 512 * 1024);
});

test('seeking, repeats, malformed pages and foreign receipts cannot fabricate completion; contiguous overlap is valid', (t) => {
  const f = fixture(t);
  const output = 'x'.repeat(2048);
  const source = f.source(output);
  assert.equal(f.budget.admit(output, source), true);
  const original = f.budget.inspect();
  const full = JSON.parse(f.read(source).text);
  let invoked = 0;
  const getter = Object.defineProperty({}, 'ok', {
    enumerable: true,
    get() {
      invoked++;
      return true;
    },
  });
  for (const reply of [
    null,
    getter,
    { ok: false },
    { ok: true, text: 'not-json' },
    { ok: true, text: JSON.stringify({ ok: false }) },
    {
      ok: true,
      text: JSON.stringify({ ...full, source: { ...source, sourceId: 'hce_' + '0'.repeat(32) } }),
    },
    { ok: true, text: JSON.stringify({ ...full, source: { ...source, digest: '0'.repeat(64) } }) },
    {
      ok: true,
      text: JSON.stringify({ ...full, page: { ...full.page, chunkDigest: '0'.repeat(64) } }),
    },
    { ok: true, text: JSON.stringify({ ...full, page: { ...full.page, text: 'wrong' } }) },
    { ok: true, text: JSON.stringify({ ...full, page: { ...full.page, totalBytes: 1 } }) },
    f.read(source, 100),
  ]) {
    f.budget.observeRead(reply);
    assert.deepEqual(f.budget.inspect(), original);
  }
  const prefix = f.read(source, 0, 200);
  f.budget.observeRead(prefix);
  f.budget.observeRead(prefix);
  assert.deepEqual(f.budget.inspect(), original);
  f.budget.observeRead(f.read(source, 100));
  assert.equal(f.budget.inspect().pendingSources, 0);
  assert.equal(invoked, 0);
});

test('full-source digest mismatch retains reservation even if individual chunk digest is valid', (t) => {
  const f = fixture(t);
  const output = 'x'.repeat(2048);
  const source = f.source(output);
  assert.equal(f.budget.admit(output, source), true);
  const full = JSON.parse(f.read(source).text);
  const changed = 'y'.repeat(2048);
  f.budget.observeRead({
    ok: true,
    text: JSON.stringify({
      ...full,
      page: { ...full.page, text: changed, chunkDigest: sha(changed) },
    }),
  });
  assert.equal(f.budget.inspect().pendingSources, 1);
});

test('expired reservations are reclaimed on new capture without TTL renewal; close remains final and empty reads release', (t) => {
  const f = fixture(t);
  const output = 'x'.repeat(300 * 1024);
  const source = f.source(output);
  assert.equal(f.budget.admit(output, source), true);
  f.time(70);
  f.budget.observeRead(f.read(source, 0, 1));
  assert.equal(f.budget.inspect().pendingSources, 1);
  f.time(100);
  assert.equal(f.budget.admit(output, f.source(output)), true);
  assert.equal(f.budget.inspect().pendingSources, 1);
  f.budget.close();
  assert.deepEqual(f.budget.inspect(), { pendingSources: 0, reservedCalls: 0, reservedBytes: 0 });
  assert.equal(f.budget.admit(output, source), false);
  f.budget.observeRead({
    get ok() {
      throw new Error('must not run');
    },
  });
  const empty = fixture(t);
  const emptySource = empty.source('');
  assert.equal(empty.budget.admit('', emptySource), true);
  empty.budget.observeRead(empty.read(emptySource));
  assert.equal(empty.budget.inspect().pendingSources, 0);
});

test('invalid capabilities, throwing inspections and malformed receipts fail without execution or unsafe output', (t) => {
  let invoked = 0;
  const getter = Object.defineProperty({ ttlMs: 100 }, 'inspectReader', {
    enumerable: true,
    get() {
      invoked++;
      return () => ({});
    },
  });
  for (const options of [
    null,
    [],
    {},
    getter,
    { inspectReader: () => ({}), ttlMs: 0 },
    { inspectReader: 1, ttlMs: 1 },
    { inspectReader: () => ({}), ttlMs: 7200001 },
    { inspectReader: () => ({}), ttlMs: 1, extra: true },
  ])
    assert.throws(
      () => createContextEvidenceOffloadBudget(options),
      /Invalid evidence offload capabilities/
    );
  const f = fixture(t);
  const source = f.source('fresh');
  const throwing = createContextEvidenceOffloadBudget({
    inspectReader() {
      throw new Error('private detail');
    },
    ttlMs: 100,
  });
  const invalid = createContextEvidenceOffloadBudget({
    inspectReader: () => ({ calls: 0 }),
    ttlMs: 100,
  });
  t.after(throwing.close);
  t.after(invalid.close);
  assert.equal(throwing.admit('fresh', source), false);
  assert.equal(invalid.admit('fresh', source), false);
  assert.equal(f.budget.admit('fresh', null), false);
  assert.equal(f.budget.admit('fresh', { ...source, expiresAt: 1 }), false);
  assert.equal(f.budget.admit('different', source), false);
  assert.equal(f.budget.admit('fresh', source), true);
  assert.equal(f.budget.admit('fresh', source), false);
  assert.equal(invoked, 0);
  assert.equal(JSON.stringify(throwing.inspect()).includes('private'), false);
});

test('offload admission regressions enter unified CI discovery and client coverage without changing thresholds', () => {
  const root = path.resolve(__dirname, '..');
  const file = 'test/client-context-evidence-offload-budget.test.js';
  assert.ok(discoverTestFiles(root).includes(file));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = pkg.scripts['test:client:coverage'];
  assert.ok(command.includes(file));
  assert.ok(command.includes('--statements 85 --branches 80 --functions 90 --lines 85'));
});
