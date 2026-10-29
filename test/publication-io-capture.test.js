'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installPublicationIoCapture,
  installNativePublicationIoCapture,
} = require('./helpers/publication-io-capture.cjs');

test('native publication observation selects its own window without altering a fixture result or failure', async () => {
  const failure = Error('PRIVATE'),
    result = {};
  let calls = 0,
    stops = 0;
  const run = installNativePublicationIoCapture({}, (_, options) => {
    assert.equal(options.windowId, 'native-publication-interruption');
    options.onReady(() => {
      stops++;
    });
  });
  assert.equal(
    await run(() => {
      calls++;
      return result;
    }),
    result
  );
  assert.equal(stops, 0);
  await assert.rejects(
    run(() => {
      calls++;
      throw failure;
    }),
    (error) => error === failure
  );
  assert.equal(calls, 2);
  assert.equal(stops, 1);
});

test('publication recording composes one unchanged fixture and does not stop on success', async () => {
  const host = {},
    result = {};
  let calls = 0,
    stops = 0;
  const run = installPublicationIoCapture(host, (actual, options) => {
    assert.equal(actual, host);
    assert.equal(options.windowId, 'publication-graceful-http');
    options.onReady(() => {
      stops++;
    });
  });
  assert.equal(
    await run(() => {
      calls++;
      return result;
    }),
    result
  );
  assert.equal(
    await run(async () => {
      calls++;
      return result;
    }),
    result
  );
  assert.equal(calls, 2);
  assert.equal(stops, 0);
});

test('publication failure is preserved with capture disabled, enabled and already stopped', async () => {
  const failure = Error('PRIVATE');
  for (const enabled of [false, true]) {
    let stops = 0,
      calls = 0;
    const run = installPublicationIoCapture({}, (_, options) => {
      if (enabled)
        options.onReady(() => {
          stops++;
          return stops === 1;
        });
    });
    for (const operation of [
      () => {
        calls++;
        throw failure;
      },
      async () => {
        calls++;
        throw failure;
      },
    ])
      await assert.rejects(run(operation), (error) => error === failure);
    assert.equal(calls, 2);
    assert.equal(stops, enabled ? 2 : 0);
  }
});

test('a failed recording control retains both failures and never repeats the fixture', async () => {
  const original = Error('PRIVATE'),
    recording = Error('PRIVATE');
  let calls = 0;
  const run = installPublicationIoCapture({}, (_, options) => {
    options.onReady(() => {
      throw recording;
    });
  });
  await assert.rejects(
    run(() => {
      calls++;
      throw original;
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, recording]);
      assert.equal(error.message, 'publication_and_capture_failed');
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('publication composition rejects invalid capabilities without executing hostile hooks', async () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('PRIVATE');
  };
  for (const input of [null, {}, '', async () => {}, new Proxy(() => {}, { apply: trap })])
    assert.throws(() => installPublicationIoCapture({}, input), /publication_io_capture_invalid/);
  let ready;
  const run = installPublicationIoCapture({}, (_, options) => {
    ready = options.onReady;
  });
  for (const input of [null, {}, '', async () => {}, new Proxy(() => {}, { apply: trap })])
    assert.throws(() => ready(input), /publication_io_capture_invalid/);
  for (const input of [null, {}, '', new Proxy(() => {}, { apply: trap })])
    await assert.rejects(run(input), /publication_io_capture_invalid/);
  assert.equal(hooks, 0);
});

test('plain publication interruption owns only its selected window and retains the original failure', async () => {
  const { installSqlPublicationIoCapture } = require('./helpers/publication-io-capture.cjs');
  let stopped = 0;
  const observe = installSqlPublicationIoCapture({}, (_test, options) => {
    assert.equal(options.windowId, 'publication-interruption');
    options.onReady(() => {
      stopped++;
    });
  });
  assert.equal(await observe(async () => 'completed'), 'completed');
  assert.equal(stopped, 0);
  const error = new Error('synthetic_publication_failed');
  await assert.rejects(
    observe(async () => {
      throw error;
    }),
    (value) => value === error
  );
  assert.equal(stopped, 1);
});
