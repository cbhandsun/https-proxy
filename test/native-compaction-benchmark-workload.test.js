'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const {
  createNativeBenchmarkWorkload,
} = require('../scripts/lib/native-compaction-benchmark-workload');
function fill(workload) {
  for (const document of ['design', 'verification', 'release'])
    assert.equal(workload.reply('hpm_read_branch', { document }).ok, true);
  let next = 0;
  let content = '';
  do {
    const response = workload.reply('hpm_read_page', { offsetBytes: next });
    assert.equal(response.ok, true);
    const page = JSON.parse(response.text).page;
    assert.equal(createHash('sha256').update(page.text).digest('hex'), page.chunkDigest);
    content += page.text;
    next = page.nextOffsetBytes;
  } while (next !== null);
  const descriptor = workload.descriptor.documents.find((item) => item.name === 'pages');
  assert.equal(createHash('sha256').update(content).digest('hex'), descriptor.sha256);
  assert.equal(Buffer.byteLength(content), descriptor.bytes);
  return content;
}
test('fixed corpus, prompts and UTF-8 pages are identical between independent arms', () => {
  const a = createNativeBenchmarkWorkload();
  const b = createNativeBenchmarkWorkload();
  assert.deepEqual(a.descriptor, b.descriptor);
  assert.deepEqual(a.prompts, b.prompts);
  assert.deepEqual(a.tools, b.tools);
  assert.ok(a.descriptor.totalEvidenceBytes > 40000);
  assert.ok(a.descriptor.pageCount >= 3);
  assert.equal(fill(a), fill(b));
  assert.deepEqual(a.diagnostics(), b.diagnostics());
  assert.equal(a.reply('hpm_verify_state', a.expected).ok, true);
  assert.equal(b.reply('hpm_verify_state', b.expected).ok, true);
});
test('only complete evidence and current non-revoked exact state pass verification', () => {
  const early = createNativeBenchmarkWorkload();
  assert.equal(early.reply('hpm_verify_state', early.expected).ok, false);
  for (const field of ['color', 'candidate', 'status', 'count', 'receipt', 'pageFinding']) {
    const work = createNativeBenchmarkWorkload();
    fill(work);
    assert.equal(
      work.reply('hpm_verify_state', { ...work.expected, [field]: field === 'count' ? 7 : 'wrong' })
        .ok,
      false
    );
  }
  const work = createNativeBenchmarkWorkload();
  fill(work);
  assert.equal(work.reply('hpm_verify_state', work.expected).ok, true);
  assert.equal(work.reply('hpm_verify_state', work.expected).code, 'duplicate_state_verification');
});
test('empty, malformed, extreme, duplicate, skipped and unsafe tool inputs fail closed', () => {
  const work = createNativeBenchmarkWorkload();
  for (const args of [
    null,
    undefined,
    [],
    {},
    { offsetBytes: -1 },
    { offsetBytes: Infinity },
    { offsetBytes: 2 ** 53 },
    { offsetBytes: 0, extra: true },
  ]) {
    assert.equal(work.reply('hpm_read_page', args).ok, false);
  }
  assert.equal(work.reply('hpm_read_page', { offsetBytes: 1 }).code, 'page_sequence_invalid');
  assert.equal(work.reply('hpm_read_branch', { document: '../secret' }).ok, false);
  assert.equal(work.reply('shell', { command: 'write' }).code, 'unsupported_tool');
  let getterCalls = 0;
  const accessor = {
    get document() {
      getterCalls++;
      return 'design';
    },
  };
  assert.equal(work.reply('hpm_read_branch', accessor).ok, false);
  assert.equal(getterCalls, 0);
  assert.equal(work.reply('hpm_read_branch', { document: 'design' }).ok, true);
  assert.equal(work.reply('hpm_read_branch', { document: 'design' }).code, 'duplicate_tool_read');
  assert.equal(work.reply('hpm_read_page', { offsetBytes: 0 }).ok, true);
  assert.equal(work.reply('hpm_read_page', { offsetBytes: 0 }).code, 'page_sequence_invalid');
});
test('public diagnostics contain hashes and counts, never evidence or expected state', () => {
  const work = createNativeBenchmarkWorkload();
  fill(work);
  work.reply('hpm_verify_state', work.expected);
  const text = JSON.stringify(work.diagnostics());
  for (const value of [
    '青瓷',
    'audit-receipt',
    'preserve_native_checkpoint',
    'policy_is_not_tool_data',
  ])
    assert.equal(text.includes(value), false);
});

test('full evidence observation excludes prompts, summaries and truncated Code Mode output', () => {
  const work = createNativeBenchmarkWorkload();
  const result = work.reply('hpm_read_branch', { document: 'design' });
  assert.equal(work.inspectInput(null)[0].observed, false);
  assert.equal(work.inspectInput([{ type: 'message', content: result.text }])[0].observed, false);
  for (const output of [
    result.text.slice(0, -1),
    'preserve_native_checkpoint',
    null,
    { text: 'summary' },
  ])
    assert.equal(
      work.inspectInput([{ type: 'custom_tool_call_output', output }])[0].observed,
      false
    );
  for (const output of [result.text, JSON.stringify({ contentItems: [{ text: result.text }] })]) {
    const seen = work.inspectInput([{ type: 'custom_tool_call_output', output }]);
    assert.equal(seen[0].observed, true);
    assert.equal(JSON.stringify(seen).includes('preserve_native_checkpoint'), false);
  }
  assert.equal(
    work.inspectInput([{ type: 'function_call_output', output: { text: result.text } }])[0]
      .observed,
    true
  );
});

test('three-turn workload preserves all branches, paging, revoked requirements and final verification', () => {
  const work = createNativeBenchmarkWorkload();
  assert.equal(work.prompts.length, 3);
  assert.ok(work.prompts[0].includes('Promise.all'));
  assert.ok(work.prompts.every((prompt) => prompt.includes('console.log完整工具结果')));
  assert.ok(work.prompts[1].includes('result.page.nextOffsetBytes'));
  assert.ok(
    work.tools
      .find((tool) => tool.name === 'hpm_read_page')
      .description.includes('禁止猜测或空参数')
  );
  assert.ok(work.prompts[2].includes('hpm_verify_state一次'));
});

test('evidence input observation rejects unsafe, cyclic and oversized input without invoking getters', () => {
  const work = createNativeBenchmarkWorkload();
  work.reply('hpm_read_branch', { document: 'design' });
  let invoked = 0;
  const poisoned = [
    {
      get type() {
        invoked++;
        return 'custom_tool_call_output';
      },
    },
  ];
  const cyclic = [];
  cyclic.push(cyclic);
  for (const input of [
    undefined,
    poisoned,
    cyclic,
    [{ type: 'custom_tool_call_output', output: 'x'.repeat(2 * 1024 * 1024) }],
  ])
    assert.equal(work.inspectInput(input)[0].observed, false);
  assert.equal(invoked, 0);
});

test('failed oracle identifies only known mismatched field names, never supplied values or unknown names', () => {
  const work = createNativeBenchmarkWorkload();
  fill(work);
  const secret = 'unknown-private-value';
  const response = work.reply('hpm_verify_state', {
    ...work.expected,
    color: secret,
    designFinding: secret,
    [secret]: secret,
  });
  assert.equal(response.code, 'state_incorrect');
  const diagnostic = work.diagnostics().toolReplies.at(-1);
  assert.deepEqual(diagnostic.mismatchFields, ['color', 'designFinding']);
  assert.equal(diagnostic.extraFieldCount, 1);
  assert.equal(diagnostic.evidenceComplete, true);
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test('incomplete evidence remains distinguishable from wrong values and successful verification', () => {
  const early = createNativeBenchmarkWorkload();
  assert.equal(early.reply('hpm_verify_state', early.expected).ok, false);
  const failed = early.diagnostics().toolReplies.at(-1);
  assert.equal(failed.evidenceComplete, false);
  assert.deepEqual(failed.mismatchFields, []);
  const work = createNativeBenchmarkWorkload();
  fill(work);
  assert.equal(work.reply('hpm_verify_state', work.expected).ok, true);
  const passed = work.diagnostics().toolReplies.at(-1);
  assert.equal(passed.evidenceComplete, true);
  assert.deepEqual(passed.mismatchFields, []);
  assert.equal(passed.extraFieldCount, 0);
});

test('correct current requirements and later findings cannot mask two incorrect early audit findings', () => {
  const work = createNativeBenchmarkWorkload();
  fill(work);
  const submitted = {
    ...work.expected,
    designFinding: 'incorrect-early-finding',
    verificationFinding: 'incorrect-early-finding',
  };
  const response = work.reply('hpm_verify_state', submitted);
  assert.equal(response.code, 'state_incorrect');
  const diagnostic = work.diagnostics().toolReplies.at(-1);
  assert.equal(diagnostic.evidenceComplete, true);
  assert.equal(diagnostic.correct, false);
  assert.deepEqual(diagnostic.mismatchFields, ['designFinding', 'verificationFinding']);
  assert.equal(diagnostic.extraFieldCount, 0);
  assert.equal(JSON.stringify(diagnostic).includes('incorrect-early-finding'), false);
  assert.equal(work.reply('hpm_verify_state', work.expected).code, 'duplicate_state_verification');
});

test('oracle diagnostics never invoke inherited getters or expose mutable internal arrays', () => {
  const work = createNativeBenchmarkWorkload();
  fill(work);
  let invoked = 0;
  const symbolInput = { ...work.expected };
  Object.defineProperty(symbolInput, Symbol('private'), {
    enumerable: true,
    get() {
      invoked++;
      return 'private';
    },
  });
  assert.equal(work.reply('hpm_verify_state', symbolInput).code, 'invalid_tool_arguments');
  const args = Object.create({
    get color() {
      invoked++;
      return 'private';
    },
  });
  Object.defineProperties(args, Object.getOwnPropertyDescriptors(work.expected));
  delete args.color;
  assert.equal(work.reply('hpm_verify_state', args).ok, false);
  assert.equal(invoked, 0);
  const diagnostic = work.diagnostics().toolReplies.at(-1);
  assert.deepEqual(diagnostic.mismatchFields, ['color']);
  diagnostic.mismatchFields.push('private');
  assert.deepEqual(work.diagnostics().toolReplies.at(-1).mismatchFields, ['color']);
});
