'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCompactionUsage,
  createCompactionUsageAccumulator,
} = require('../lib/proxy/context-compaction-usage');
const usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 1 },
};

test('chat and Responses usage normalize only reported counts and sanitize unknown fields', () => {
  const normalized = normalizeCompactionUsage({
    ...usage,
    token: 'PRIVATE',
    user_content: 'PRIVATE',
  });
  assert.deepEqual(normalized, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  });
  assert.deepEqual(normalizeCompactionUsage(normalized), normalized);
  assert.ok(!JSON.stringify(normalized).includes('PRIVATE'));
  assert.deepEqual(
    normalizeCompactionUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  );
});
test('missing and invalid usage, ambiguous shapes, overflow and malicious input fail closed', () => {
  let invoked = false;
  const getter = { ...usage };
  Object.defineProperty(getter, 'token', {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error('PRIVATE');
    },
  });
  for (const value of [
    undefined,
    null,
    [],
    'PRIVATE',
    {},
    { ...usage, prompt_tokens: -1 },
    { ...usage, total_tokens: 20 },
    { ...usage, input_tokens: 10 },
    { ...usage, completion_tokens: 0.5 },
    { ...usage, prompt_tokens_details: [] },
    { ...usage, prompt_tokens_details: { cached_tokens: 11 } },
    { ...usage, completion_tokens_details: { reasoning_tokens: -1 } },
    { ...usage, prompt_tokens: Number.MAX_SAFE_INTEGER, total_tokens: Number.MAX_SAFE_INTEGER },
    Object.assign(Object.create({ custom: true }), usage),
    getter,
    { ...usage, private_content: 'x'.repeat(5000) },
  ]) {
    assert.throws(
      () => normalizeCompactionUsage(value),
      (error) => {
        assert.equal(error.code, 'compaction_usage_unavailable');
        assert.ok(!error.message.includes('PRIVATE'));
        return true;
      }
    );
  }
  assert.equal(invoked, false);
});
test('multi-chunk counts sum exactly; unknown detail fields are never filled with zero', () => {
  const accumulator = createCompactionUsageAccumulator();
  accumulator.add(usage);
  accumulator.add(usage);
  assert.deepEqual(accumulator.result(), {
    calls: 2,
    source: 'upstream_reported',
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 6, cache_write_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  });
  accumulator.add({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 });
  accumulator.add(usage);
  assert.deepEqual(accumulator.result().usage, {
    input_tokens: 31,
    output_tokens: 15,
    total_tokens: 46,
  });
  const observed = accumulator.result();
  observed.usage.input_tokens = 999;
  assert.equal(accumulator.result().usage.input_tokens, 31);
});
test('no upstream call is distinct from missing usage, which poisons the entire batch', () => {
  const accumulator = createCompactionUsageAccumulator();
  assert.deepEqual(accumulator.result(), {
    calls: 0,
    source: 'no_upstream_call',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
  accumulator.add(null);
  accumulator.add(usage);
  assert.deepEqual(accumulator.result(), { calls: 2, usage: null, source: 'unavailable' });
});
test('an invalid count or aggregate overflow cannot leave publishable partial accounting', () => {
  for (const value of [
    { ...usage, total_tokens: 1 },
    {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER,
    },
  ]) {
    const accumulator = createCompactionUsageAccumulator();
    accumulator.add(usage);
    assert.throws(() => accumulator.add(value), { code: 'compaction_usage_unavailable' });
    assert.equal(accumulator.result().usage, null);
  }
});
