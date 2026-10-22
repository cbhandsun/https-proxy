'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  genericAcceptanceToolDiagnostic,
} = require('../scripts/lib/generic-acceptance-tool-diagnostics');
const { parseContextEvidenceRequest } = require('../lib/proxy/context-evidence-request');
const { discoverTestFiles } = require('../lib/test-discovery');
const path = require('node:path');
const reply = (value, isError) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError } : {}),
});

test('safe diagnostics identify invalid optional cursor without accepting null or changing omission semantics', () => {
  const omitted = parseContextEvidenceRequest('hpm_list_retained_evidence', {});
  assert.equal(omitted.ok, true);
  assert.equal(Object.getPrototypeOf(omitted.arguments), null);
  assert.deepEqual(Object.keys(omitted.arguments), []);
  const refusal = parseContextEvidenceRequest('hpm_list_retained_evidence', {
    afterSourceId: null,
  });
  assert.equal(refusal.ok, false);
  assert.deepEqual(
    genericAcceptanceToolDiagnostic(
      'hpm_list_retained_evidence',
      'recovery_1',
      reply(refusal, true)
    ),
    {
      tool: 'index',
      phase: 'recovery_1',
      outcome: 'tool_failed',
      failure: {
        ok: false,
        error: 'invalid_evidence_arguments',
        field: 'afterSourceId',
        reason: 'wrong_type',
      },
    }
  );
});

test('unavailable and exhausted evidence remain distinct fixed errors', () => {
  for (const error of ['context_evidence_unavailable', 'evidence_read_budget_exceeded']) {
    const row = genericAcceptanceToolDiagnostic(
      'hpm_read_retained_evidence',
      'recovery_2',
      reply({ ok: false, error }, true)
    );
    assert.deepEqual(row.failure, { ok: false, error });
  }
  assert.equal(
    genericAcceptanceToolDiagnostic('emit_fresh_report', 'source', reply({ ok: true })).outcome,
    'returned'
  );
});

test('arbitrary exception text, arguments, names and evidence never reach diagnostics', () => {
  const secret = 'private-value-must-not-appear';
  const row = genericAcceptanceToolDiagnostic(
    secret,
    secret,
    reply(
      {
        error: secret,
        field: secret,
        reason: secret,
        sourceId: secret,
        digest: secret,
        headers: secret,
      },
      true
    )
  );
  assert.deepEqual(row, {
    tool: 'unknown',
    phase: 'unknown',
    outcome: 'tool_failed',
    failure: { ok: false, error: 'context_evidence_unavailable' },
  });
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.deepEqual(
    genericAcceptanceToolDiagnostic(
      'hpm_list_execution_records',
      'execution_verification',
      new Error(secret),
      true
    ),
    { tool: 'execution_ledger', phase: 'execution_verification', outcome: 'transport_failed' }
  );
});

test('empty, invalid, oversized and accessor-bearing outputs fail safely', () => {
  for (const input of [
    null,
    {},
    { content: [] },
    { content: [{ type: 'text', text: '{bad' }] },
    { content: [{ type: 'image', data: 'untrusted' }] },
    reply({ text: 'x'.repeat(2 * 1024 * 1024) }),
    Object.defineProperty({}, 'content', {
      get() {
        throw new Error('private');
      },
      enumerable: true,
    }),
  ])
    assert.equal(
      genericAcceptanceToolDiagnostic('hpm_read_retained_evidence', 'missing', input).outcome,
      'invalid_reply'
    );
  assert.ok(
    discoverTestFiles(path.resolve('.')).includes(
      'test/generic-acceptance-tool-diagnostics.test.js'
    )
  );
});
