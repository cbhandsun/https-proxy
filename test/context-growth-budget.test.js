'use strict';

const assert = require('node:assert/strict');
const {
  resolveContextGrowthBudget,
  MAX_GROWTH_RESERVE_BYTES,
  MAX_GROWTH_SAMPLES,
} = require('../lib/proxy/context-growth-budget');

const empty = resolveContextGrowthBudget({}, 200000);
assert.equal(empty.growthReserveBytes, 16384);
assert.equal(empty.planningBodyBytes, 183616);
assert.equal(empty.triggerBodyBytes, 191808);
assert.equal(empty.growthSampleCount, 0);
for (const value of [
  null,
  undefined,
  {},
  [],
  Symbol('x'),
  -1,
  NaN,
  Infinity,
  Number.MAX_VALUE,
  'Infinity',
  '1.5',
  ' 12 ',
]) {
  const result = resolveContextGrowthBudget(null, value, { growthReserveBytes: value });
  assert.equal(result.hardBodyBytes, 0);
  assert.equal(result.planningBodyBytes, 0);
}
for (const options of [
  null,
  [],
  Symbol('x'),
  { growthReserveBytes: {} },
  { growthReserveBytes: Symbol('x') },
]) {
  assert.equal(resolveContextGrowthBudget({}, 200000, options).growthReserveBytes, 16384);
}
assert.equal(
  resolveContextGrowthBudget({}, '200000', { growthReserveBytes: '0' }).growthReserveBytes,
  0
);
assert.equal(
  resolveContextGrowthBudget({}, 101, { growthReserveBytes: 999999 }).growthReserveBytes,
  25
);
const messages = [];
for (let i = 0; i < 20; i += 1)
  messages.push(
    { role: 'assistant', tool_calls: [{ id: `call-${i}` }] },
    {
      role: 'tool',
      tool_call_id: `call-${i}`,
      content: i === 19 ? '汉🙂"\\\n'.repeat(10000) : 'tiny',
    }
  );
const before = JSON.stringify(messages);
const forecast = resolveContextGrowthBudget({ messages }, 200000);
assert.equal(forecast.growthSampleCount, MAX_GROWTH_SAMPLES);
assert.equal(forecast.growthReserveBytes, 50000);
assert.equal(JSON.stringify(messages), before);
assert.equal(
  resolveContextGrowthBudget({ messages }, 1000000).growthReserveBytes,
  MAX_GROWTH_RESERVE_BYTES
);
const hostile = {
  toJSON() {
    throw new Error('must not serialize unknown content');
  },
};
assert.equal(
  resolveContextGrowthBudget(
    {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'a' }] },
        { role: 'tool', tool_call_id: 'a', content: hostile },
        { role: 'tool', tool_call_id: 'orphan', content: 'z'.repeat(100000) },
      ],
    },
    200000
  ).growthSampleCount,
  0
);
const small = resolveContextGrowthBudget(
  {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'a' }] },
      { role: 'tool', tool_call_id: 'a', content: 'quote " and newline\n'.repeat(1500) },
      { role: 'tool', tool_call_id: 'a', content: 'z'.repeat(100000) },
    ],
  },
  1000000
);
assert.equal(small.growthSampleCount, 1);
assert.ok(small.growthReserveBytes > 30000 && small.growthReserveBytes < 60000);

const parallelCalls = Array.from({ length: 12 }, (_, index) => ({ id: `parallel-${index}` }));
const parallelMessages = [
  { role: 'assistant', tool_calls: parallelCalls },
  ...parallelCalls.map((call) => ({
    role: 'tool',
    tool_call_id: call.id,
    content: 'x'.repeat(5000),
  })),
];
const parallel = resolveContextGrowthBudget({ messages: parallelMessages }, 200000);
assert.equal(
  parallel.growthSampleCount,
  1,
  'one completed parallel turn, not twelve unrelated samples'
);
assert.equal(
  parallel.growthReserveBytes,
  50000,
  'forecast aggregates all results from the same parallel turn'
);
assert.equal(
  resolveContextGrowthBudget({ messages: parallelMessages.slice(0, -1) }, 200000).growthSampleCount,
  0,
  'unfinished turns are not accepted growth evidence'
);
assert.equal(
  resolveContextGrowthBudget(
    {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'duplicate' }, { id: 'duplicate' }] },
        { role: 'tool', tool_call_id: 'duplicate', content: 'x' },
      ],
    },
    200000
  ).growthSampleCount,
  0
);
assert.equal(
  resolveContextGrowthBudget(
    {
      messages: [
        {
          role: 'assistant',
          tool_calls: Array.from({ length: 65 }, (_, index) => ({ id: `too-many-${index}` })),
        },
      ],
    },
    200000
  ).growthSampleCount,
  0
);
