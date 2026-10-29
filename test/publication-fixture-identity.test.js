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

function loadFixture(t, pid, tagOverride) {
  let time = 0;
  const waits = [];
  const children = [];
  const created = [];
  const removed = [];
  let getterCalls = 0;
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
            assert.equal(input.native, true);
            assert.equal(Object.hasOwn(input, 'key'), false);
            child.emit('message', { phase: 'native-opened' });
          };
          child.kill = (signal) => {
            child.kills.push(signal);
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
        waitForFixtureSignal: async (_child, remaining) => {
          waits.push(remaining);
          time += remaining;
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
        /fixture phase deadline exceeded \(awaiting=ready;lastFixture=native-opened;/
      );
      assert.deepEqual(waits, [5000]);
      assert.equal(time, 5000);
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

test('two original fixture timeout paths retain distinct child PID/tag at identical original deadlines and cleanup', async (t) => {
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
