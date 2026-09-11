'use strict';

const assert = require('assert');
const {
  ImageJobStoreError,
  createImageJobStore,
  imageJobErrorFromUnknown,
} = require('../lib/proxy/image-jobs');

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  let currentTime = 1_000_000;
  let idCounter = 0;
  const scheduled = [];
  const transitions = [];
  const controls = new Map();
  const store = createImageJobStore({
    now: () => currentTime,
    idFactory: () => `imgjob_${String(++idCounter).padStart(32, '0')}`,
    schedule: (callback) => scheduled.push(callback),
    maxJobs: 3,
    maxQueued: 2,
    maxConcurrent: 1,
    ttlMs: 60_000,
    onTransition: (job) => transitions.push(`${job.id}:${job.status}`),
  });
  const runScheduled = () => {
    while (scheduled.length) scheduled.shift()();
  };

  const first = store.create({
    owner: 'entry-key:a',
    run({ id, signal }) {
      return new Promise((resolve, reject) => {
        controls.set(id, { resolve, reject, signal });
      });
    },
  });
  const second = store.create({
    owner: 'entry-key:a',
    run: async () => ({ created: 2, data: [{ b64_json: 'second' }] }),
  });
  assert.strictEqual(first.status, 'queued');
  assert.strictEqual(second.status, 'queued');
  assert.strictEqual(store.get(first.id, 'entry-key:b'), null);
  assert.strictEqual(store.get('imgjob_invalid', 'entry-key:a'), null);

  runScheduled();
  await flushPromises();
  assert.strictEqual(store.get(first.id, 'entry-key:a').status, 'in_progress');
  assert.strictEqual(store.get(second.id, 'entry-key:a').status, 'queued');

  const cancelled = store.cancel(second.id, 'entry-key:a');
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(store.cancel(second.id, 'entry-key:a').status, 'cancelled');

  controls.get(first.id).resolve({ created: 1, data: [{ b64_json: 'first' }] });
  await flushPromises();
  runScheduled();
  await flushPromises();
  const completed = store.get(first.id, 'entry-key:a');
  assert.strictEqual(completed.status, 'completed');
  assert.deepStrictEqual(completed.result, {
    created: 1,
    data: [{ b64_json: 'first' }],
  });
  assert.ok(completed.completed_at >= completed.started_at);
  assert.ok(transitions.includes(`${first.id}:in_progress`));
  assert.ok(transitions.includes(`${first.id}:completed`));

  const failed = store.create({
    owner: 'entry-key:a',
    run: async () => {
      const error = new Error('internal secret must not escape');
      error.publicError = {
        type: 'upstream_error\nunsafe',
        message: 'Safe public failure.\nSecond line.',
        status: 502,
      };
      throw error;
    },
  });
  runScheduled();
  await flushPromises();
  await flushPromises();
  const failedStatus = store.get(failed.id, 'entry-key:a');
  assert.strictEqual(failedStatus.status, 'failed');
  assert.deepStrictEqual(failedStatus.error, {
    type: 'upstream_errorunsafe',
    message: 'Safe public failure. Second line.',
    status: 502,
  });
  assert.ok(!JSON.stringify(failedStatus).includes('internal secret'));

  currentTime += 61_000;
  store.cleanupExpired();
  assert.strictEqual(store.get(first.id, 'entry-key:a'), null);
  assert.strictEqual(store.get(second.id, 'entry-key:a'), null);
  assert.strictEqual(store.get(failed.id, 'entry-key:a'), null);

  const abortStoreSchedule = [];
  const abortStore = createImageJobStore({
    idFactory: () => 'imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schedule: (callback) => abortStoreSchedule.push(callback),
    maxConcurrent: 1,
  });
  let observedAbort = false;
  const running = abortStore.create({
    owner: 'entry-key:a',
    run: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('cancelled internally'));
        });
      }),
  });
  abortStoreSchedule.shift()();
  await flushPromises();
  assert.strictEqual(abortStore.cancel(running.id, 'entry-key:a').status, 'cancelled');
  await flushPromises();
  assert.strictEqual(observedAbort, true);
  assert.strictEqual(abortStore.get(running.id, 'entry-key:a').status, 'cancelled');

  const fullStore = createImageJobStore({
    idFactory: (() => {
      let count = 10;
      return () => `imgjob_${String(++count).padStart(32, '0')}`;
    })(),
    schedule: () => {},
    maxJobs: 2,
    maxQueued: 1,
  });
  fullStore.create({ owner: 'entry-key:a', run: async () => ({}) });
  assert.throws(
    () => fullStore.create({ owner: 'entry-key:a', run: async () => ({}) }),
    (error) => error instanceof ImageJobStoreError && error.code === 'queue_full'
  );
  assert.throws(
    () => createImageJobStore().create({ owner: '', run: async () => ({}) }),
    (error) => error instanceof ImageJobStoreError && error.code === 'invalid_owner'
  );
  assert.deepStrictEqual(imageJobErrorFromUnknown(new Error('secret')), {
    type: 'image_generation_failed',
    message: 'Image generation failed.',
  });
  assert.deepStrictEqual(
    imageJobErrorFromUnknown({
      publicError: {
        type: 'bad type\r\n',
        message: 'safe\r\nmessage',
        status: 200,
        retry_after: 999_999,
      },
    }),
    {
      type: 'badtype',
      message: 'safe message',
    }
  );

  console.log('[image-jobs.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
