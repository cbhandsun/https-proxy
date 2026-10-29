'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { fixtureTag } = require('../scripts/lib/persistent-io-association');
const filename = path.join(__dirname, 'helpers/context-recovery-publication-interruption.cjs');
const originalRequire = createRequire(filename);

function loadFixture(t, pid, tagOverride, controls = {}) {
  let time = 0;
  const waits = [];
  const children = [];
  const created = [];
  const removed = [];
  let getterCalls = 0;
  let requestsDestroyed = 0;
  const files = {
    ...fs,
    mkdtempSync(...args) {
      const directory = fs.mkdtempSync(...args);
      created.push(directory);
      return directory;
    },
    rmSync(...args) {
      removed.push(args[0]);
      return fs.rmSync(...args);
    },
  };
  t.after(() => {
    for (const directory of created) fs.rmSync(directory, { recursive: true, force: true });
  });
  const customRequire = (name) => {
    if (name === 'node:fs') return files;
    if (name === 'node:perf_hooks') return { performance: { now: () => time } };
    if (name === 'node:http' && controls.requests)
      return {
        get(options) {
          controls.requests.push(options);
          const request = new EventEmitter();
          request.destroy = () => {
            requestsDestroyed++;
          };
          return request;
        },
      };
    if (name === 'node:child_process')
      return {
        fork(entry, args, options) {
          assert.equal(
            entry,
            path.join(path.dirname(filename), 'context-recovery-publication-child.cjs')
          );
          assert.deepEqual(args, []);
          assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
          const child = new EventEmitter();
          Object.defineProperty(
            child,
            'pid',
            pid === 'getter'
              ? {
                  get() {
                    getterCalls++;
                    throw Error('PRIVATE_PID_GETTER');
                  },
                }
              : { value: pid }
          );
          child.exitCode = null;
          child.signalCode = null;
          child.stdout = new EventEmitter();
          child.stderr = { resume() {} };
          child.operations = [];
          child.kills = [];
          child.send = (input) => {
            child.operations.push(input.operation);
            if (input.operation === 'initialize') {
              assert.equal(input.native, true);
              assert.equal(Object.hasOwn(input, 'key'), false);
              child.emit('message', { phase: controls.failed ? 'failed' : 'native-opened' });
            }
          };
          child.kill = (signal) => {
            child.kills.push(signal);
            if (controls.cleanupFailed) throw Error('fixture_owned_cleanup_failed');
            child.signalCode = signal;
            child.emit('exit', null, signal);
            return true;
          };
          children.push(child);
          return child;
        },
      };
    if (name === './fixture-phase-wait.cjs')
      return {
        waitForFixtureSignal: async (child, remaining) => {
          waits.push(remaining);
          time += Math.min(remaining, controls.stepMs ?? remaining);
          if (controls.readyAfter && time >= controls.readyAfter && child.operations.length === 1)
            child.emit('message', { phase: 'ready', port: 12345 });
          else if (controls.pulse) child.emit('message', { phase: 'unrelated' });
        },
      };
    if (name === './publication-runtime.cjs') return { publicationModule: () => ({}) };
    if (name === '../../scripts/lib/persistent-io-association')
      return {
        fixtureTag: tagOverride === undefined ? fixtureTag : () => tagOverride,
      };
    return originalRequire(name);
  };
  const module = { exports: {} };
  const script = new vm.Script(
    '(function(require,module,exports,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})',
    { filename }
  );
  script.runInThisContext()(customRequire, module, module.exports, path.dirname(filename));
  return {
    invoke(options = {}) {
      return module.exports.publicationInterruption({
        transition: 'withdrawn',
        boundary: 'ack',
        kill: true,
        native: true,
        ...options,
      });
    },
    state: () => ({ time, waits, children, created, removed, requestsDestroyed }),
    async run() {
      let failure;
      await assert.rejects(
        module.exports.publicationInterruption({
          transition: 'withdrawn',
          boundary: 'ack',
          kill: true,
          native: true,
        }),
        (error) => {
          failure = error;
          return true;
        }
      );
      assert.match(
        failure.message,
        /fixture preparation deadline exceeded \(awaiting=ready;budgetMs=30000;lastFixture=native-opened;/
      );
      assert.deepEqual(waits, Array(6).fill(5000));
      assert.equal(time, 30000);
      assert.equal(children.length, 1);
      assert.deepEqual(children[0].operations, ['initialize']);
      assert.deepEqual(children[0].kills, ['SIGKILL']);
      assert.deepEqual(removed, created);
      assert.equal(fs.existsSync(created[0]), false);
      const match = /;fixtureIdentity=(\{[^\n]*\})\)$/.exec(failure.message);
      assert.ok(match, 'the original timeout must include its own bounded fixture identity');
      const identity = JSON.parse(match[1]);
      assert.deepEqual(Object.keys(identity), ['ownerProcessId', 'fixtureTag']);
      assert.ok(Buffer.byteLength(match[1]) <= 128);
      assert.doesNotMatch(match[1], /PRIVATE|checkpoint|hpm-publication-interior|[\\/]/);
      return { identity, directory: created[0], failure };
    },
    getterCalls: () => getterCalls,
  };
}

test('two preparation deadlines retain distinct child PID/tag at aligned 30s budgets and cleanup', async (t) => {
  const first = await loadFixture(t, 5172).run();
  const second = await loadFixture(t, 6744).run();
  assert.equal(first.identity.ownerProcessId, 5172);
  assert.equal(second.identity.ownerProcessId, 6744);
  assert.equal(
    first.identity.fixtureTag,
    fixtureTag(path.join(first.directory, 'checkpoint.sqlite'))
  );
  assert.equal(
    second.identity.fixtureTag,
    fixtureTag(path.join(second.directory, 'checkpoint.sqlite'))
  );
  assert.notEqual(first.identity.fixtureTag, second.identity.fixtureTag);
});

test('ready after the former 5s limit advances within 30s, then interruption target still expires after 5s', async (t) => {
  const fixture = loadFixture(t, 42, undefined, { readyAfter: 12000 });
  await assert.rejects(
    fixture.invoke(),
    /fixture interruption deadline exceeded \(awaiting=commit-durable;budgetMs=5000;/
  );
  const state = fixture.state();
  assert.deepEqual(state.waits, [5000, 5000, 5000, 5000]);
  assert.equal(state.time, 20000);
  assert.deepEqual(state.children[0].operations, ['initialize', 'advance']);
  assert.deepEqual(state.children[0].kills, ['SIGKILL']);
  assert.deepEqual(state.removed, state.created);
});

test('preparation signals cannot reset the absolute 30s deadline', async (t) => {
  const fixture = loadFixture(t, 42, undefined, { pulse: true, stepMs: 3000 });
  await assert.rejects(fixture.invoke(), /fixture preparation deadline exceeded .*budgetMs=30000;/);
  const state = fixture.state();
  assert.equal(state.time, 30000);
  assert.equal(state.waits.length, 10);
  assert.deepEqual(state.children[0].operations, ['initialize']);
  assert.deepEqual(state.removed, state.created);
});

test('HTTP starts only after ready and retains its own 5000ms AbortSignal plus request cleanup', async (t) => {
  const budgets = [],
    requests = [];
  const signal = new globalThis.AbortController().signal;
  t.mock.method(globalThis.AbortSignal, 'timeout', (budget) => {
    budgets.push(budget);
    return signal;
  });
  const fixture = loadFixture(t, 42, undefined, { readyAfter: 12000, requests });
  await assert.rejects(
    fixture.invoke({ kill: false, graceful: true }),
    /fixture interruption deadline exceeded \(awaiting=commit-durable;budgetMs=5000;/
  );
  assert.deepEqual(budgets, [5000]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].host, '127.0.0.1');
  assert.equal(requests[0].port, 12345);
  const state = fixture.state();
  assert.equal(state.time, 20000);
  assert.equal(state.requestsDestroyed, 1);
  assert.deepEqual(state.children[0].operations, ['initialize']);
  assert.deepEqual(state.removed, state.created);
  const notStarted = [];
  const preparation = loadFixture(t, 43, undefined, { requests: notStarted });
  await assert.rejects(
    preparation.invoke({ kill: false, graceful: true }),
    /fixture preparation deadline exceeded .*budgetMs=30000;/
  );
  assert.equal(notStarted.length, 0);
  assert.deepEqual(budgets, [5000]);
});

test('all original publication case wrappers reserve only the additional 25s preparation budget', () => {
  for (const [file, count] of [
    ['context-recovery-publication-interruption.test.js', 20],
    ['context-recovery-native-publication-interruption.test.js', 20],
    ['context-recovery-graceful-http.test.js', 5],
    ['context-recovery-native-graceful-http.test.js', 10],
  ]) {
    const budgets = [];
    const capture = () => (operation) => operation();
    const requireFixture = (name) => {
      if (name === 'node:test') return (_name, options) => budgets.push(options.timeout);
      if (name === './helpers/context-recovery-publication-interruption.cjs')
        return {
          publicationInterruption() {
            assert.fail('cases must not run in declaration probe');
          },
        };
      if (name === './helpers/publication-io-capture.cjs')
        return {
          installNativePublicationIoCapture: capture,
          installPublicationIoCapture: capture,
          installSqlPublicationIoCapture: capture,
        };
      assert.fail('unexpected case declaration dependency');
    };
    const script = new vm.Script(
      '(function(require){' + fs.readFileSync(path.join(__dirname, file), 'utf8') + '\n})'
    );
    script.runInThisContext()(requireFixture);
    assert.deepEqual(budgets, Array(count).fill(15000 - 5000 + 30000));
  }
});

test('preparation failure stops immediately; cleanup failure stays red and retains owned directory', async (t) => {
  const failed = loadFixture(t, 42, undefined, { failed: true });
  await assert.rejects(failed.invoke(), /fixture failed/);
  assert.equal(failed.state().time, 0);
  assert.deepEqual(failed.state().removed, failed.state().created);
  const cleanup = loadFixture(t, 42, undefined, { cleanupFailed: true });
  await assert.rejects(cleanup.invoke(), { message: 'fixture_owned_cleanup_failed' });
  assert.equal(cleanup.state().time, 30000);
  assert.deepEqual(cleanup.state().removed, []);
  assert.equal(fs.existsSync(cleanup.state().created[0]), true);
});

test('invalid, extreme and accessor PID metadata becomes null without evaluating foreign hooks', async (t) => {
  for (const pid of [
    undefined,
    null,
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    0xffffffff,
    0x100000000,
    'PRIVATE_PID',
    {},
    'getter',
  ]) {
    const fixture = loadFixture(t, pid);
    const { identity } = await fixture.run();
    assert.equal(identity.ownerProcessId, null);
    assert.equal(fixture.getterCalls(), 0);
  }
  assert.equal((await loadFixture(t, 0xfffffffe).run()).identity.ownerProcessId, 0xfffffffe);
});

test('invalid, empty and hostile synthetic tags cannot disclose content or run coercion', async (t) => {
  let hooks = 0;
  for (const tag of [
    null,
    '',
    'PRIVATE_TAG',
    'A'.repeat(64),
    'f'.repeat(65),
    {
      toString() {
        hooks++;
        throw Error('PRIVATE_TAG');
      },
    },
  ]) {
    const { identity } = await loadFixture(t, 12, tag).run();
    assert.equal(identity.fixtureTag, null);
  }
  const { identity } = await loadFixture(t, 12, 'a'.repeat(64)).run();
  assert.equal(identity.fixtureTag, 'a'.repeat(64));
  assert.equal(hooks, 0);
});
