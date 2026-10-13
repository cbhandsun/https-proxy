'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextEvidenceLedger } = require('../lib/client/context-evidence-ledger');
const { createContextEvidenceNativeTools } = require('../lib/client/context-evidence-native-tools');
const { createContextEvidenceTools } = require('../lib/client/context-evidence-tools');
const { parseContextEvidenceRequest } = require('../lib/client/context-evidence-request');
const { encodeContextEvidenceOutput } = require('../lib/client/context-evidence-output');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createNativeLoopbackRpc } = require('../scripts/lib/native-loopback-rpc');
const LIST = 'hpm_list_retained_evidence';
const READ = 'hpm_read_retained_evidence';
const read = () => ({ sourceId: 'hce_' + 'a'.repeat(32), digest: 'b'.repeat(64) });

test('valid and default arguments preserve strict original values and bounded limits', () => {
  for (const args of [
    undefined,
    {},
    { limit: 1 },
    { limit: 16 },
    { afterSourceId: read().sourceId },
  ])
    assert.equal(parseContextEvidenceRequest(LIST, args).ok, true);
  for (const args of [
    read(),
    { ...read(), offsetBytes: 0, limitBytes: 1 },
    { ...read(), offsetBytes: Number.MAX_SAFE_INTEGER, limitBytes: 65536 },
  ]) {
    const parsed = parseContextEvidenceRequest(READ, args);
    assert.equal(parsed.ok, true);
    assert.deepEqual({ ...parsed.arguments }, args);
  }
});

test('field validation rejects rather than clamps, coerces, or invents cursors', () => {
  for (const [name, args, field, reason] of [
    [LIST, { limit: 17 }, 'limit', 'out_of_range'],
    [LIST, { limit: 0 }, 'limit', 'out_of_range'],
    [LIST, { limit: 1.5 }, 'limit', 'not_safe_integer'],
    [LIST, { limit: '16' }, 'limit', 'wrong_type'],
    [LIST, { afterSourceId: null }, 'afterSourceId', 'wrong_type'],
    [LIST, { afterSourceId: 'private-source' }, 'afterSourceId', 'invalid_format'],
    [READ, {}, 'sourceId', 'required'],
    [READ, { sourceId: read().sourceId }, 'digest', 'required'],
    [READ, { ...read(), digest: null }, 'digest', 'wrong_type'],
    [READ, { ...read(), digest: 'private-digest' }, 'digest', 'invalid_format'],
    [READ, { ...read(), offsetBytes: -1 }, 'offsetBytes', 'out_of_range'],
    [READ, { ...read(), offsetBytes: 1.5 }, 'offsetBytes', 'not_safe_integer'],
    [READ, { ...read(), offsetBytes: '0' }, 'offsetBytes', 'wrong_type'],
    [READ, { ...read(), limitBytes: 65537 }, 'limitBytes', 'out_of_range'],
    [READ, { ...read(), limitBytes: 0 }, 'limitBytes', 'out_of_range'],
    [READ, { ...read(), secret: 'private-value' }, 'arguments', 'unknown_field'],
  ]) {
    const parsed = parseContextEvidenceRequest(name, args);
    assert.deepEqual(parsed, { ok: false, error: 'invalid_evidence_arguments', field, reason });
    assert.equal(JSON.stringify(parsed).includes('private'), false);
  }
});

test('unsafe, empty, malformed, scalar and extreme inputs never run user hooks or readers', () => {
  let effects = 0;
  const getter = Object.defineProperty({}, 'limit', {
    enumerable: true,
    get() {
      effects++;
      return 1;
    },
  });
  const cycle = {};
  cycle.self = cycle;
  const values = [
    null,
    [],
    '',
    1,
    getter,
    cycle,
    Object.create({ limit: 1 }),
    { limit: Infinity },
    { limit: NaN },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { value: 'x'.repeat(1025) },
    { [Symbol('private-symbol')]: true },
    {
      toJSON() {
        effects++;
        return {};
      },
    },
  ];
  const tools = createContextEvidenceTools({
    list() {
      effects++;
      return { ok: true };
    },
    read() {
      effects++;
      return { ok: true };
    },
  });
  for (const args of values) {
    assert.equal(parseContextEvidenceRequest(LIST, args).ok, false);
    const reply = tools.reply(LIST, args);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'invalid_evidence_arguments');
  }
  assert.equal(parseContextEvidenceRequest('shell', {}).ok, false);
  assert.equal(parseContextEvidenceRequest(READ, undefined).ok, false);
  assert.equal(effects, 0);
  assert.equal(tools.inspect().calls, values.length);
  assert.equal(tools.inspect().successfulReads, 0);
});

test('native adapter emits safe failed content, keeps the session reader usable and charges attempts', (t) => {
  const ledger = createContextEvidenceLedger({ owner: 'test', threadId: 'test' });
  t.after(() => ledger.close());
  const source = ledger.capture({
    callId: 'original',
    toolName: 'read',
    arguments: {},
    output: 'synthetic🙂',
    completed: true,
  });
  const native = createContextEvidenceNativeTools(ledger);
  const failed = native.reply(LIST, { limit: 17 });
  assert.equal(failed.success, false);
  assert.deepEqual(JSON.parse(failed.contentItems[0].text), {
    ok: false,
    error: 'invalid_evidence_arguments',
    field: 'limit',
    reason: 'out_of_range',
  });
  assert.equal(native.inspect().returnedBytes, Buffer.byteLength(JSON.stringify(failed)));
  assert.equal(native.inspect().successfulReads, 0);
  const index = native.reply(LIST, {});
  assert.equal(index.success, true);
  assert.equal(JSON.parse(index.contentItems[0].text).sources[0].sourceId, source.sourceId);
  assert.equal(
    native.reply(READ, { sourceId: source.sourceId, digest: source.digest }).success,
    true
  );
  assert.equal(ledger.inspect().capturedCount, 1);
  while (native.inspect().calls < 64) native.reply(LIST, { limit: 17 });
  const budget = native.reply(LIST, {});
  assert.equal(budget.success, false);
  assert.equal(JSON.parse(budget.contentItems[0].text).error, 'evidence_read_budget_exceeded');
  assert.equal(native.inspect().calls, 64);
  assert.ok(native.inspect().returnedBytes <= native.inspect().maxBytes);
});

test('failure encoding strips unknown errors, fields, reasons and sensitive payloads', () => {
  for (const value of [
    { error: 'private-error', field: 'private-field', reason: 'private-reason' },
    { error: 'invalid_evidence_arguments', field: 'private-field', reason: 'out_of_range' },
    { error: 'invalid_evidence_arguments', field: 'limit', reason: 'private-reason' },
  ]) {
    const encoded = encodeContextEvidenceOutput({ ok: false, ...value, token: 'private-token' });
    assert.equal(encoded.text, '{"ok":false,"error":"context_evidence_unavailable"}');
  }
  const known = encodeContextEvidenceOutput({
    ok: false,
    error: 'invalid_evidence_arguments',
    field: 'limit',
    reason: 'out_of_range',
    value: 'private-value',
    headers: { cookie: 'private-cookie' },
  });
  assert.equal(JSON.stringify(known).includes('private'), false);
  assert.equal(known.nativeResult.success, false);
});

test('invalid-argument errors cannot overrun the remaining cumulative native-envelope budget', () => {
  const emptyBytes = encodeContextEvidenceOutput({ ok: true, padding: '' }).bytes;
  const tools = createContextEvidenceTools({
    list() {
      const remaining = tools.inspect().maxBytes - tools.inspect().returnedBytes;
      return {
        ok: true,
        padding: 'x'.repeat(Math.min(16000 - emptyBytes, remaining - emptyBytes - 1)),
      };
    },
    read: () => ({ ok: true }),
  });
  while (tools.inspect().maxBytes - tools.inspect().returnedBytes > emptyBytes + 1) {
    assert.equal(tools.reply(LIST, {}).ok, true);
  }
  const before = tools.inspect();
  const failed = tools.reply(LIST, { limit: 17 });
  assert.equal(failed.code, 'evidence_read_budget_exceeded');
  assert.equal(failed.text, undefined);
  assert.equal(tools.inspect().returnedBytes, before.returnedBytes);
  assert.equal(tools.inspect().calls, before.calls + 1);
  assert.equal(tools.inspect().successfulReads, 0);
});

test('safe failed native result is a normal RPC reply, not a transport refusal or acceptance proof', async (t) => {
  const ledger = createContextEvidenceLedger({ owner: 'rpc-test', threadId: 'test' });
  const native = createContextEvidenceNativeTools(ledger);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const rpc = createNativeLoopbackRpc(child, {
    onServerRequest(message) {
      assert.equal(message.method, 'item/tool/call');
      assert.equal(message.params.threadId, 'fixture-thread');
      assert.equal(message.params.namespace, null);
      return native.reply(message.params.tool, message.params.arguments);
    },
  });
  t.after(() => {
    rpc.close();
    ledger.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const reply = new Promise((resolve) =>
    child.stdin.once('data', (chunk) => resolve(JSON.parse(chunk.toString())))
  );
  child.stdout.write(
    JSON.stringify({
      id: 'tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 'fixture-thread',
        namespace: null,
        tool: LIST,
        arguments: { limit: 17 },
      },
    }) + '\n'
  );
  const result = await reply;
  assert.equal(result.id, 'tool-1');
  assert.equal(result.error, undefined);
  assert.equal(result.result.success, false);
  assert.equal(JSON.parse(result.result.contentItems[0].text).error, 'invalid_evidence_arguments');
  assert.equal(rpc.inspect().failureCode, null);
  const completion = rpc.waitFor('turn/completed', () => true);
  child.stdout.write(
    JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }) + '\n'
  );
  assert.equal((await completion).turn.status, 'completed');
  assert.equal(native.inspect().successfulReads, 0);
  assert.equal(rpc.inspect().failureCode, null);
});

test('error regressions enter unchanged unified CI discovery and client coverage gates', () => {
  const path = require('node:path');
  const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
  const name = 'test/client-context-evidence-errors.test.js';
  assert.ok(selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(name));
  const command = require('../package.json').scripts['test:client:coverage'];
  assert.ok(command.includes(name));
  assert.ok(command.includes('--statements 85 --branches 80 --functions 90 --lines 85'));
});
