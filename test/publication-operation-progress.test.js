'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPublicationOperationProgress,
  observePublicationOperations,
} = require('./helpers/publication-operation-progress.cjs');
const sample = (sequence = 1, status = 'started', elapsedMs = 0) => ({
  sequence,
  operation: 'save-reference-state',
  status,
  elapsedMs,
});

test('publication preparation identifies pending operations after startup without claiming completion', () => {
  const progress = createPublicationOperationProgress();
  assert.equal(progress.describe(), null);
  assert.deepEqual(progress.snapshot(), []);
  progress.observe(sample());
  assert.equal(progress.describe().status, 'started');
  progress.observe(sample(1, 'completed', 240));
  progress.observe({ ...sample(2, 'started', 241), operation: 'settle-reader' });
  const expected = { ...sample(2, 'started', 241), operation: 'settle-reader' };
  assert.deepEqual(progress.describe(), expected);
  progress.describe().operation = 'PRIVATE';
  progress.snapshot()[0].operation = 'PRIVATE';
  assert.deepEqual(progress.describe(), expected);
  assert.equal(JSON.stringify(progress.snapshot()).includes('PRIVATE'), false);
});

test('publication operation order and per-call failure cannot manufacture an ACK', () => {
  for (const wrong of [sample(2), sample(1, 'completed'), sample(1, 'failed')])
    assert.throws(() => createPublicationOperationProgress().observe(wrong));
  const progress = createPublicationOperationProgress();
  progress.observe(sample());
  for (const wrong of [sample(), sample(3), { ...sample(1, 'completed'), operation: 'load' }])
    assert.throws(() => progress.observe(wrong));
  progress.observe(sample(1, 'failed', 5));
  assert.throws(() => progress.observe(sample(1, 'completed', 6)));
  assert.equal(progress.describe().status, 'failed');
  progress.observe(sample(2, 'started', 6));
  assert.equal(progress.describe().status, 'started');
});

test('publication observation retains overlapping queued operations without adding serialization', () => {
  const progress = createPublicationOperationProgress();
  progress.observe(sample());
  progress.observe({ ...sample(2), operation: 'load' });
  progress.observe(sample(1, 'completed', 4));
  progress.observe({ ...sample(2, 'completed', 5), operation: 'load' });
  assert.deepEqual(
    progress.snapshot().map((value) => [value.sequence, value.status]),
    [
      [1, 'started'],
      [2, 'started'],
      [1, 'completed'],
      [2, 'completed'],
    ]
  );
});

test('publication operation history is bounded and rejects extreme or regressing sequences and clocks', () => {
  const progress = createPublicationOperationProgress();
  for (let sequence = 1; sequence <= 128; sequence++) {
    progress.observe(sample(sequence, 'started', sequence * 2));
    progress.observe(sample(sequence, 'completed', sequence * 2 + 1));
  }
  assert.equal(progress.snapshot().length, 16);
  assert.equal(progress.snapshot()[0].sequence, 121);
  assert.throws(() => progress.observe(sample(129, 'started', 258)));
  for (const value of [-1, 0.5, Infinity, NaN, 60001])
    assert.throws(() => createPublicationOperationProgress().observe(sample(1, 'started', value)));
  const edge = createPublicationOperationProgress();
  edge.observe(sample(1, 'started', 60000));
  assert.throws(() => edge.observe(sample(1, 'completed', 59999)));
  edge.observe(sample(1, 'completed', 60000));
});

test('publication operation parser rejects private fields and executable input without invoking hooks', () => {
  let hooks = 0;
  const getter = Object.defineProperty(sample(), 'operation', {
    enumerable: true,
    get() {
      hooks++;
      return 'load';
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        hooks++;
        return [];
      },
    }
  );
  for (const input of [
    null,
    [],
    {},
    proxy,
    getter,
    Object.assign(Object.create({}), sample()),
    { ...sample(), private: 'PRIVATE' },
    { ...sample(), [Symbol('PRIVATE')]: 1 },
    { ...sample(), operation: 'PRIVATE' },
    { ...sample(), operation: {} },
    { ...sample(), status: 'acknowledged' },
    { ...sample(), sequence: 0 },
    { ...sample(), sequence: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => createPublicationOperationProgress().observe(input), {
      message: 'publication_operation_progress_invalid',
    });
  assert.equal(hooks, 0);
});

test('operation observer reports a pending real Promise and forwards the original request and result once', async () => {
  const samples = [];
  const request = { operation: 'save-reference-state', payload: 'PRIVATE' };
  const result = { revision: 4 };
  let finish,
    calls = 0,
    time = 10;
  const observed = observePublicationOperations(
    (input) => {
      calls++;
      assert.equal(input, request);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    (value) => samples.push(value),
    () => time
  );
  const pending = observed(request);
  assert.deepEqual(samples, [sample()]);
  time = 27;
  finish(result);
  assert.equal(await pending, result);
  assert.deepEqual(samples, [sample(), sample(1, 'completed', 17)]);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(samples).includes('PRIVATE'), false);
});

test('operation observer preserves a failed execute and a failed observer independently without retry', async () => {
  const primary = new Error('PRIVATE');
  const observation = new Error('PRIVATE_OBSERVER');
  for (const callbackFails of [false, true]) {
    let calls = 0;
    const samples = [];
    const observed = observePublicationOperations(
      () => {
        calls++;
        throw primary;
      },
      (value) => {
        samples.push(value);
        if (callbackFails && value.status === 'failed') throw observation;
      },
      () => 0
    );
    await assert.rejects(observed({ operation: 'load' }), (error) => {
      if (callbackFails) assert.deepEqual(error.errors, [primary, observation]);
      else assert.equal(error, primary);
      return true;
    });
    assert.deepEqual(
      samples.map((value) => value.status),
      ['started', 'failed']
    );
    assert.equal(JSON.stringify(samples).includes('PRIVATE'), false);
    assert.equal(calls, 1);
  }
});

test('operation observer refuses executable metadata, invalid clocks and report failure before execution', async () => {
  let calls = 0,
    hooks = 0;
  const execute = () => {
    calls++;
  };
  const getter = Object.defineProperty({}, 'operation', {
    enumerable: true,
    get() {
      hooks++;
      return 'load';
    },
  });
  for (const input of [
    null,
    {},
    getter,
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          hooks++;
        },
      }
    ),
    { operation: 'PRIVATE' },
  ])
    await assert.rejects(
      observePublicationOperations(
        execute,
        () => {},
        () => 0
      )(input)
    );
  for (const clock of [NaN, Infinity, -1])
    assert.throws(() =>
      observePublicationOperations(
        execute,
        () => {},
        () => clock
      )
    );
  let time = 0;
  const observed = observePublicationOperations(
    execute,
    () => {},
    () => time
  );
  time = Infinity;
  await assert.rejects(observed({ operation: 'load' }));
  await assert.rejects(
    observePublicationOperations(
      execute,
      () => {
        throw new Error('report failed');
      },
      () => 0
    )({ operation: 'load' })
  );
  assert.equal(calls, 0);
  assert.equal(hooks, 0);
});
