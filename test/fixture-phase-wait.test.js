'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForFixtureSignal: wait } = require('./helpers/fixture-phase-wait.cjs');
for (const signal of ['message', 'exit', 'error'])
  test('fixture phase event wait wakes and detaches on ' + signal, async () => {
    const child = new EventEmitter();
    const original = () => {};
    child.on('message', original);
    const pending = wait(child, 5000);
    assert.equal(child.listenerCount('message'), 2);
    assert.equal(child.listenerCount('exit'), 1);
    assert.equal(child.listenerCount('error'), 1);
    child.emit(signal, new Error('PRIVATE_PAYLOAD'));
    assert.equal(await pending, signal);
    assert.deepEqual(child.listeners('message'), [original]);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });
test('deadline and already elapsed budget retain no lifecycle listeners', async () => {
  for (const delay of [0, 1]) {
    const child = new EventEmitter();
    assert.equal(await wait(child, delay), 'deadline');
    assert.deepEqual(child.eventNames(), []);
  }
});
test('invalid budgets and proxy children fail without reading proxy hooks', () => {
  const child = new EventEmitter();
  for (const delay of [null, undefined, '1', NaN, Infinity, -1, 5001])
    assert.throws(() => wait(child, delay), /fixture_phase_wait_invalid/);
  let touched = 0;
  const proxy = new Proxy(child, {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const value of [null, {}, proxy])
    assert.throws(() => wait(value, 1), /fixture_phase_wait_invalid/);
  assert.equal(touched, 0);
  assert.deepEqual(child.eventNames(), []);
});
test('partially installed event observers are removed if setup fails', async () => {
  const child = new EventEmitter();
  const once = child.once;
  child.once = function (name, callback) {
    if (name === 'exit') throw Error('PRIVATE');
    return Reflect.apply(once, this, [name, callback]);
  };
  await assert.rejects(wait(child, 5000), { message: 'fixture_phase_wait_failed' });
  assert.deepEqual(child.eventNames(), []);
});

test('a lifecycle event during listener setup cannot leave a later observer attached', async () => {
  const child = new EventEmitter();
  const duringSetup = (name) => {
    if (name === 'exit') child.emit('message', { private: 'PRIVATE' });
  };
  child.on('newListener', duringSetup);
  assert.equal(await wait(child, 5000), 'message');
  assert.deepEqual(child.eventNames(), ['newListener']);
  assert.deepEqual(child.listeners('newListener'), [duringSetup]);
});
