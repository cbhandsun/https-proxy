'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureTag, parseIoAssociation } = require('../scripts/lib/persistent-io-association');
const { createPersistentIoSummary } = require('../scripts/lib/persistent-io-summary');
const { parseSummary } = require('../scripts/lib/coverage-io-capture');
const { observedOwnerIdentity, parseStageLine } = require('./helpers/recovery-owner-stage-probe');
const filename = 'C:/Temp/hpm-wbipc-core-aB012z/context/checkpoint.sqlite';
const ids = { eventProcessId: 123, eventThreadId: 456, issuingThreadId: 789 };

function fixture() {
  const summary = createPersistentIoSummary();
  const event = (type, key, timeMs, name = '', association) =>
    summary.observe({
      type,
      key,
      timeMs,
      name,
      ...(association === undefined ? {} : { association }),
    });
  event('schedule-start', '1', 0);
  event('name', '1', 0, filename);
  event('name', '2', 0, filename + '-journal');
  return { summary, event };
}

test('paired I/O retains detached synthetic fixture and explicitly labelled scalar identities', () => {
  const { summary, event } = fixture();
  event('flush', '3', 10, '1', ids);
  ids.eventProcessId = 999;
  event('end', '3', 110, '0');
  ids.eventProcessId = 123;
  event('write', '4', 120, '2', ids);
  event('end', '4', 200, '0xc0000043');
  const result = summary.snapshot();
  assert.equal(result.schemaVersion, 7);
  assert.deepEqual(result.ioWindows[0].association, { ...ids, fixtureTag: fixtureTag(filename) });
  assert.deepEqual(result.ioWindows[1].association, result.ioWindows[0].association);
  assert.equal(result.ioWindows[1].status, 0xc0000043);
  assert.deepEqual(parseSummary(JSON.stringify(result)), result);
  assert.equal(result.traceCompletenessVerified, false);
  assert.equal(result.fiveSecondQualified, false);
  assert.equal(result.ioScheduling.commitCorrelationQualified, false);
  assert.doesNotMatch(JSON.stringify(result), /aB012z|checkpoint|Temp|ownerProcessId|0x/);
  result.ioWindows[0].association.eventProcessId = 999;
  assert.equal(summary.snapshot().ioWindows[0].association.eventProcessId, 123);
});

test('fixture tags join device/Win32 spellings and journals but do not equate distinct fixtures', () => {
  const tag = fixtureTag(filename);
  assert.equal(tag.length, 64);
  assert.equal(
    fixtureTag(
      '\\Device\\HarddiskVolume3\\Temp\\hpm-wbipc-core-ab012Z\\context\\checkpoint.sqlite-journal'
    ),
    tag
  );
  assert.notEqual(fixtureTag(filename.replace('aB012z', 'aB012x')), tag);
  assert.notEqual(fixtureTag('C:/Temp/hpm-publication-interior-aB012z/checkpoint.sqlite'), tag);
  for (const value of [
    null,
    {},
    '',
    'PRIVATE',
    filename + '.backup',
    filename + '\n',
    'x'.repeat(4097),
  ])
    assert.equal(fixtureTag(value), null);
});

test('missing IDs remain null and pointer/IRP reuse cannot inherit an old fixture association', () => {
  const { summary, event } = fixture();
  const missing = { eventProcessId: null, eventThreadId: null, issuingThreadId: null };
  event('flush', '3', 1, '1', missing);
  event('name', '1', 2, filename.replace('aB012z', 'aB012x'));
  event('end', '3', 3, '0');
  event('flush', '3', 4, '1', ids);
  event('end', '3', 5, '0');
  event('create', '4', 6, 'journal', missing);
  event('end', '4', 7, '0');
  const value = summary.snapshot();
  assert.equal(value.ioWindows[0].association.fixtureTag, fixtureTag(filename));
  assert.equal(value.ioWindows[0].association.issuingThreadId, null);
  assert.notEqual(value.ioWindows[1].association.fixtureTag, fixtureTag(filename));
  assert.equal(value.ioWindows[2].association.fixtureTag, null);
  assert.deepEqual(parseSummary(JSON.stringify(value)), value);
  event('flush', '5', 10, '1', ids);
  event('invalidate', '5', 11);
  event('end', '5', 12, '0');
  assert.equal(summary.snapshot().ioWindows.length, 3);
});

test('association rejects getters, proxies, wrong shapes and invalid ID bounds without invoking hooks', () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { ...ids, extra: 'PRIVATE' },
    ...[-1, 0, 0xffffffff, 0x100000000, NaN, Infinity, 1.5, '123'].map((v) => ({
      ...ids,
      issuingThreadId: v,
    })),
    {
      ...ids,
      get eventThreadId() {
        throw Error('PRIVATE');
      },
    },
    new Proxy(ids, {
      ownKeys() {
        throw Error('PRIVATE');
      },
    }),
  ]) {
    assert.throws(() => parseIoAssociation(value), /persistent_io_association_invalid/);
  }
  assert.deepEqual(parseIoAssociation({ ...ids, issuingThreadId: 0xfffffffe }), {
    ...ids,
    issuingThreadId: 0xfffffffe,
  });
  const { event } = fixture();
  assert.throws(() => event('end', '3', 1, '0', ids));
  assert.throws(() => event('flush', '3', 1, '1', null));
});

test('receipt parser rejects identity injection and downgrade while retaining old schema6 evidence', () => {
  const { summary, event } = fixture();
  event('flush', '3', 1, '1', ids);
  event('end', '3', 2, '0');
  const good = summary.snapshot();
  for (const mutate of [
    (v) => {
      v.schemaVersion = 6;
    },
    (v) => {
      v.ioWindows[0].association.fixtureTag = 'PRIVATE';
    },
    (v) => {
      delete v.ioWindows[0].association.fixtureTag;
    },
    (v) => {
      v.ioWindows[0].association.ownerProcessId = 123;
    },
    (v) => {
      v.ioWindows[0].association.eventProcessId = 0xffffffff;
    },
  ]) {
    const value = globalThis.structuredClone(good);
    mutate(value);
    assert.throws(() => parseSummary(JSON.stringify(value)));
  }
  const emptyIdentity = globalThis.structuredClone(good);
  delete emptyIdentity.ioWindows[0].association;
  assert.throws(() => parseSummary(JSON.stringify(emptyIdentity)));
  const old = globalThis.structuredClone(good);
  delete old.ioWindows[0].association;
  old.schemaVersion = 6;
  assert.deepEqual(parseSummary(JSON.stringify(old)), old);
});

test('actual owner instrumentation emits its PID and matching fixture tag without reading foreign getters', () => {
  const identity = observedOwnerIdentity({
    directory: filename.slice(0, -'/checkpoint.sqlite'.length),
  });
  assert.deepEqual(identity, { ownerProcessId: process.pid, fixtureTag: fixtureTag(filename) });
  const row = {
    sequence: 1,
    operation: 'save-reference-state',
    stage: 'sqlite_commit',
    elapsedMs: 100,
    ...identity,
  };
  assert.deepEqual(parseStageLine(JSON.stringify(row)), row);
  for (const input of [
    null,
    {},
    {
      get directory() {
        throw Error('PRIVATE');
      },
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    assert.equal(observedOwnerIdentity(input).fixtureTag, null);
  for (const invalid of [
    { ...row, ownerProcessId: 0 },
    { ...row, fixtureTag: 'PRIVATE' },
    { ...row, fixtureTag: undefined },
    { ...row, ownerProcessId: undefined },
  ])
    assert.throws(() => parseStageLine(JSON.stringify(invalid)));
});

test('top eight associated operations stay bounded and reused IRPs carry only their new identity', () => {
  const { summary, event } = fixture();
  event('flush', '3', 1, '1', ids);
  event('end', '3', 2, '0');
  for (let i = 0; i < 30; i++) {
    event('write', '4', 10, '2', { ...ids, eventProcessId: i + 1 });
    event('end', '4', 20 + i, '0');
  }
  assert.equal(summary.snapshot().ioWindows.length, 8);
  assert.equal(summary.snapshot().ioWindows[0].association.eventProcessId, 30);
  assert.deepEqual(parseSummary(JSON.stringify(summary.snapshot())), summary.snapshot());
  event('write', '5', 100, '1', ids);
  event('write', '5', 101, '2', { ...ids, eventProcessId: 555 });
  event('end', '5', 200, '0');
  assert.equal(summary.snapshot().ioWindows[0].association.eventProcessId, 555);
  assert.equal(summary.snapshot().ioOperations.collisions, 1);
  assert.deepEqual(parseSummary(JSON.stringify(summary.snapshot())), summary.snapshot());
});
