'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPersistentFilterIoCorrelator,
} = require('../scripts/lib/persistent-filterio-correlator');
const { LIMITS } = require('../scripts/lib/persistent-filterio-contract');
const pointer = (value) => '0x' + BigInt(value).toString(16).padStart(16, '0');
const clock = () => ({ traceId: 'a'.repeat(64), kind: 'qpc', frequency: '1000000' });
const options = () => ({ clock: clock(), owned: { pid: 42, fixtureTag: 'b'.repeat(64) } });
const event = (type, time, extra = {}) => ({ type, clock: clock(), time: String(time), ...extra });
const file = { fileObject: pointer(1), fileGeneration: 1 };
const irp = { irp: pointer(2), irpGeneration: 1 };
const binding = { ...file, ...irp, majorFunction: 9 };
const key = {
  ...binding,
  routine: pointer(3),
  fileContext: pointer(4),
  callbackData: pointer(5),
  phase: 'pre',
};
const start = (model, overrides = {}) => {
  model.observe(
    event('file-open', 0, {
      ...file,
      ownerPid: 42,
      fixtureTag: 'b'.repeat(64),
      kind: 'database',
      ...overrides,
    })
  );
  model.observe(event('irp-begin', 10, binding));
};
const pair = (model, overrides = {}) => {
  model.observe(event('filter-init', 20, { ...key, ...overrides }));
  model.observe(event('filter-complete', 50, { ...key, initialTime: '20', ...overrides }));
};
const end = (model) => model.observe(event('irp-end', 60, { ...irp, ntStatus: 0 }));
const total = (summary) => summary.rows.reduce((sum, row) => sum + row.count, 0);
const rejects = (action) => assert.throws(action, { message: 'persistent_filterio_invalid' });

test('explicit IRP conflict taints existing candidates without fabricated status or completion', () => {
  const model = createPersistentFilterIoCorrelator(options());
  start(model);
  pair(model);
  model.observe(event('irp-invalidate', 55, irp));
  end(model);
  const value = model.finish();
  assert.equal(total(value), 0);
  assert.equal(value.mismatches.irpLifecycle, 1);
  assert.equal(value.mismatches.operationFailure, 0);
  const unfinished = createPersistentFilterIoCorrelator(options());
  start(unfinished);
  pair(unfinished);
  unfinished.observe(event('irp-invalidate', 55, irp));
  assert.equal(unfinished.finish().mismatches.unfinishedIrp, 1);
});

test('observed raw QPC spans remain private until matching real IRP end; output is bounded and independent', () => {
  const settings = options(),
    model = createPersistentFilterIoCorrelator(settings);
  settings.owned.pid = 99;
  settings.clock.frequency = '1';
  start(model);
  pair(model);
  assert.equal(total(model.snapshot()), 0);
  end(model);
  const result = model.finish();
  assert.equal(total(result), 1);
  assert.deepEqual(result.rows[0], {
    kind: 'database',
    phase: 'pre',
    count: 1,
    maxObservedSpanUs: 30,
  });
  assert.equal(result.nativeCaptureQualified, false);
  assert.equal(result.filterAttributionQualified, false);
  assert.equal(result.realModelRequests, 0);
  assert.doesNotMatch(
    JSON.stringify(result),
    /0x|fileObject|fixtureTag|ownerPid|traceId|routine|aaaa|bbbb/
  );
  result.rows[0].count = 100;
  result.mismatches.keyMismatch = 100;
  assert.equal(total(model.finish()), 1);
  assert.equal(model.snapshot().mismatches.keyMismatch, 0);
  rejects(() => model.observe(event('irp-end', 100, { ...irp, ntStatus: 0 })));
  rejects(() => model.snapshot());
});

test('empty input has four fixed zero rows and no capture qualification', () => {
  const model = createPersistentFilterIoCorrelator(options());
  const result = model.finish();
  assert.equal(total(result), 0);
  assert.equal(result.rows.length, 4);
  assert.ok(Object.values(result.mismatches).every((value) => value === 0));
});

test('pre and post remain separate; journal class and non-integral QPC conversion are explicit', () => {
  const settings = options();
  settings.clock.frequency = '3000000';
  const model = createPersistentFilterIoCorrelator(settings);
  const send = (value) => {
    value.clock.frequency = '3000000';
    model.observe(value);
  };
  send(
    event('file-open', 0, { ...file, ownerPid: 42, fixtureTag: 'b'.repeat(64), kind: 'journal' })
  );
  send(event('irp-begin', 10, binding));
  for (const phase of ['pre', 'post']) {
    send(event('filter-init', 20, { ...key, phase }));
    send(event('filter-complete', 51, { ...key, phase, initialTime: '20' }));
  }
  send(event('irp-end', 60, { ...irp, ntStatus: 0 }));
  const result = model.finish();
  assert.equal(total(result), 2);
  assert.equal(result.rows[2].maxObservedSpanUs, 10);
  assert.equal(result.rows[3].maxObservedSpanUs, 10);
});

test('duplicate or ambiguous evidence discards the whole epoch including earlier successful candidates', () => {
  for (const mode of [
    'duplicate-init',
    'duplicate-complete',
    'wrong-object',
    'wrong-context',
    'wrong-routine',
    'wrong-data',
    'wrong-phase',
    'wrong-major',
    'initial-time',
    'backward',
    'failure',
    'close',
    'reopen',
    'duplicate-begin',
  ]) {
    const model = createPersistentFilterIoCorrelator(options());
    start(model);
    pair(model);
    if (mode === 'duplicate-init') {
      model.observe(event('filter-init', 52, key));
      model.observe(event('filter-init', 53, key));
    } else if (mode === 'duplicate-complete')
      model.observe(event('filter-complete', 51, { ...key, initialTime: '20' }));
    else if (mode === 'failure')
      model.observe(event('filter-failure', 52, { ...key, status: 0xffffffff }));
    else if (mode === 'close') model.observe(event('file-close', 52, file));
    else if (mode === 'reopen')
      model.observe(
        event('file-open', 52, {
          ...file,
          fileGeneration: 2,
          ownerPid: 42,
          fixtureTag: 'b'.repeat(64),
          kind: 'database',
        })
      );
    else if (mode === 'duplicate-begin') model.observe(event('irp-begin', 52, binding));
    else {
      model.observe(event('filter-init', 52, key));
      const changed = { ...key, initialTime: '52' };
      if (mode === 'wrong-object') changed.fileObject = pointer(11);
      if (mode === 'wrong-context') changed.fileContext = pointer(11);
      if (mode === 'wrong-routine') changed.routine = pointer(11);
      if (mode === 'wrong-data') changed.callbackData = pointer(11);
      if (mode === 'wrong-phase') changed.phase = 'post';
      if (mode === 'wrong-major') changed.majorFunction = 8;
      if (mode === 'initial-time') changed.initialTime = '51';
      model.observe(event('filter-complete', mode === 'backward' ? 51 : 55, changed));
    }
    end(model);
    const result = model.finish();
    assert.equal(total(result), 0, mode);
    assert.ok(
      Object.values(result.mismatches).some((value) => value > 0),
      mode
    );
  }
});

test('unknown, foreign owner/tag, stale generations and missing end never become observations', () => {
  for (const mode of [
    'owner',
    'tag',
    'no-file',
    'no-irp',
    'file-generation',
    'irp-generation',
    'no-end',
    'missing-completion',
  ]) {
    const model = createPersistentFilterIoCorrelator(options());
    if (mode !== 'no-file')
      start(
        model,
        mode === 'owner' ? { ownerPid: 43 } : mode === 'tag' ? { fixtureTag: 'c'.repeat(64) } : {}
      );
    if (mode === 'no-irp') end(model);
    const changed = {
      ...(mode === 'file-generation' ? { fileGeneration: 2 } : {}),
      ...(mode === 'irp-generation' ? { irpGeneration: 2 } : {}),
    };
    if (mode === 'missing-completion') model.observe(event('filter-init', 20, key));
    else pair(model, changed);
    if (mode !== 'no-end') end(model);
    const result = model.finish();
    assert.equal(total(result), 0, mode);
    assert.ok(
      Object.values(result.mismatches).some((value) => value > 0),
      mode
    );
  }
});

test('closed object/IRP reuse needs newer generations and cannot inherit previous candidates', () => {
  const model = createPersistentFilterIoCorrelator(options());
  start(model);
  pair(model);
  end(model);
  model.observe(event('file-close', 70, file));
  model.observe(
    event('file-open', 80, {
      ...file,
      fileGeneration: 2,
      ownerPid: 42,
      fixtureTag: 'b'.repeat(64),
      kind: 'journal',
    })
  );
  const next = { ...key, fileGeneration: 2, irpGeneration: 2 };
  model.observe(event('irp-begin', 90, { ...binding, fileGeneration: 2, irpGeneration: 2 }));
  model.observe(event('filter-complete', 110, { ...next, initialTime: '20' }));
  model.observe(event('irp-end', 120, { ...irp, irpGeneration: 2, ntStatus: 0 }));
  assert.equal(total(model.finish()), 1);
  assert.equal(model.snapshot().rows[2].count, 0);
});

test('clock mismatch, accessors, proxies, extra data and unsafe scalars fail sticky without exposing input', () => {
  let getterCalls = 0;
  const invalid = [
    null,
    [],
    {},
    event('PRIVATE', 0),
    event('file-close', 0, { ...file, secret: 'PRIVATE' }),
    event('file-close', 0, { ...file, fileGeneration: Infinity }),
    event('file-close', '-1', file),
    event('file-close', '9223372036854775808', file),
    event('file-close', '01', file),
    event('file-close', 0, { ...file, fileObject: 'PRIVATE' }),
    new Proxy({}, {}),
    Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        getterCalls++;
        throw Error('PRIVATE');
      },
    }),
  ];
  for (const field of ['traceId', 'frequency', 'kind']) {
    const row = event('file-close', 0, file);
    row.clock[field] = field === 'kind' ? 'system' : field === 'frequency' ? '1' : 'c'.repeat(64);
    invalid.push(row);
  }
  for (const row of invalid) {
    const model = createPersistentFilterIoCorrelator(options());
    rejects(() => model.observe(row));
    rejects(() => model.finish());
    rejects(() => model.snapshot());
  }
  assert.equal(getterCalls, 0);
  const hostile = options();
  Object.defineProperty(hostile.owned, 'pid', {
    enumerable: true,
    get() {
      getterCalls++;
      throw Error('PRIVATE');
    },
  });
  rejects(() => createPersistentFilterIoCorrelator(hostile));
  assert.equal(getterCalls, 0);
  for (const bad of [null, {}, { ...options(), extra: true }])
    rejects(() => createPersistentFilterIoCorrelator(bad));
});

test('all generations and candidate histories have fixed global bounds, not per-IRP multiplication', () => {
  assert.deepEqual(LIMITS, { events: 1000000, files: 256, irps: 8192, spans: 8192 });
  let model = createPersistentFilterIoCorrelator(options());
  for (let index = 1; index <= LIMITS.files; index++)
    model.observe(
      event('file-open', 0, {
        fileObject: pointer(index),
        fileGeneration: 1,
        ownerPid: 42,
        fixtureTag: 'b'.repeat(64),
        kind: 'database',
      })
    );
  rejects(() =>
    model.observe(
      event('file-open', 0, {
        ...file,
        fileObject: pointer(1000),
        ownerPid: 42,
        fixtureTag: 'b'.repeat(64),
        kind: 'database',
      })
    )
  );
  rejects(() => model.finish());
  model = createPersistentFilterIoCorrelator(options());
  start(model);
  for (let index = 1; index < LIMITS.irps; index++)
    model.observe(event('irp-begin', 10, { ...binding, irp: pointer(index + 100) }));
  rejects(() => model.observe(event('irp-begin', 10, { ...binding, irp: pointer(100000) })));
  model = createPersistentFilterIoCorrelator(options());
  start(model);
  for (let index = 0; index < LIMITS.spans - 1; index++)
    model.observe(event('filter-init', 20, { ...key, routine: pointer(index + 100) }));
  rejects(() => model.observe(event('filter-init', 20, { ...key, routine: pointer(100000) })));
  rejects(() => model.snapshot());
});

test('input copying and uint64 QPC arithmetic preserve precision and reject unsafe public spans', () => {
  const model = createPersistentFilterIoCorrelator(options());
  start(model);
  const initial = event('filter-init', 20, key);
  model.observe(initial);
  initial.time = '50';
  initial.routine = pointer(99);
  model.observe(event('filter-complete', 50, { ...key, initialTime: '20' }));
  end(model);
  assert.equal(model.finish().rows[0].maxObservedSpanUs, 30);
  const settings = options();
  settings.clock.frequency = '1';
  const huge = createPersistentFilterIoCorrelator(settings);
  const send = (row) => {
    row.clock.frequency = '1';
    huge.observe(row);
  };
  send(
    event('file-open', 0, { ...file, ownerPid: 42, fixtureTag: 'b'.repeat(64), kind: 'database' })
  );
  send(event('irp-begin', 0, binding));
  send(event('filter-init', 0, key));
  send(event('filter-complete', '9223372036854775807', { ...key, initialTime: '0' }));
  send(event('irp-end', '9223372036854775807', { ...irp, ntStatus: 0 }));
  rejects(() => huge.finish());
  rejects(() => huge.snapshot());
});

test('one million event bound is global and an overflow permanently closes observation', () => {
  const model = createPersistentFilterIoCorrelator(options());
  const missing = event('file-close', 0, file);
  for (let index = 0; index < LIMITS.events; index++) model.observe(missing);
  assert.equal(model.snapshot().mismatches.unknownFile, LIMITS.events);
  rejects(() => model.observe(missing));
  rejects(() => model.finish());
});

test('large absolute QPC ticks keep exact small spans and clean generations can reopen', () => {
  const model = createPersistentFilterIoCorrelator(options());
  start(model);
  pair(model);
  end(model);
  model.observe(event('file-close', 70, file));
  model.observe(
    event('file-open', 80, {
      ...file,
      fileGeneration: 2,
      ownerPid: 42,
      fixtureTag: 'b'.repeat(64),
      kind: 'journal',
    })
  );
  const next = { ...key, fileGeneration: 2, irpGeneration: 2 };
  model.observe(event('irp-begin', 90, { ...binding, fileGeneration: 2, irpGeneration: 2 }));
  const tick = 9007199254740993n;
  model.observe(event('filter-init', tick, next));
  model.observe(event('filter-complete', tick + 30n, { ...next, initialTime: String(tick) }));
  model.observe(event('irp-end', tick + 40n, { ...irp, irpGeneration: 2, ntStatus: 0 }));
  const result = model.finish();
  assert.equal(total(result), 2);
  assert.equal(result.rows[2].count, 1);
  assert.equal(result.rows[2].maxObservedSpanUs, 30);
});

for (const mode of ['unknown-object', 'foreign-object', 'wrong-generation']) {
  test(`a second begin with ${mode} taints the already active IRP before file admission`, () => {
    const model = createPersistentFilterIoCorrelator(options());
    start(model);
    pair(model);
    if (mode === 'foreign-object')
      model.observe(
        event('file-open', 51, {
          ...file,
          fileObject: pointer(11),
          ownerPid: 43,
          fixtureTag: 'b'.repeat(64),
          kind: 'journal',
        })
      );
    model.observe(
      event('irp-begin', 52, {
        ...binding,
        ...(mode === 'wrong-generation' ? { fileGeneration: 2 } : { fileObject: pointer(11) }),
      })
    );
    end(model);
    const result = model.finish();
    assert.equal(total(result), 0);
    assert.equal(result.mismatches.irpLifecycle, 1);
  });
}

test('canonical identities, pointers and decimal clocks reject every trailing line terminator', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const name of ['traceId', 'frequency', 'fixtureTag']) {
      const settings = options();
      if (name === 'fixtureTag') settings.owned.fixtureTag += suffix;
      else settings.clock[name] += suffix;
      rejects(() => createPersistentFilterIoCorrelator(settings));
    }
    for (const name of ['pointer', 'tick', 'traceId', 'frequency', 'fixtureTag']) {
      const model = createPersistentFilterIoCorrelator(options());
      const value = event('file-open', 1, {
        ...file,
        ownerPid: 42,
        fixtureTag: 'b'.repeat(64),
        kind: 'database',
      });
      if (name === 'pointer') value.fileObject += suffix;
      if (name === 'tick') value.time += suffix;
      if (name === 'fixtureTag') value.fixtureTag += suffix;
      if (name === 'traceId' || name === 'frequency') value.clock[name] += suffix;
      rejects(() => model.observe(value));
      rejects(() => model.finish());
    }
  }
});

test('closing one file epoch does not scan unrelated active IRP maps', () => {
  const model = createPersistentFilterIoCorrelator(options());
  start(model);
  pair(model);
  const other = { fileObject: pointer(20), fileGeneration: 1 };
  model.observe(
    event('file-open', 0, { ...other, ownerPid: 42, fixtureTag: 'b'.repeat(64), kind: 'journal' })
  );
  for (let index = 0; index < 1000; index++)
    model.observe(event('irp-begin', 10, { ...binding, ...other, irp: pointer(index + 100) }));
  const original = Map.prototype.values;
  let visits = 0;
  Map.prototype.values = function* () {
    for (const value of original.call(this)) {
      visits++;
      yield value;
    }
  };
  try {
    model.observe(event('file-close', 55, file));
  } finally {
    Map.prototype.values = original;
  }
  assert.equal(visits, 0);
  end(model);
  assert.equal(total(model.finish()), 0);
});

test('actual OpEnd NTSTATUS rejects failed flush candidates and still closes the epoch', () => {
  for (const ntStatus of [1, 0x80000000, 0xc0000022, 0xffffffff]) {
    const model = createPersistentFilterIoCorrelator(options());
    start(model);
    pair(model);
    pair(model, { phase: 'post' });
    model.observe(event('irp-end', 60, { ...irp, ntStatus }));
    const result = model.snapshot();
    assert.equal(total(result), 0);
    assert.equal(result.mismatches.operationFailure, 1);
    assert.equal(result.mismatches.filterFailure, 0);
    const closed = model.finish();
    assert.equal(closed.mismatches.unfinishedIrp, 0);
    assert.equal(total(closed), 0);
  }
});

test('OpEnd NTSTATUS is mandatory exact uint32 and never defaults missing or malformed values to success', () => {
  for (const ntStatus of [undefined, null, '', '0', -1, 0x100000000, Infinity, NaN, 0.5, true]) {
    const model = createPersistentFilterIoCorrelator(options());
    start(model);
    pair(model);
    const value = { ...irp };
    if (ntStatus !== undefined) value.ntStatus = ntStatus;
    rejects(() => model.observe(event('irp-end', 60, value)));
    rejects(() => model.finish());
  }
});
