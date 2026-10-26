'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicationStartupProgress } = require('./helpers/publication-startup-progress.cjs');

test('publication startup observer exposes only validated production phases and elapsed time', () => {
  const progress = createPublicationStartupProgress();
  assert.deepEqual(progress.describe(), { phase: 'unobserved', elapsedMs: 0 });
  progress.observe({ phase: 'worker_started', elapsedMs: 0 });
  progress.observe({ phase: 'key_protect_started', elapsedMs: 15 });
  progress.observe({ phase: 'engine_prepare_started', elapsedMs: 20 });
  progress.observe({ phase: 'engine_anchor_validate_started', elapsedMs: 30 });
  progress.observe({ phase: 'engine_anchor_validate_finished', elapsedMs: 40 });
  progress.observe({ phase: 'engine_prepared', elapsedMs: 50 });
  progress.observe({ phase: 'engine_ready', elapsedMs: 5000 });
  progress.observe({ phase: 'ready', elapsedMs: 5000 });
  const snapshot = progress.describe();
  assert.deepEqual(snapshot, { phase: 'ready', elapsedMs: 5000 });
  snapshot.phase = 'PRIVATE';
  assert.equal(progress.describe().phase, 'ready');
  assert.throws(() => progress.observe({ phase: 'ready', elapsedMs: 5001 }));
  const failed = createPublicationStartupProgress();
  failed.observe({ phase: 'failed', elapsedMs: 60000 });
  assert.deepEqual(failed.describe(), { phase: 'failed', elapsedMs: 60000 });
});

test('publication startup observer rejects hostile, unknown, regressing and excessive progress without hooks', () => {
  let touched = 0;
  const accessor = Object.defineProperty({ elapsedMs: 0 }, 'phase', {
    enumerable: true,
    get() {
      touched++;
      return 'worker_started';
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        return [];
      },
    }
  );
  for (const input of [
    null,
    [],
    {},
    accessor,
    proxy,
    Object.assign(Object.create({}), { phase: 'worker_started', elapsedMs: 0 }),
    { phase: 'worker_started', elapsedMs: 0, [Symbol('PRIVATE')]: true },
    { phase: 'PRIVATE', elapsedMs: 0 },
    { phase: 'worker_started', elapsedMs: -1 },
    { phase: 'worker_started', elapsedMs: 0.5 },
    { phase: 'worker_started', elapsedMs: Infinity },
    { phase: 'worker_started', elapsedMs: 60001 },
    { phase: 'worker_started', elapsedMs: 0, private: 'PRIVATE' },
  ]) {
    assert.throws(() => createPublicationStartupProgress().observe(input));
  }
  assert.equal(touched, 0);
  const progress = createPublicationStartupProgress();
  progress.observe({ phase: 'paths_started', elapsedMs: 20 });
  assert.throws(() => progress.observe({ phase: 'worker_started', elapsedMs: 21 }));
  assert.throws(() => progress.observe({ phase: 'paths_ready', elapsedMs: 19 }));
  assert.deepEqual(progress.describe(), { phase: 'paths_started', elapsedMs: 20 });
});

test('startup timeout timeline contains only accepted phase samples and detached bounded snapshots', () => {
  const progress = createPublicationStartupProgress();
  assert.deepEqual(progress.snapshot(), []);
  progress.observe({ phase: 'worker_started', elapsedMs: 30 });
  progress.observe({ phase: 'paths_started', elapsedMs: 35 });
  progress.observe({ phase: 'engine_ready', elapsedMs: 3400 });
  progress.observe({ phase: 'ready', elapsedMs: 3417 });
  const expected = [
    { phase: 'worker_started', elapsedMs: 30 },
    { phase: 'paths_started', elapsedMs: 35 },
    { phase: 'engine_ready', elapsedMs: 3400 },
    { phase: 'ready', elapsedMs: 3417 },
  ];
  assert.deepEqual(progress.snapshot(), expected);
  const snapshot = progress.snapshot();
  snapshot[0].phase = 'PRIVATE';
  snapshot.push({ private: 'PRIVATE' });
  for (let i = 0; i < 100; i++)
    assert.throws(() => progress.observe({ phase: 'PRIVATE', elapsedMs: 3418 }));
  assert.deepEqual(progress.snapshot(), expected);
  assert.equal(JSON.stringify(progress.snapshot()).includes('PRIVATE'), false);
});
