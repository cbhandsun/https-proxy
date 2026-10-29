'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let expire,
    cleared = 0;
  const promise = waitForProxyFixtureReady(child, {
    setTimer: (callback, delay) => {
      assert.equal(delay, 15000);
      expire = callback;
      return 1;
    },
    clearTimer: () => {
      cleared++;
    },
  });
  const outcome = promise.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );
  return { child, outcome, expire: () => expire(), cleared: () => cleared };
}
async function main() {
  const entryFixture = fs.readFileSync(
    path.join(__dirname, 'entry-auth-integration.test.js'),
    'utf8'
  );
  assert.match(entryFixture, /require\('\.\/helpers\/proxy-fixture-ready'\)/);
  assert.match(entryFixture, /return waitForProxyFixtureReady\(proc\)/);
  assert.doesNotMatch(entryFixture, /text\.includes\('Mgmt:'\)/);
  for (let split = 0; split < 6; split++) {
    const f = fixture();
    const marker = 'Mgmt:';
    f.child.stdout.emit('data', Buffer.from(marker.slice(0, split)));
    f.child.stdout.emit('data', Buffer.from(marker.slice(split) + 'x'.repeat(8192)));
    assert.equal((await f.outcome).ok, true);
    assert.equal(f.cleared(), 1);
    for (const [emitter, event] of [
      [f.child, 'error'],
      [f.child, 'exit'],
      [f.child.stdout, 'data'],
    ])
      assert.equal(emitter.listenerCount(event), 0);
    f.expire();
    assert.equal(f.cleared(), 1);
  }
  const string = fixture();
  string.child.stdout.emit('data', 'Mgmt:' + 'SECRET'.repeat(20000));
  assert.equal((await string.outcome).ok, true);
  // Real startup output can coalesce the ready marker with later route logs.
  // Truncating the chunk before inspecting it used to lose that marker.
  const coalesced = fixture();
  coalesced.child.stdout.emit('data', Buffer.from('starting\n' + 'x'.repeat(8192)));
  coalesced.child.stdout.emit(
    'data',
    Buffer.from('entry ready\nMgmt: loopback\n' + 'route log\n'.repeat(2048))
  );
  assert.equal((await coalesced.outcome).ok, true);
  assert.equal(coalesced.child.stdout.listenerCount('data'), 0);
  assert.equal(coalesced.child.listenerCount('exit'), 0);
  coalesced.expire();
  assert.equal(coalesced.cleared(), 1);
  for (const action of [
    (f) => f.expire(),
    (f) => f.child.emit('error', new Error('SECRET')),
    (f) => f.child.emit('exit', 1),
    (f) => f.child.stdout.emit('data', null),
  ]) {
    const f = fixture();
    action(f);
    const result = await f.outcome;
    assert.equal(result.ok, false);
    assert.equal(result.error.message.includes('SECRET'), false);
    assert.equal(f.cleared(), 1);
    for (const [emitter, event] of [
      [f.child, 'error'],
      [f.child, 'exit'],
      [f.child.stdout, 'data'],
    ])
      assert.equal(emitter.listenerCount(event), 0, 'Failed startup must release listeners');
  }
  for (const [output, phase] of [
    ['', 'no_stdout'],
    ['SECRET startup banner', 'stdout_seen'],
    ['SECRET Certificate generated:', 'certificate_ready'],
  ]) {
    const f = fixture();
    f.child.stdout.emit('data', Buffer.from(output));
    f.expire();
    assert.equal((await f.outcome).error.message, 'Fixture startup deadline (' + phase + ')');
    assert.equal(f.child.stdout.listenerCount('data'), 0);
  }
  const timed = fixture();
  timed.child.stdout.emit('data', Buffer.from('SECRET Generating local CA signed certificate'));
  timed.expire();
  assert.equal(
    (await timed.outcome).error.message,
    'Fixture startup deadline (certificate_started)'
  );
  const stopped = new EventEmitter();
  stopped.stdout = new EventEmitter();
  stopped.exitCode = 0;
  await assert.rejects(waitForProxyFixtureReady(stopped), /Fixture stopped before startup/);
  assert.throws(() => waitForProxyFixtureReady(null), /Invalid proxy fixture readiness input/);
}
main().catch(() => {
  process.stderr.write('Proxy fixture readiness regression failed.\n');
  process.exitCode = 1;
});
