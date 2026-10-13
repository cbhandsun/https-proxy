'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeCompactionObserver: create,
} = require('../scripts/lib/native-compaction-observer');

const checkpoint = {
  type: 'compaction',
  encrypted_content: 'native-synthetic-fixture',
  future: { intact: '汉🙂' },
};
const item = (value = checkpoint) => ({ type: 'response.output_item.done', item: value });
const completed = (output) => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    ...(output === undefined ? {} : { output }),
  },
});

test('native item events qualify without mandatory terminal aggregate output', () => {
  for (const output of [undefined, [], [checkpoint], [{ type: 'message' }, checkpoint]]) {
    const observer = create();
    observer.observe(item());
    assert.equal(observer.getCheckpoint(), null);
    observer.observe(completed(output));
    assert.deepEqual(observer.finish(), {
      valid: true,
      doneCount: 1,
      completedCount: 1,
      failureCode: null,
    });
    const result = observer.getCheckpoint();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), checkpoint);
    result.future.intact = 'mutated';
    assert.deepEqual(JSON.parse(JSON.stringify(observer.getCheckpoint())), checkpoint);
  }
});

test('known native serde alias stays opaque, non-native items cannot qualify', () => {
  const observer = create();
  observer.observe(item({ ...checkpoint, type: 'compaction_summary' }));
  observer.observe(completed());
  assert.equal(observer.finish().valid, true);
  assert.equal(observer.getCheckpoint().type, 'compaction_summary');
  for (const value of [null, {}, { type: 'message' }, { type: 'contextCompaction' }]) {
    const invalid = create();
    invalid.observe(item(value));
    invalid.observe(completed([checkpoint]));
    assert.equal(invalid.finish().valid, false);
    assert.equal(invalid.getCheckpoint(), null);
  }
});

test('missing, duplicate, inconsistent, incomplete or out-of-order events fail closed', () => {
  for (const sequence of [
    [],
    [item()],
    [completed([checkpoint])],
    [item(), item(), completed()],
    [item(), completed(), completed()],
    [completed(), item()],
    [item(), completed([{ ...checkpoint, encrypted_content: 'different' }])],
    [item(), completed([checkpoint, checkpoint])],
    [item(), completed({})],
    [item(), { type: 'response.completed', response: { status: 'incomplete' } }],
    [item(), { type: 'response.completed', response: { error: {} } }],
    [item(), { type: 'response.failed' }],
    [item(), { type: 'response.incomplete' }],
    [item(), completed(), { type: 'error' }],
  ]) {
    const observer = create();
    sequence.forEach(observer.observe);
    assert.equal(observer.finish().valid, false);
    assert.equal(observer.getCheckpoint(), null);
  }
  const observer = create();
  observer.observe(item());
  observer.observe(completed());
  observer.finish();
  observer.observe(item());
  assert.equal(observer.getCheckpoint(), null);
});

test('empty, local, oversized, unsafe and accessor inputs cannot leak or invoke code', () => {
  for (const value of [
    undefined,
    null,
    42,
    {},
    [],
    item({ ...checkpoint, encrypted_content: '' }),
    item({ ...checkpoint, encrypted_content: 42 }),
    item({ ...checkpoint, encrypted_content: 'hpm-local-compaction-v1:fixture' }),
    item({ ...checkpoint, encrypted_content: 'ccswitch-fixture' }),
  ]) {
    const observer = create();
    observer.observe(value);
    observer.observe(completed());
    assert.equal(observer.finish().valid, false);
    assert.equal(observer.getCheckpoint(), null);
  }
  const small = create({ maxBytes: 16 });
  small.observe(item());
  assert.equal(small.finish().valid, false);
  let invoked = 0;
  const getter = {
    get type() {
      invoked++;
      return 'response.completed';
    },
  };
  const observer = create();
  observer.observe(getter);
  assert.equal(observer.finish().valid, false);
  assert.equal(invoked, 0);
  const cycle = { type: 'response.created' };
  cycle.self = cycle;
  const cyclic = create();
  cyclic.observe(cycle);
  assert.equal(cyclic.finish().valid, false);
  for (const maxBytes of [0, -1, NaN, Infinity, '100', 16777217])
    assert.throws(() => create({ maxBytes }), /Invalid native compaction observation limit/);
  assert.equal(JSON.stringify(observer.finish()).includes('native-synthetic-fixture'), false);
});
