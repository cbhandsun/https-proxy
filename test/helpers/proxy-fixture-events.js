'use strict';

const FLUSH = 'hpm_fixture_flush_events';
const DONE = 'hpm_fixture_events_flushed';
const FAILED = 'hpm_fixture_events_failed';

// Test-only IPC barrier. Never install this listener in the production runtime.
function installFixtureEventFlush(diagnostics, channel = process) {
  if (
    typeof diagnostics?.createDiagnostics !== 'function' ||
    typeof channel?.on !== 'function' ||
    typeof channel?.send !== 'function'
  )
    throw new TypeError('Invalid fixture diagnostics channel');
  const original = diagnostics.createDiagnostics;
  const instances = [];
  diagnostics.createDiagnostics = function (...args) {
    const instance = Reflect.apply(original, this, args);
    if (typeof instance?.flushJsonlWrites !== 'function')
      throw new TypeError('Fixture diagnostics cannot confirm persistence');
    instances.push(instance);
    return instance;
  };
  channel.on('message', (message) => {
    if (message !== FLUSH) return;
    Promise.resolve()
      .then(async () => {
        if (!instances.length) throw new Error('Fixture diagnostics unavailable');
        await Promise.all(instances.map((instance) => instance.flushJsonlWrites()));
      })
      .then(
        () => channel.send(DONE),
        () => channel.send(FAILED)
      );
  });
}

function waitForFixtureEventFlush(
  child,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  if (
    typeof child?.on !== 'function' ||
    typeof child?.removeListener !== 'function' ||
    typeof child?.send !== 'function' ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function'
  )
    throw new TypeError('Invalid fixture event flush input');
  if (!child.connected) return Promise.reject(new Error('Fixture event channel unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      for (const [name, listener] of listeners) child.removeListener(name, listener);
      if (error) reject(new Error(error));
      else resolve();
    };
    const listeners = [
      [
        'message',
        (message) => {
          if (message === DONE) finish();
          else if (message === FAILED) finish('Fixture diagnostics persistence failed');
        },
      ],
      ['error', () => finish('Fixture event channel failed')],
      ['exit', () => finish('Fixture stopped before persistence confirmation')],
      ['disconnect', () => finish('Fixture event channel disconnected')],
    ];
    for (const [name, listener] of listeners) child.on(name, listener);
    const timer = setTimer(() => finish('Fixture event flush deadline'), 10000);
    try {
      child.send(FLUSH, (error) => {
        if (error) finish('Fixture event channel failed');
      });
    } catch {
      finish('Fixture event channel failed');
    }
  });
}

module.exports = { installFixtureEventFlush, waitForFixtureEventFlush };
