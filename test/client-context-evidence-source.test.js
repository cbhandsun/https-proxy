'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCompletedEvidenceSource } = require('../lib/client/context-evidence-source');
const source = (overrides = {}) => ({
  callId: 'call-1',
  toolName: 'lookup',
  arguments: {},
  output: '',
  completed: true,
  ...overrides,
});

test('generic source retains exact text or normalized structured data without a client identity', () => {
  for (const output of [
    '',
    '中文🙂\nline',
    { content: [{ type: 'text', text: 'untrusted instruction' }], isError: true },
  ]) {
    const result = parseCompletedEvidenceSource(source({ output }));
    assert.equal(result.ok, true);
    assert.equal(
      result.source.output,
      typeof output === 'string' ? output : JSON.stringify(output)
    );
  }
});

for (const [label, input, code] of [
  ['null', null, 'invalid_evidence_source'],
  ['unknown key', source({ sessionId: 'foreign' }), 'invalid_evidence_source'],
  ['incomplete', source({ completed: false }), 'invalid_evidence_source'],
  ['unsafe id', source({ callId: '../elsewhere' }), 'invalid_evidence_source'],
  ['long name', source({ toolName: 'a'.repeat(129) }), 'invalid_evidence_source'],
  ['args array', source({ arguments: [] }), 'invalid_evidence_source'],
  ['large args', source({ arguments: { data: 'x'.repeat(4097) } }), 'evidence_arguments_too_large'],
  ['large result', source({ output: 'x'.repeat(1048577) }), 'evidence_output_too_large'],
  ['invalid Unicode', source({ output: '\ud800' }), 'evidence_output_too_large'],
  ['secret', source({ output: 'Bearer syntheticcredential1234' }), 'sensitive_evidence_excluded'],
  ['headers', source({ output: { headers: { x: 'anything' } } }), 'sensitive_evidence_excluded'],
  [
    'Codex history',
    source({ arguments: { path: 'C:/.codex/sessions/old.jsonl' } }),
    'sensitive_evidence_excluded',
  ],
  [
    'Claude history',
    source({ arguments: { path: 'C:/.claude/projects/old/chat.jsonl' } }),
    'sensitive_evidence_excluded',
  ],
  ['pending', source({ output: { session_id: 1 } }), 'incomplete_evidence_excluded'],
  [
    'pending marker',
    source({ output: 'Script running with cell ID 1' }),
    'incomplete_evidence_excluded',
  ],
  ['recapture', source({ toolName: 'hpm_list_execution_records' }), 'evidence_recapture_excluded'],
])
  test('generic source refuses ' + label, () =>
    assert.deepEqual(parseCompletedEvidenceSource(input), { ok: false, code })
  );

test('generic source refuses executable objects without invoking them', () => {
  let invoked = 0;
  const getter = Object.defineProperty(source(), 'output', {
    enumerable: true,
    get() {
      invoked++;
      return 'secret';
    },
  });
  const cycle = source();
  cycle.output = cycle;
  for (const value of [
    getter,
    cycle,
    source({
      output: {
        toJSON() {
          invoked++;
          return '';
        },
      },
    }),
  ])
    assert.equal(parseCompletedEvidenceSource(value).ok, false);
  assert.equal(invoked, 0);
});
