'use strict';
const assert = require('node:assert/strict');
const {
  WORKLOADS,
  createBenchmarkRequest,
} = require('../scripts/lib/protocol-benchmark-workloads');
const { createBenchmarkCases } = require('../scripts/lib/protocol-benchmark-cases');

for (const value of [undefined, null, '', 'SECRET', 0, true, [], {}, Symbol('SECRET')]) {
  assert.throws(
    () => createBenchmarkRequest(value),
    (error) => error instanceof TypeError && !error.message.includes('SECRET')
  );
}
const hostile = Object.defineProperty({}, 'secret', {
  get() {
    throw new Error('SECRET');
  },
});
assert.throws(() => createBenchmarkRequest(hostile), /Invalid benchmark workload/);
assert.ok(Object.isFrozen(WORKLOADS));
for (const workload of WORKLOADS) {
  const first = createBenchmarkRequest(workload);
  const second = createBenchmarkRequest(workload);
  assert.deepEqual(first, second);
  assert.notEqual(first.input, second.input);
  first.input.length = 0;
  assert.ok(second.input.length > 0, 'Workers must not share mutable input');
  assert.deepEqual(second, createBenchmarkRequest(workload));
}
assert.equal(createBenchmarkRequest('short-text').input.length, 1);
assert.equal(createBenchmarkRequest('long-text').input.length, 20);
assert.equal(
  createBenchmarkRequest('tool-history').input.filter((item) => item.type === 'function_call')
    .length,
  20
);
assert.equal(createBenchmarkRequest('image-history').input.length, 4);
const cases = createBenchmarkCases();
for (const workload of WORKLOADS) {
  for (const base of ['responses-claude', 'responses-gemini', 'chat-gemini', 'claude-responses']) {
    const id = workload === 'tool-history' ? base : base + '-' + workload;
    const entry = cases.find((value) => value.id === id);
    assert.ok(entry, 'Each request path must cover every workload');
    assert.deepEqual(entry.variants, ['native', 'legacy']);
    const native = entry.run('native', true);
    const legacy = entry.run('legacy', true);
    assert.equal(native.fingerprint, legacy.fingerprint, id);
    assert.deepEqual(
      entry.run('native', true),
      native,
      'Repeated conversion must preserve the fixture'
    );
  }
}
