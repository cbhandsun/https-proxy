'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { finishPhysicalOwnerCleanup } = require('./helpers/physical-owner-cleanup.cjs');

test('physical summary owner preserves the original failure when directory cleanup also fails', () => {
  const filename = path.resolve(__dirname, 'context-recovery-codex-summary.test.js');
  const load = createRequire(filename);
  const primary = new Error('owned_child_failure');
  const cleanup = new Error('owned_cleanup_failure');
  let callback;
  let removals = 0;
  let launches = 0;
  const register = (name, options, action) => {
    if (
      name ===
      'v7 summary survives two physical owners through real encrypted storage without extending expiry (inline tools: false)'
    )
      callback = action;
  };
  // Execute the repository fixture in this realm so its strict data parsers
  // receive ordinary arrays/records, exactly as in the original test process.
  const evaluate = vm.compileFunction(
    fs.readFileSync(filename, 'utf8'),
    ['require', '__dirname', 'process', 'Buffer'],
    { filename }
  );
  evaluate(
    (name) => {
      if (name === 'node:test') return register;
      if (name === 'node:child_process')
        return {
          spawnSync() {
            launches++;
            throw primary;
          },
        };
      if (name === 'node:fs')
        return {
          ...fs,
          mkdtempSync: () => path.join(os.tmpdir(), 'hpm-v7-owner-cleanup-regression'),
          rmSync() {
            removals++;
            throw cleanup;
          },
        };
      return load(name);
    },
    __dirname,
    process,
    Buffer
  );
  assert.equal(typeof callback, 'function');
  assert.throws(callback, (error) => {
    assert.equal(launches, 1);
    assert.equal(removals, 1);
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.message, 'physical_owner_cleanup_failed');
    assert.deepEqual(Array.from(error.errors), [primary, cleanup]);
    return true;
  });
  assert.equal(removals, 1);
});

test('owner cleanup runs all actions once and does not throw when they succeed', () => {
  const calls = [];
  finishPhysicalOwnerCleanup([], []);
  finishPhysicalOwnerCleanup(
    Object.freeze([]),
    Object.freeze([() => calls.push('runtime'), () => calls.push('directory')])
  );
  assert.deepEqual(calls, ['runtime', 'directory']);
  const original = new Error('owned_primary');
  assert.throws(
    () => {
      try {
        throw original;
      } finally {
        finishPhysicalOwnerCleanup([original], [() => calls.push('done')]);
      }
    },
    (error) => error === original
  );
});

test('cleanup alone stays a failure and every independent action is attempted without retry', () => {
  const first = new Error('owned_first');
  const second = new Error('owned_second');
  let calls = 0;
  assert.throws(
    () =>
      finishPhysicalOwnerCleanup(
        [],
        [
          () => {
            calls++;
            throw first;
          },
          () => {
            calls++;
            throw second;
          },
        ]
      ),
    (error) => {
      assert.deepEqual(error.errors, [first, second]);
      return error.message === 'physical_owner_cleanup_failed';
    }
  );
  assert.equal(calls, 2);
  assert.throws(
    () =>
      finishPhysicalOwnerCleanup(
        [],
        [
          () => {
            throw first;
          },
        ]
      ),
    (error) => error === first
  );
});

test('cleanup preserves even an empty thrown value and never modifies the primary failure list', () => {
  const primary = Object.freeze([undefined]);
  const cleanup = new Error('owned_cleanup');
  assert.throws(
    () =>
      finishPhysicalOwnerCleanup(primary, [
        () => {
          throw cleanup;
        },
      ]),
    (error) => {
      assert.deepEqual(error.errors, [undefined, cleanup]);
      return true;
    }
  );
  assert.deepEqual(primary, [undefined]);
});
