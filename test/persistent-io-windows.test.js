'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPersistentIoSummary } = require('../scripts/lib/persistent-io-summary');
const { parseSummary } = require('../scripts/lib/coverage-io-capture');
const { validatePersistentIoWindows } = require('../scripts/lib/persistent-io-windows');
const { OPERATION_TYPES } = require('../scripts/lib/persistent-io-operation-summary');
const { discoverTestFiles } = require('../lib/test-discovery');
const path = require('node:path');

function fixture() {
  const summary = createPersistentIoSummary();
  const event = (type, key, timeMs, name = '') => summary.observe({ type, key, timeMs, name });
  event('schedule-start', '1', 0);
  event('name', '1', 0, 'C:/Temp/hpm-wbipc-core-aB012z/context/checkpoint.sqlite');
  event('flush', '2', 100, '1');
  event('end', '2', 200, '0');
  return { summary, event };
}

test('real accumulator retains bounded I/O intervals without claiming request or thread correlation', () => {
  const { summary, event } = fixture();
  event('write', '3', 1000, '1');
  event('end', '3', 1662, '0');
  event('delete', '4', 1663, '1');
  event('end', '4', 1664, '0xc0000043');
  const value = summary.snapshot();
  assert.equal(value.schemaVersion, 6);
  assert.deepEqual(value.ioWindows, [
    {
      operation: 'write',
      kind: 'database',
      startedAtMs: 1000,
      finishedAtMs: 1662,
      elapsedMs: 662,
      status: 0,
    },
    {
      operation: 'flush',
      kind: 'database',
      startedAtMs: 100,
      finishedAtMs: 200,
      elapsedMs: 100,
      status: 0,
    },
    {
      operation: 'delete',
      kind: 'database',
      startedAtMs: 1663,
      finishedAtMs: 1664,
      elapsedMs: 1,
      status: 3221225539,
    },
  ]);
  assert.deepEqual(parseSummary(JSON.stringify(value)), value);
  assert.equal(value.fiveSecondQualified, false);
  assert.equal(value.ioScheduling.commitCorrelationQualified, false);
  assert.doesNotMatch(
    JSON.stringify(value.ioWindows),
    /checkpoint|aB012z|threadId|processId|PRIVATE/
  );
  value.ioWindows[0].elapsedMs = 999;
  assert.equal(summary.snapshot().ioWindows[0].elapsedMs, 662);
});

test('top eight are ordered, detached and bounded while unfinished, reused and unrelated IRPs add no interval', () => {
  const { summary, event } = fixture();
  for (let index = 0; index < 30; index++) {
    event('write', '3', 1000, '1');
    event('end', '3', 2000 + index, '0');
  }
  event('write', '4', 1000, '1'); // unfinished
  event('write', '5', 1000, '1');
  event('invalidate', '5', 1000); // never adopt a reused IRP
  event('end', '5', 100000, '0');
  event('name', '6', 0, 'C:/PRIVATE/checkpoint.sqlite');
  event('write', '7', 1000, '6');
  event('end', '7', 100000, '0');
  const value = summary.snapshot();
  assert.equal(value.ioWindows.length, 8);
  assert.deepEqual(
    value.ioWindows.map((row) => row.elapsedMs),
    [1029, 1028, 1027, 1026, 1025, 1024, 1023, 1022]
  );
  assert.equal(value.ioOperations.unfinished, 1);
  assert.equal(value.ioOperations.write.database.count, 30);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  const empty = createPersistentIoSummary().snapshot();
  assert.equal(empty.schemaVersion, 1);
  assert.equal(Object.hasOwn(empty, 'ioWindows'), false);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/persistent-io-windows.test.js')
  );
});

test('closed window schema rejects malformed, forged, extreme and unsafe observations', () => {
  const { summary, event } = fixture();
  event('write', '3', 1000, '1');
  event('end', '3', 1662, '0');
  const value = summary.snapshot();
  for (const mutate of [
    (x) => {
      x.ioWindows = [];
    },
    (x) => {
      x.ioWindows = null;
    },
    (x) => {
      x.ioWindows = Array(9).fill(x.ioWindows[0]);
    },
    (x) => {
      x.ioWindows.reverse();
    },
    (x) => {
      x.ioWindows[0].operation = 'PRIVATE';
    },
    (x) => {
      x.ioWindows[0].kind = 'other';
    },
    (x) => {
      x.ioWindows[0].path = 'PRIVATE';
    },
    (x) => {
      x.ioWindows[0].status = 0x100000000;
    },
    (x) => {
      x.ioWindows[0].startedAtMs = -1;
    },
    (x) => {
      x.ioWindows[0].finishedAtMs = Number.MAX_SAFE_INTEGER + 1;
    },
    (x) => {
      x.ioWindows[0].elapsedMs++;
    },
    (x) => {
      x.ioWindows[0].status = 3221225539;
    },
    (x) => {
      x.ioOperations.write.database.maxMs = 100;
    },
    (x) => {
      x.ioWindows.splice(0, 0, { ...x.ioWindows[0] });
    },
    (x) => {
      x.ioWindows[1].status = 1;
    },
    (x) => {
      delete x.ioWindows;
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(value));
    mutate(bad);
    assert.throws(() => parseSummary(JSON.stringify(bad)));
  }
  let traps = 0;
  const hostile = Object.defineProperty({}, 'operation', {
    enumerable: true,
    get() {
      traps++;
      return 'write';
    },
  });
  for (const bad of [
    [hostile],
    new Proxy([], {}),
    '',
    'x'.repeat(4097),
    [Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(() => validatePersistentIoWindows(bad, value));
  assert.equal(traps, 0);
});

test('failed flush and nonzero operation intervals remain failures with normalized uint32 statuses', () => {
  const { summary, event } = fixture();
  event('flush', '3', 1000, '1');
  event('end', '3', 2000, '-1');
  event('write', '4', 2001, '1');
  event('end', '4', 2100, '-1073741757');
  const value = summary.snapshot();
  assert.equal(value.failedFlushes, 1);
  assert.equal(value.pairedFlushes, 1);
  assert.equal(value.ioWindows[0].status, 0xffffffff);
  assert.equal(value.ioWindows[2].status, 3221225539);
  assert.deepEqual(parseSummary(JSON.stringify(value)), value);
});

test('all bounded status inventories and large absolute timestamps still fit the original receipt limit', () => {
  const { summary, event } = fixture();
  event('name', '8', 0, 'C:/Temp/hpm-wbipc-core-aB012z/context/checkpoint.sqlite-journal');
  const start = Number.MAX_SAFE_INTEGER - 10000;
  for (const type of OPERATION_TYPES) {
    for (const [key, kind] of [
      ['1', 'database'],
      ['8', 'journal'],
    ]) {
      for (let index = 0; index < 16; index++) {
        event(type, '3', start, type === 'create' ? kind : key);
        event('end', '3', start + 1000 + index, String(0xffffffff - index));
      }
    }
  }
  const value = summary.snapshot();
  const text = JSON.stringify(value);
  assert.ok(Buffer.byteLength(text) <= 16384);
  assert.equal(value.ioWindows.length, 8);
  assert.deepEqual(parseSummary(text), value);
  assert.ok(value.ioWindows.every((row) => row.elapsedMs === 1015));
});
