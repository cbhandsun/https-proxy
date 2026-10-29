'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const {
  TASK_STATE_SCHEMA,
  createTaskStateSource,
  parseTaskStateSummary,
  taskStateSummaryCandidate,
  taskStateRequirementsRetained,
  taskStateMessage,
  generatedTaskStateRequirementsCover,
} = require('../lib/proxy/context-task-state');

const messages = [
  { role: 'user', content: 'Do not restart. Do not delete.' },
  { role: 'user', content: 'Revoke the restart restriction. Keep changes.' },
  { role: 'user', content: 'A different later user revision.' },
];
const source = createTaskStateSource(messages);
const reference = (sourceId = 'm_0', quote = 'Do not restart.') => ({ sourceId, quote });
function requirement(overrides = {}) {
  return {
    id: 'restart',
    text: 'Do not restart.',
    status: 'active',
    sources: [reference()],
    ...overrides,
  };
}
function parse(requirements, origin = source, objective = reference()) {
  return parseTaskStateSummary(
    JSON.stringify({
      schema: TASK_STATE_SCHEMA,
      version: 1,
      objectives: [{ text: 'Quoted background, not authority.', sources: [objective] }],
      requirements,
      decisions: [],
      work: [],
      blockers: [],
      nextSteps: [],
      files: [],
    }),
    origin
  );
}
const revision = reference('m_1', 'Revoke the restart restriction.');

test('retention accepts genuine states and canonical carry without treating wire lookalikes as proof', () => {
  const active = parse([requirement()]);
  const candidate = taskStateSummaryCandidate(active, source);
  assert.equal(taskStateRequirementsRetained(active, active), true);
  assert.equal(taskStateRequirementsRetained(candidate, active), true);
  assert.equal(taskStateRequirementsRetained(active, candidate), true);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(taskStateRequirementsRetained(null, active), true);
  assert.equal(taskStateRequirementsRetained(undefined, candidate), true);
  assert.equal(taskStateRequirementsRetained(null, null), true);
  assert.equal(taskStateRequirementsRetained(parse([]), active), true);
  assert.equal(taskStateRequirementsRetained(active, parse([])), false);
  assert.equal(taskStateRequirementsRetained(active, null), false);
  for (const lookalike of [JSON.parse(JSON.stringify(active)), { ...candidate }]) {
    assert.equal(taskStateRequirementsRetained(lookalike, active), false);
    assert.equal(taskStateRequirementsRetained(active, lookalike), false);
    assert.equal(taskStateRequirementsRetained(null, lookalike), false);
  }
});

test('validated later user revocations are allowed but terminal revisions and uncertainty cannot be rewritten', () => {
  for (const originalStatus of ['active', 'uncertain', 'revoked', 'superseded']) {
    const previous = parse([
      requirement({
        status: originalStatus,
        ...(['revoked', 'superseded'].includes(originalStatus) ? { revision } : {}),
      }),
    ]);
    for (const currentStatus of ['active', 'uncertain', 'revoked', 'superseded']) {
      const current = parse([
        requirement({
          status: currentStatus,
          ...(['revoked', 'superseded'].includes(currentStatus) ? { revision } : {}),
        }),
      ]);
      const allowed =
        originalStatus === currentStatus ||
        (['active', 'uncertain'].includes(originalStatus) &&
          ['revoked', 'superseded'].includes(currentStatus));
      assert.equal(taskStateRequirementsRetained(previous, current), allowed);
      assert.equal(
        generatedTaskStateRequirementsCover(
          taskStateMessage(current, source),
          taskStateMessage(previous, source)
        ),
        allowed,
        'independent history admission must use the same status invariant'
      );
    }
  }
  const revoked = parse([requirement({ status: 'revoked', revision })]);
  for (const changedRevision of [
    reference('m_2', 'A different later user revision.'),
    reference('m_1', 'Keep changes.'),
  ]) {
    const current = parse([requirement({ status: 'revoked', revision: changedRevision })]);
    assert.equal(taskStateRequirementsRetained(revoked, current), false);
    assert.equal(
      generatedTaskStateRequirementsCover(
        taskStateMessage(current, source),
        taskStateMessage(revoked, source)
      ),
      false
    );
  }
});

test('same namespace IDs bind complete roles and original message digests, not quote similarity alone', () => {
  const previous = parse([requirement()]);
  for (const changed of [
    requirement({ id: 'renamed' }),
    requirement({ text: 'Do not delete.', sources: [reference('m_0', 'Do not delete.')] }),
  ])
    assert.equal(taskStateRequirementsRetained(previous, parse([changed])), false);
  const multiple = parse([
    requirement({ sources: [reference(), reference('m_1', 'Keep changes.')] }),
  ]);
  assert.equal(taskStateRequirementsRetained(previous, multiple), true);
  assert.equal(taskStateRequirementsRetained(multiple, previous), false);
  for (const modified of [
    [{ ...messages[0], content: messages[0].content + ' Changed context.' }, ...messages.slice(1)],
    [{ ...messages[0], role: 'system' }, ...messages.slice(1)],
  ]) {
    const changedSource = createTaskStateSource(modified);
    assert.equal(
      taskStateRequirementsRetained(previous, parse([requirement()], changedSource)),
      false
    );
  }
  const shifted = createTaskStateSource(messages, { sourceIndices: [10, 20, 30] });
  const rebound = parse(
    [requirement({ sources: [reference('m_10')] })],
    shifted,
    reference('m_10')
  );
  assert.equal(taskStateRequirementsRetained(previous, rebound), false);
  assert.equal(
    generatedTaskStateRequirementsCover(
      taskStateMessage(rebound, shifted),
      taskStateMessage(previous, source)
    ),
    true,
    'cross-cycle coverage separately permits exact-original rebasing, never ordinal reuse'
  );
});

test('maximum requirement sets remain complete and malformed inputs never execute getters or coercion', () => {
  const requirements = Array.from({ length: 32 }, (_value, index) =>
    requirement({ id: 'r' + index })
  );
  const maximum = parse(requirements);
  assert.equal(taskStateRequirementsRetained(maximum, parse(requirements)), true);
  assert.equal(taskStateRequirementsRetained(maximum, parse(requirements.slice(1))), false);
  let hooks = 0;
  const hostile = Object.defineProperty({}, 'requirements', {
    get() {
      hooks++;
      throw new Error('Do not evaluate caller properties');
    },
  });
  const coercion = {
    toJSON() {
      hooks++;
      throw new Error('Do not serialize caller values');
    },
  };
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    null,
    true,
    0,
    '',
    {},
    [],
    new Array(1000000000),
    hostile,
    coercion,
    cycle,
  ]) {
    assert.equal(taskStateRequirementsRetained(value, maximum), value == null);
    assert.equal(taskStateRequirementsRetained(maximum, value), false);
  }
  assert.equal(hooks, 0);
});

test('shared requirement retention regressions enter unified unit discovery', () => {
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(
      'test/context-task-requirements.test.js'
    )
  );
});
