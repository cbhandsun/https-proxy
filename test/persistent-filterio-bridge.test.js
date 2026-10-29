'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPersistentFilterIoBridge,
  LIMITS,
  parsePersistentFilterIoRawLine,
} = require('../scripts/lib/persistent-filterio-bridge');
const {
  createPersistentFilterIoOwnerScope,
} = require('../scripts/lib/persistent-filterio-owner-scope');
const p = (n) => '0x' + BigInt(n).toString(16).padStart(16, '0');
const tag = 'a'.repeat(64);
const clock = { traceId: 'b'.repeat(64), kind: 'qpc', frequency: '1000000' };
const stage = (extra = {}) =>
  JSON.stringify({
    sequence: 1,
    operation: 'save',
    stage: 'sqlite_commit',
    elapsedMs: 1,
    ownerProcessId: 42,
    fixtureTag: tag,
    ...extra,
  });
const raw = (type, time, opcode, extra) => ({
  type,
  time: String(time),
  opcode,
  pid: 42,
  tid: 998,
  version: 3,
  ...extra,
});
const name = (extra = {}) =>
  raw('name', 1, 0, { fileKey: p(1), fixtureTag: tag, kind: 'database', ...extra });
const create = (extra = {}) =>
  raw('create', 2, 64, {
    fileObject: p(2),
    irp: p(3),
    fixtureTag: tag,
    kind: 'database',
    ...extra,
  });
const flush = (time = 3, extra = {}) =>
  raw('flush', time, 73, { fileKey: p(1), fileObject: p(2), irp: p(4), ...extra });
const filter = (type = 'filter-init', time = 4, opcode = 96, extra = {}) =>
  raw(type, time, opcode, {
    irp: p(4),
    fileObject: p(2),
    routine: p(5),
    fileContext: p(6),
    callbackData: p(7),
    majorFunction: 9,
    ...(type === 'filter-complete' ? { initialTime: '4' } : {}),
    ...(type === 'filter-failure' ? { status: 1 } : {}),
    ...extra,
  });
const end = (time = 7, extra = {}) => raw('end', time, 76, { irp: p(4), ntStatus: 0, ...extra });
const count = (result) => result.rows.reduce((n, r) => n + r.count, 0);
const rejects = (fn) => assert.throws(fn, { message: 'persistent_filterio_bridge_invalid' });
function setup(withOwner = true) {
  const ownerScope = createPersistentFilterIoOwnerScope();
  if (withOwner) ownerScope.observeStageLine(stage());
  return { ownerScope, bridge: createPersistentFilterIoBridge({ clock, ownerScope }) };
}
function opened(bridge) {
  bridge.observe(name());
  bridge.observe(create());
  bridge.observe(flush());
}
function pair(bridge) {
  bridge.observe(filter());
  bridge.observe(filter('filter-complete', 6, 98));
}

test('Name/FileKey plus actual Create/FileObject and Flush bind independent stage owner; 96/98 pre and 97/99 post', () => {
  const { bridge } = setup();
  opened(bridge);
  pair(bridge);
  bridge.observe(filter('filter-init', 6, 97));
  bridge.observe(filter('filter-complete', 7, 99, { initialTime: '6' }));
  assert.equal(count(bridge.snapshot()), 0);
  bridge.observe(end());
  const value = bridge.finish();
  assert.equal(count(value), 2);
  assert.equal(value.rows[0].maxObservedSpanUs, 2);
  assert.equal(value.rows[1].maxObservedSpanUs, 1);
  for (const flag of [
    'nativeCaptureQualified',
    'filterAttributionQualified',
    'processCreationVerified',
    'physicalFileIdentityVerified',
  ])
    assert.equal(value[flag], false);
  assert.equal(value.realModelRequests, 0);
  assert.doesNotMatch(JSON.stringify(value), /0x|ownerProcessId|fixtureTag|999|998|aaaa|bbbb/);
  value.rows[0].count = 99;
  assert.equal(count(bridge.finish()), 2);
  rejects(() => bridge.observe(end()));
  rejects(() => bridge.snapshot());
});

test('empty and unknown sources remain zero; ETW header PID cannot create an owner', () => {
  assert.equal(count(setup().bridge.finish()), 0);
  const { bridge } = setup(false);
  opened(bridge);
  pair(bridge);
  bridge.observe(end());
  const value = bridge.finish();
  assert.equal(count(value), 0);
  assert.equal(value.rejected.unknownOwner, 1);
});

test('missing Name, missing Create and mismatched path tags never create candidates', () => {
  for (const mode of ['name', 'create', 'mismatch']) {
    const { bridge } = setup();
    if (mode !== 'name') bridge.observe(name());
    if (mode !== 'create')
      bridge.observe(create(mode === 'mismatch' ? { fixtureTag: 'c'.repeat(64) } : {}));
    bridge.observe(flush());
    pair(bridge);
    bridge.observe(end());
    assert.equal(count(bridge.finish()), 0, mode);
  }
});

test('real nonzero NtStatus, filter failure and wrong full keys discard the IRP epoch', () => {
  for (const mode of ['status', 'filter', 'routine', 'initial', 'major']) {
    const { bridge } = setup();
    opened(bridge);
    bridge.observe(filter());
    if (mode === 'filter') bridge.observe(filter('filter-failure', 5, 100));
    bridge.observe(
      filter(
        'filter-complete',
        6,
        98,
        mode === 'routine'
          ? { routine: p(99) }
          : mode === 'initial'
            ? { initialTime: '3' }
            : mode === 'major'
              ? { majorFunction: 10 }
              : {}
      )
    );
    bridge.observe(end(7, { ntStatus: mode === 'status' ? 0xc0000001 : 0 }));
    assert.equal(count(bridge.finish()), 0, mode);
  }
});

test('close, object reuse, name deletion and nonfixture invalidation discard pending spans', () => {
  for (const mode of ['close', 'reuse', 'delete', 'nonfixture', 'name-change']) {
    const { bridge } = setup();
    opened(bridge);
    pair(bridge);
    const row =
      mode === 'close'
        ? raw('close', 6, 66, { fileObject: p(2), irp: p(88) })
        : mode === 'reuse'
          ? { ...create(), time: '6' }
          : mode === 'delete'
            ? raw('name-delete', 6, 35, { fileKey: p(1) })
            : {
                ...name(
                  mode === 'nonfixture' ? { fixtureTag: null, kind: null } : { kind: 'journal' }
                ),
                time: '6',
              };
    bridge.observe(row);
    bridge.observe(end());
    assert.equal(count(bridge.finish()), 0, mode);
  }
});

test('FileObject and IRP pointer reuse require new generations; incomplete/repeated IRP is tainted', () => {
  const { bridge } = setup();
  opened(bridge);
  pair(bridge);
  bridge.observe(end());
  bridge.observe(raw('close', 8, 66, { fileObject: p(2), irp: p(88) }));
  bridge.observe({ ...create(), time: '9' });
  bridge.observe(flush(10));
  bridge.observe(filter('filter-init', 11));
  bridge.observe(filter('filter-complete', 12, 98, { initialTime: '11' }));
  bridge.observe(end(13));
  assert.equal(count(bridge.finish()), 2);
  const other = setup().bridge;
  opened(other);
  pair(other);
  other.observe(flush(6));
  other.observe(end());
  assert.equal(count(other.finish()), 0);
  const unfinished = setup().bridge;
  opened(unfinished);
  pair(unfinished);
  assert.equal(count(unfinished.finish()), 0);
});

test('unknown end/status missing cannot manufacture success; malformed inputs latch without invoking getters', () => {
  for (const mutate of [
    (x) => {
      delete x.ntStatus;
    },
    (x) => {
      x.ntStatus = -1;
    },
    (x) => {
      x.ntStatus = 0x100000000;
    },
    (x) => {
      x.time = '01';
    },
    (x) => {
      x.time = '9223372036854775808';
    },
    (x) => {
      x.version = 4;
    },
    (x) => {
      x.opcode = 73;
    },
    (x) => {
      x.private = 'PRIVATE';
    },
    (x) => {
      Object.defineProperty(x, 'irp', {
        get() {
          throw new Error('PRIVATE');
        },
      });
    },
  ]) {
    const { bridge } = setup();
    opened(bridge);
    pair(bridge);
    const row = end();
    mutate(row);
    rejects(() => bridge.observe(row));
    rejects(() => bridge.finish());
  }
  const { bridge } = setup();
  rejects(() =>
    bridge.observe(
      new Proxy(
        {},
        {
          get() {
            throw Error('PRIVATE');
          },
        }
      )
    )
  );
  const rollback = setup().bridge;
  rollback.observe(name());
  rejects(() => rollback.observe({ ...create(), time: '0' }));
});

test('supported actual Name versions and operation versions are retained, not normalized', () => {
  const { bridge } = setup();
  bridge.observe({ ...name(), opcode: 32, version: 2 });
  bridge.observe({ ...create(), version: 2 });
  bridge.observe({ ...flush(), version: 2 });
  pair(bridge);
  bridge.observe({ ...end(), version: 2 });
  assert.equal(count(bridge.finish()), 1);
});

test('bounded name/file/IRP histories reject overflow without public identifiers', () => {
  for (const type of ['name', 'file']) {
    const { bridge } = setup();
    const limit = type === 'name' ? LIMITS.names : LIMITS.files;
    for (let n = 1; n <= limit; n++)
      bridge.observe(type === 'name' ? name({ fileKey: p(n) }) : create({ fileObject: p(n) }));
    rejects(() =>
      bridge.observe(
        type === 'name' ? name({ fileKey: p(limit + 1) }) : create({ fileObject: p(limit + 1) })
      )
    );
  }
  const { bridge } = setup();
  opened(bridge);
  for (let n = 1; n < LIMITS.irps; n++) bridge.observe(flush(3));
  rejects(() => bridge.observe(flush(3)));
});

test('owner scope uses original strict stage parser and admits only bounded exact PID/tag pairs', () => {
  const scope = createPersistentFilterIoOwnerScope();
  scope.observeStageLine(stage());
  assert.deepEqual(scope.snapshot(), {
    ownersObserved: 1,
    stageRecords: 1,
    processCreationVerified: false,
    physicalFileIdentityVerified: false,
  });
  scope.observeStageLine(stage({ ownerProcessId: 43 }));
  assert.equal(scope.snapshot().ownersObserved, 2);
  for (const line of [
    stage({ fixtureTag: null }),
    stage({ ownerProcessId: 0 }),
    stage({ extra: 'PRIVATE' }),
    'HPM_STAGE ' + stage(),
    'x'.repeat(513),
  ])
    rejects(() => createPersistentFilterIoOwnerScope().observeStageLine(line));
  rejects(() => createPersistentFilterIoBridge({ clock, ownerScope: { snapshot() {} } }));
  const invalid = setup();
  rejects(() => invalid.ownerScope.observeStageLine('invalid'));
  rejects(() => invalid.bridge.finish());
});

test('same-directory restart supports independent attested PIDs without choosing last or nearest owner', () => {
  const { bridge, ownerScope } = setup();
  ownerScope.observeStageLine(stage({ ownerProcessId: 43 }));
  opened(bridge);
  pair(bridge);
  bridge.observe(end());
  bridge.observe(raw('close', 8, 66, { fileObject: p(2), irp: p(88) }));
  bridge.observe({ ...create(), time: '9', pid: 43 });
  bridge.observe(flush(10));
  bridge.observe(filter('filter-init', 11));
  bridge.observe(filter('filter-complete', 12, 98, { initialTime: '11' }));
  bridge.observe(end(13));
  assert.equal(count(bridge.finish()), 2);
  const unowned = setup();
  unowned.bridge.observe(name());
  unowned.bridge.observe(create({ pid: 43 }));
  unowned.bridge.observe(flush());
  pair(unowned.bridge);
  unowned.bridge.observe(end());
  assert.equal(count(unowned.bridge.finish()), 0);
  const overflow = createPersistentFilterIoOwnerScope();
  for (let n = 1; n <= 64; n++) overflow.observeStageLine(stage({ ownerProcessId: n }));
  rejects(() => overflow.observeStageLine(stage({ ownerProcessId: 65 })));
});

test('original fixed test diagnostic envelope extracts only owner-stage from long-persistent cases', () => {
  const envelope = {
    kind: 'responses',
    mode: 'long-persistent',
    phase: 'owner-stage',
    ...JSON.parse(stage()),
    ownerEpoch: 1,
  };
  const scope = createPersistentFilterIoOwnerScope();
  scope.observeTestDiagnosticLine('# ' + JSON.stringify(envelope));
  assert.equal(scope.snapshot().ownersObserved, 1);
  for (const extra of [
    { phase: 'startup' },
    { mode: 'json' },
    { kind: 'other' },
    { ownerEpoch: 0 },
    { arbitrary: 'PRIVATE' },
  ]) {
    rejects(() =>
      createPersistentFilterIoOwnerScope().observeTestDiagnosticLine(
        '# ' + JSON.stringify({ ...envelope, ...extra })
      )
    );
  }
});

test('canonical scalar boundaries reject line terminators and coercion objects without executing them', () => {
  for (const key of ['time', 'irp']) {
    const { bridge } = setup();
    const row = end();
    row[key] += '\n';
    rejects(() => bridge.observe(row));
  }
  rejects(() =>
    createPersistentFilterIoOwnerScope().observeStageLine(stage({ fixtureTag: tag + '\n' }))
  );
  const { bridge } = setup();
  const row = end();
  row.type = {
    [Symbol.toPrimitive]() {
      assert.fail('must not coerce');
    },
  };
  rejects(() => bridge.observe(row));
  for (const frequency of ['0', '01', '1\n', '9223372036854775808'])
    rejects(() =>
      createPersistentFilterIoBridge({
        clock: { ...clock, frequency },
        ownerScope: createPersistentFilterIoOwnerScope(),
      })
    );
});

test('span candidate budget is global, including unmatched input; extreme QPC keeps exact delta', () => {
  const { bridge } = setup();
  for (let n = 0; n < LIMITS.spans; n++) bridge.observe(filter());
  rejects(() => bridge.observe(filter()));
  const high = setup().bridge;
  const offset = 9007199254740993n;
  for (const row of [
    name(),
    create(),
    flush(),
    filter(),
    filter('filter-complete', 6, 98),
    end(),
  ]) {
    row.time = String(offset + BigInt(row.time));
    if (row.type === 'filter-complete') row.initialTime = String(offset + 4n);
    high.observe(row);
  }
  assert.equal(high.finish().rows[0].maxObservedSpanUs, 2);
});

test('raw DTO lines have an explicit QPC clock and reject duplicates, oversized, extra or malformed data', () => {
  assert.deepEqual(
    parsePersistentFilterIoRawLine('{"type":"clock","kind":"qpc","frequency":"1000000"}'),
    { type: 'clock', kind: 'qpc', frequency: '1000000' }
  );
  assert.deepEqual(parsePersistentFilterIoRawLine(JSON.stringify(end())), end());
  for (const line of [
    '',
    '{}',
    'x'.repeat(2049),
    JSON.stringify(end()) + '\n',
    '{"type":"clock","kind":"qpc","frequency":"1","frequency":"2"}',
    '{"type":"clock","kind":"utc","frequency":"1"}',
    JSON.stringify({ ...end(), private: 'PRIVATE' }),
  ])
    rejects(() => parsePersistentFilterIoRawLine(line));
});

test('Create reusing an active flush IRP cannot let its unrelated OpEnd close old candidates', () => {
  const { bridge } = setup();
  opened(bridge);
  pair(bridge);
  bridge.observe({ ...create({ fileObject: p(88), irp: p(4) }), time: '6' });
  bridge.observe(end());
  assert.equal(count(bridge.finish()), 0);
});

test('real nonflush IRP reuse and Close taint the old epoch without manufacturing completion or status', () => {
  for (const opcode of [64, 65, 66, 67, 68, 69, 70, 71, 72, 74, 75, 77]) {
    const { bridge } = setup();
    opened(bridge);
    pair(bridge);
    bridge.observe(raw('invalidate-irp', 6, opcode, { irp: p(4) }));
    bridge.observe(end());
    const result = bridge.finish();
    assert.equal(count(result), 0, String(opcode));
    assert.ok(result.mismatches.irpLifecycle > 0);
  }
  const { bridge } = setup();
  opened(bridge);
  pair(bridge);
  bridge.observe(raw('close', 6, 66, { fileObject: p(99), irp: p(4) }));
  bridge.observe(end());
  assert.equal(count(bridge.finish()), 0);
  const unfinished = setup().bridge;
  opened(unfinished);
  pair(unfinished);
  unfinished.observe(raw('invalidate-irp', 6, 65, { irp: p(4) }));
  const result = unfinished.finish();
  assert.equal(count(result), 0);
  assert.equal(result.mismatches.unfinishedIrp, 1);
});

test('unrelated IRP invalidation preserves a complete flush, while missing/unknown invalidation DTOs reject', () => {
  const { bridge } = setup();
  opened(bridge);
  pair(bridge);
  bridge.observe(raw('invalidate-irp', 6, 65, { irp: p(99) }));
  bridge.observe(end());
  assert.equal(count(bridge.finish()), 1);
  for (const row of [
    raw('invalidate-irp', 6, 73, { irp: p(4) }),
    raw('invalidate-irp', 6, 65, {}),
    raw('close', 6, 66, { fileObject: p(2) }),
  ])
    rejects(() => setup().bridge.observe(row));
});

test('actual compiled TDH raw reader fixture pipes into strict bridge with distinct FileKey and FileObject', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'fixtures/persistent-filterio-native.ps1'),
      path.resolve(__dirname, '..'),
      '-RawFixture',
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 8192 }
  );
  assert.equal(Boolean(result.error), false, 'compiled_raw_fixture_launch_failed');
  assert.equal(result.status, 0, 'compiled_raw_fixture_failed');
  assert.equal(result.stderr.length, 0, 'compiled_raw_fixture_stderr');
  const lines = result.stdout.trimEnd().split(/\r?\n/).map(parsePersistentFilterIoRawLine);
  const rawClock = lines.shift();
  assert.equal(rawClock.type, 'clock');
  assert.equal(rawClock.frequency, '1000000');
  const nameRow = lines.find((row) => row.type === 'name');
  const created = lines.find((row) => row.type === 'create');
  assert.equal(nameRow.fileKey === created.fileObject, false);
  function connect(rows) {
    const ownerScope = createPersistentFilterIoOwnerScope();
    ownerScope.observeStageLine(stage({ fixtureTag: created.fixtureTag }));
    const bridge = createPersistentFilterIoBridge({
      ownerScope,
      clock: { ...clock, frequency: rawClock.frequency },
    });
    for (const row of rows) bridge.observe(row);
    return bridge.finish();
  }
  const positive = connect(lines);
  assert.equal(count(positive), 1);
  assert.equal(positive.rows[0].maxObservedSpanUs, 30);
  assert.equal(positive.nativeCaptureQualified, false);
  assert.equal(positive.filterAttributionQualified, false);
  const operation = lines.find((row) => row.type === 'flush');
  const ended = lines.find((row) => row.type === 'end');
  const conflict = {
    ...created,
    fileObject: p(999),
    irp: operation.irp,
    time: String(BigInt(ended.time) - 1n),
  };
  const negative = lines.flatMap((row) => (row === ended ? [conflict, row] : [row]));
  assert.equal(count(connect(negative)), 0);
});
