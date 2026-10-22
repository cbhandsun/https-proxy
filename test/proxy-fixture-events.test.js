'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const {
  installFixtureEventFlush,
  waitForFixtureEventFlush,
} = require('./helpers/proxy-fixture-events');

function channel() {
  const value = new EventEmitter();
  value.connected = true;
  value.sent = [];
  value.send = (message) => value.sent.push(message);
  return value;
}

test('acknowledges only after every actual diagnostics queue has flushed', async () => {
  const peer = channel();
  const releases = [];
  const diagnostics = {
    createDiagnostics: () => {
      const pending = new Promise((resolve) => {
        releases.push(resolve);
      });
      return { flushJsonlWrites: () => pending };
    },
  };
  installFixtureEventFlush(diagnostics, peer);
  diagnostics.createDiagnostics();
  diagnostics.createDiagnostics();
  peer.emit('message', 'unrelated');
  peer.emit('message', 'hpm_fixture_flush_events');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(peer.sent, []);
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(peer.sent, []);
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(peer.sent, ['hpm_fixture_events_flushed']);
});

test('unavailable or failed queues return fixed failure without exception content', async () => {
  for (const empty of [true, false]) {
    const peer = channel();
    const diagnostics = {
      createDiagnostics: () => ({
        flushJsonlWrites: async () => {
          throw new Error('SECRET');
        },
      }),
    };
    installFixtureEventFlush(diagnostics, peer);
    if (!empty) diagnostics.createDiagnostics();
    peer.emit('message', 'hpm_fixture_flush_events');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(peer.sent, ['hpm_fixture_events_failed']);
  }
  assert.throws(() => installFixtureEventFlush({}), TypeError);
  const diagnostics = { createDiagnostics: () => ({}) };
  installFixtureEventFlush(diagnostics, channel());
  assert.throws(() => diagnostics.createDiagnostics(), TypeError);
});

test('parent requires acknowledgement and cleans all listeners on success and failures', async () => {
  for (const outcome of [
    'success',
    'failure',
    'error',
    'exit',
    'disconnect',
    'timeout',
    'send_error',
    'send_throw',
  ]) {
    const child = channel();
    let timeout;
    let cleared = false;
    if (outcome === 'send_error')
      child.send = (_message, callback) => callback(new Error('SECRET'));
    if (outcome === 'send_throw')
      child.send = () => {
        throw new Error('SECRET');
      };
    const waiting = waitForFixtureEventFlush(child, {
      setTimer: (callback, milliseconds) => {
        assert.equal(milliseconds, 10000);
        timeout = callback;
        return 1;
      },
      clearTimer: (value) => {
        assert.equal(value, 1);
        cleared = true;
      },
    });
    child.emit('message', 'unrelated');
    if (outcome === 'success') child.emit('message', 'hpm_fixture_events_flushed');
    else if (outcome === 'failure') child.emit('message', 'hpm_fixture_events_failed');
    else if (outcome === 'timeout') timeout();
    else if (!outcome.startsWith('send_')) child.emit(outcome, new Error('SECRET'));
    if (outcome === 'success') await waiting;
    else await assert.rejects(waiting, (error) => !error.message.includes('SECRET'));
    assert.equal(cleared, true);
    for (const name of ['message', 'error', 'exit', 'disconnect'])
      assert.equal(child.listenerCount(name), 0);
  }
  const disconnected = channel();
  disconnected.connected = false;
  await assert.rejects(waitForFixtureEventFlush(disconnected), /unavailable/);
  assert.throws(() => waitForFixtureEventFlush({}), TypeError);
});
