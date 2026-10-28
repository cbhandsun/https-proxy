'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectNativeDayHealth } = require('../scripts/lib/context-recovery-native-day-health');
const { CAPACITY_PROFILES } = require('../scripts/lib/context-recovery-capacity-workload');

function fixture() {
  const pin = {
    taskName: 'HPM-native-day-test',
    pid: 42,
    head: 'a'.repeat(40),
    sourceSha256: 'b'.repeat(64),
    nativeSha256: 'c'.repeat(64),
    nodeSha256: 'd'.repeat(64),
    node: 'v22.22.3',
    startedAtUtc: '2026-10-26T00:00:00.000Z',
    creationDate: '2026-10-25T23:59:59.000Z',
  };
  const events = [
    {
      event: 'task_status',
      taskName: pin.taskName,
      state: 'Running',
      lastTaskResult: 267009,
      checkedAtUtc: '2026-10-26T00:16:00.000Z',
    },
    {
      event: 'identity',
      ...pin,
      dirty: false,
      storageResolvedToCheckout: true,
      platform: 'win32',
      arch: 'x64',
    },
    {
      event: 'owned_process_status',
      pid: pin.pid,
      alive: true,
      executableMatches: true,
      creationDate: pin.creationDate,
    },
    {
      event: 'process_launched',
      pid: pin.pid,
      sourceHead: pin.head,
      sourceSha256: pin.sourceSha256,
      nativeSha256: pin.nativeSha256,
      nodeSha256: pin.nodeSha256,
    },
    {
      event: 'native_day_started',
      atUtc: pin.startedAtUtc,
      scheduledMs: 0,
      realtime24hStarted: true,
    },
    {
      event: 'capacity_tick',
      atUtc: '2026-10-26T00:15:00.000Z',
      scheduledMs: 900000,
      elapsedMs: 900003,
      realtime24hStarted: true,
    },
    {
      event: 'progress_integrity',
      invalidCompleteLines: 0,
      timelineErrors: 0,
      identityCount: 1,
      startedCount: 1,
      tickCount: 4,
      bytes: 4000,
      expiryAttempts: [],
    },
  ];
  events.at(-1).tickSamples = Array.from({ length: 4 }, (_, i) => ({
    scheduledMs: i * 300000,
    elapsedMs: i * 300000 + 3,
    atUtc: new Date(Date.parse(pin.startedAtUtc) + i * 300000).toISOString(),
  }));
  return { pin, events };
}
function event(f, name) {
  return f.events.find((value) => value.event === name);
}
function complete(f) {
  Object.assign(event(f, 'task_status'), {
    state: 'Ready',
    lastTaskResult: 0,
    checkedAtUtc: '2026-10-27T00:01:00.000Z',
  });
  Object.assign(event(f, 'owned_process_status'), { alive: false });
  Object.assign(event(f, 'capacity_tick'), {
    atUtc: '2026-10-26T23:55:00.000Z',
    scheduledMs: 86100000,
    elapsedMs: 86100001,
  });
  Object.assign(event(f, 'progress_integrity'), { tickCount: 288, expiryAttempts: [1, 2] });
  event(f, 'progress_integrity').lastWriteAtUtc = '2026-10-27T00:00:05.000Z';
  event(f, 'progress_integrity').tickSamples = Array.from({ length: 288 }, (_, i) => ({
    scheduledMs: i * 300000,
    elapsedMs: i * 300000 + 1,
    atUtc: new Date(Date.parse(f.pin.startedAtUtc) + i * 300000).toISOString(),
  }));
  f.events.push({
    event: 'root_expiry_elapsed',
    elapsedMs: 86404000,
    expiryWaitCompleted: true,
    rootsObserved: 1,
    minRootExpiresAt: Date.parse(f.pin.startedAtUtc) + 86400010,
    maxRootExpiresAt: Date.parse(f.pin.startedAtUtc) + 86400010,
  });
  f.events.push({
    event: 'native_day_completed',
    realtime24hPassed: true,
    realModelRequests: 0,
    expiredReopens: 2,
    storeOpens: 15,
    storeCloses: 15,
    clock: { elapsedMs: 86405000, scheduledMs: 86400000 },
    report: {
      profile: CAPACITY_PROFILES[0],
      completedTurns: 288,
      verifiedRecoveries: 24,
      reopenCount: 12,
      finalResultsObserved: true,
      firstCoverageGap: null,
      firstFailure: null,
      firstReadFailure: null,
      qualified: true,
    },
  });
  f.events.push({ event: 'process_finished', exitCode: 0, reason: 'child_exit' });
  return f;
}

test('fresh real progress requires process, launch and source identity, never wall time alone', () => {
  const f = fixture(),
    result = inspectNativeDayHealth(f);
  assert.equal(result.state, 'running');
  assert.equal(result.passed, false);
  assert.equal(result.lastScheduledMs, 900000);
  f.previous = { taskName: f.pin.taskName, lastScheduledMs: 600000, elapsedMs: 600005 };
  assert.equal(inspectNativeDayHealth(f).reason, 'progress_advanced');
});

test('a half-hour terminal failure wins even if the task and process still look alive or later startup exists', () => {
  for (const terminal of [
    { event: 'native_day_failed' },
    { event: 'controller_failed' },
    { event: 'process_finished', exitCode: 1 },
  ]) {
    const f = fixture();
    f.events.push(terminal, { event: 'startup', phase: 'ready' });
    event(f, 'task_status').checkedAtUtc = '2026-10-27T00:30:00.000Z';
    const result = inspectNativeDayHealth(f);
    assert.equal(result.state, 'failed');
    assert.equal(result.passed, false);
    assert.equal(result.lastScheduledMs, 900000);
  }
});

test('a live process with stalled work is flagged within ten minutes of the last real tick', () => {
  const f = fixture();
  event(f, 'task_status').checkedAtUtc = '2026-10-26T00:25:00.001Z';
  assert.equal(inspectNativeDayHealth(f).state, 'stalled');
  event(f, 'task_status').checkedAtUtc = '2026-10-26T00:25:00.000Z';
  assert.equal(inspectNativeDayHealth(f).state, 'running');
});

test('a past continuity gap cannot be hidden by a fresh latest tick or nominal wall-clock duration', () => {
  const f = fixture(),
    samples = event(f, 'progress_integrity').tickSamples;
  for (let i = 1; i < samples.length; i++) {
    samples[i].elapsedMs += 3600000;
    samples[i].atUtc = new Date(Date.parse(samples[i].atUtc) + 3600000).toISOString();
  }
  Object.assign(event(f, 'capacity_tick'), samples.at(-1));
  event(f, 'task_status').checkedAtUtc = '2026-10-26T01:16:00.000Z';
  const result = inspectNativeDayHealth(f);
  assert.equal(result.state, 'unverified');
  assert.equal(result.reason, 'continuity_gap');
  assert.equal(result.passed, false);
});

test('missing identity, corrupt timeline, changed PID or changed source can never receive running credit', () => {
  const changes = [
    (f) => {
      event(f, 'identity').dirty = true;
    },
    (f) => {
      event(f, 'identity').head = 'f'.repeat(40);
    },
    (f) => {
      event(f, 'process_launched').nativeSha256 = 'f'.repeat(64);
    },
    (f) => {
      event(f, 'owned_process_status').pid++;
    },
    (f) => {
      event(f, 'owned_process_status').creationDate = '2026-10-26T00:00:02.000Z';
    },
    (f) => {
      event(f, 'owned_process_status').executableMatches = false;
    },
    (f) => {
      event(f, 'progress_integrity').invalidCompleteLines = 1;
    },
    (f) => {
      event(f, 'progress_integrity').timelineErrors = 1;
    },
    (f) => {
      event(f, 'progress_integrity').startedCount = 2;
    },
    (f) => {
      event(f, 'progress_integrity').tickCount = 3;
    },
    (f) => {
      event(f, 'progress_integrity').tickSamples[1].scheduledMs = 600000;
    },
    (f) => {
      event(f, 'progress_integrity').tickSamples[1].elapsedMs = -1;
    },
    (f) => {
      event(f, 'progress_integrity').tickSamples[1].atUtc = f.pin.creationDate;
    },
    (f) => {
      event(f, 'progress_integrity').tickSamples[1].atUtc = '2026-10-26T00:00:01.000Z';
    },
    (f) => {
      event(f, 'capacity_tick').elapsedMs = 899999;
    },
    (f) => {
      event(f, 'capacity_tick').atUtc = '2026-10-26T01:00:00.000Z';
    },
    (f) => {
      f.events = f.events.filter((v) => v.event !== 'identity');
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const result = inspectNativeDayHealth(f);
    assert.equal(result.state, 'unverified');
    assert.equal(result.passed, false);
  }
});

test('stopped process, missing completion and progress rollback remain distinct failure evidence', () => {
  let f = fixture();
  event(f, 'owned_process_status').alive = false;
  assert.equal(inspectNativeDayHealth(f).reason, 'process_not_running');
  f = fixture();
  f.events.push({ event: 'process_finished', exitCode: 0 });
  assert.equal(inspectNativeDayHealth(f).reason, 'exit_without_completion');
  f = fixture();
  f.previous = { taskName: f.pin.taskName, lastScheduledMs: 1200000, elapsedMs: 1200001 };
  assert.equal(inspectNativeDayHealth(f).reason, 'progress_rollback');
});

test('passing requires a full fixed profile, actual day, both expiry reopens and verified zero exit', () => {
  const result = inspectNativeDayHealth(complete(fixture()));
  assert.equal(result.state, 'passed');
  assert.equal(result.passed, true);
  for (const change of [
    (f) => {
      event(f, 'native_day_completed').report.completedTurns = 287;
    },
    (f) => {
      event(f, 'native_day_completed').report.reopenCount = 0;
    },
    (f) => {
      event(f, 'native_day_completed').clock.elapsedMs = 86399999;
    },
    (f) => {
      event(f, 'native_day_completed').clock.scheduledMs = 86100000;
    },
    (f) => {
      event(f, 'root_expiry_elapsed').elapsedMs = 86399999;
    },
    (f) => {
      event(f, 'root_expiry_elapsed').expiryWaitCompleted = false;
    },
    (f) => {
      event(f, 'root_expiry_elapsed').maxRootExpiresAt = Date.parse('2026-10-27T00:02:00.000Z');
    },
    (f) => {
      event(f, 'progress_integrity').expiryAttempts = [1];
    },
    (f) => {
      event(f, 'task_status').checkedAtUtc = '2026-10-26T23:59:59.000Z';
    },
    (f) => {
      event(f, 'task_status').lastTaskResult = 1;
    },
    (f) => {
      event(f, 'owned_process_status').alive = true;
    },
    (f) => {
      event(f, 'native_day_completed').storeCloses = 14;
    },
    (f) => {
      event(f, 'native_day_completed').realModelRequests = 1;
    },
    (f) => {
      event(f, 'native_day_completed').realtime24hPassed = false;
    },
  ]) {
    const f = complete(fixture());
    change(f);
    assert.notEqual(inspectNativeDayHealth(f).state, 'passed');
  }
  const f = complete(fixture());
  f.events = f.events.filter((v) => v.event !== 'process_finished');
  assert.equal(inspectNativeDayHealth(f).state, 'finishing');
  event(f, 'task_status').checkedAtUtc = '2026-10-27T00:11:00.000Z';
  assert.equal(inspectNativeDayHealth(f).reason, 'exit_receipt_stalled');
});

for (const taskState of ['Queued', 'Unknown', null, 'Running']) {
  test(
    'complete receipts cannot pass without a successful terminal task state: ' + String(taskState),
    () => {
      const f = complete(fixture());
      event(f, 'task_status').state = taskState;
      const health = inspectNativeDayHealth(f);
      assert.equal(health.passed, false);
      assert.equal(health.state, 'unverified');
      assert.equal(health.reason, 'exit_not_verified');
      assert.equal(health.terminalConfirmed, false);
    }
  );
}

for (const taskState of ['Ready', 'Disabled']) {
  test(
    'complete verified zero-exit receipts retain valid terminal task state: ' + taskState,
    () => {
      const f = complete(fixture());
      event(f, 'task_status').state = taskState;
      const health = inspectNativeDayHealth(f);
      assert.equal(health.passed, true);
      assert.equal(health.state, 'passed');
      assert.equal(health.reason, 'qualified_completion');
      assert.equal(health.terminalConfirmed, true);
    }
  );
}

test('empty, illegal, oversized, duplicated and executable observations fail with a fixed private-safe error', () => {
  let hooks = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        hooks++;
        throw Error();
      },
      ownKeys() {
        hooks++;
        throw Error();
      },
    }
  );
  const duplicate = fixture();
  duplicate.events.push({ ...event(duplicate, 'identity') });
  for (const value of [
    null,
    [],
    {},
    proxy,
    { pin: {}, events: Array(33).fill({}) },
    { value: 'PRIVATE'.repeat(30000) },
    duplicate,
  ])
    assert.throws(() => inspectNativeDayHealth(value), { message: 'native_day_health_invalid' });
  assert.equal(hooks, 0);
});

test('unverified health receipts never echo arbitrary fields as numeric progress or timestamps', () => {
  const f = fixture();
  event(f, 'identity').dirty = true;
  event(f, 'capacity_tick').scheduledMs = { headers: 'PRIVATE synthetic token' };
  event(f, 'capacity_tick').elapsedMs = 'PRIVATE synthetic original';
  event(f, 'task_status').checkedAtUtc = 'PRIVATE synthetic response';
  const result = inspectNativeDayHealth(f);
  assert.equal(result.state, 'unverified');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.lastScheduledMs, null);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.checkedAtUtc, null);
});

test('a storage failure is reported before the outer process exits and cannot be hidden by later completion', () => {
  const f = fixture();
  f.events.push({
    event: 'storage_operation_failed',
    stage: 'capacity',
    attempt: 1,
    operation: 'sweep',
    phase: 'anchor-persist',
    cleanupFailed: false,
  });
  const live = inspectNativeDayHealth(f);
  assert.equal(live.state, 'failed');
  assert.equal(live.reason, 'storage_operation_failed');
  assert.equal(live.passed, false);
  assert.equal(live.processAlive, true);
  assert.equal(live.terminalConfirmed, false);
  complete(f);
  const stopped = inspectNativeDayHealth(f);
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.passed, false);
  assert.equal(stopped.terminalConfirmed, true);
});

test('an observed failure survives a later bounded window without the failure event', () => {
  const f = fixture();
  f.events.push({ event: 'storage_operation_failed' });
  f.previous = inspectNativeDayHealth(f);
  f.events = f.events.filter((value) => value.event !== 'storage_operation_failed');
  const live = inspectNativeDayHealth(f);
  assert.equal(live.state, 'failed');
  assert.equal(live.reason, 'previous_failure');
  assert.equal(live.failureLatched, true);
  assert.equal(live.terminalConfirmed, false);
  f.previous = live;
  complete(f);
  const completed = inspectNativeDayHealth(f);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.passed, false);
  assert.equal(completed.terminalConfirmed, true);
});

test('failure history is bound to the exact run and never grants process termination', () => {
  const failed = fixture();
  failed.events.push({ event: 'storage_operation_failed' });
  const previous = inspectNativeDayHealth(failed);
  for (const change of [
    (f) => {
      f.pin.head = 'e'.repeat(40);
    },
    (f) => {
      f.pin.pid++;
    },
    (f) => {
      f.pin.startedAtUtc = '2026-10-26T00:00:01.000Z';
    },
    (f) => {
      f.pin.creationDate = '2026-10-25T23:59:58.000Z';
    },
    (f) => {
      f.previous.runIdentity = '';
    },
    (f) => {
      f.previous.failureLatched = false;
    },
  ]) {
    const f = fixture();
    f.previous = { ...previous };
    change(f);
    const result = inspectNativeDayHealth(f);
    assert.notEqual(result.reason, 'previous_failure');
    assert.equal(result.failureLatched, false);
    assert.equal(result.terminalConfirmed, false);
  }
  const unrelated = fixture();
  event(unrelated, 'identity').head = 'e'.repeat(40);
  unrelated.events.push({ event: 'storage_operation_failed' });
  assert.equal(inspectNativeDayHealth(unrelated).failureLatched, false);
});

test('monitor termination needs the pinned owner, stopped process, matching task result and real exit receipt', () => {
  const stopped = () => {
    const f = fixture();
    f.events.push(
      { event: 'native_day_failed' },
      { event: 'process_finished', exitCode: 1, reason: 'child_exit' }
    );
    Object.assign(event(f, 'owned_process_status'), { alive: false });
    Object.assign(event(f, 'task_status'), { state: 'Ready', lastTaskResult: 1 });
    return f;
  };
  assert.equal(inspectNativeDayHealth(stopped()).terminalConfirmed, true);
  for (const change of [
    (f) => {
      event(f, 'owned_process_status').alive = true;
    },
    (f) => {
      event(f, 'owned_process_status').pid++;
    },
    (f) => {
      event(f, 'identity').head = 'e'.repeat(40);
    },
    (f) => {
      event(f, 'process_launched').nativeSha256 = 'e'.repeat(64);
    },
    (f) => {
      event(f, 'task_status').state = 'Running';
    },
    (f) => {
      event(f, 'task_status').state = 'Queued';
    },
    (f) => {
      event(f, 'task_status').lastTaskResult = 0;
    },
    (f) => {
      event(f, 'task_status').checkedAtUtc = 'PRIVATE';
    },
    (f) => {
      event(f, 'task_status').checkedAtUtc = '2026-10-25T00:00:00Z';
    },
    (f) => {
      event(f, 'process_finished').reason = 'PRIVATE';
    },
    (f) => {
      event(f, 'process_finished').exitCode = '1';
    },
    (f) => {
      event(f, 'process_finished').exitCode = 0.5;
    },
    (f) => {
      event(f, 'process_finished').exitCode = 4294967296;
    },
    (f) => {
      f.events = f.events.filter((value) => value.event !== 'process_finished');
    },
    (f) => {
      f.events = f.events.filter((value) => value.event !== 'owned_process_status');
    },
  ]) {
    const f = stopped();
    change(f);
    const health = inspectNativeDayHealth(f);
    assert.equal(health.state, 'failed');
    assert.equal(health.terminalConfirmed, false);
    assert.equal(health.passed, false);
    assert.equal(JSON.stringify(health).includes('PRIVATE'), false);
  }
  const negativeExit = stopped();
  event(negativeExit, 'process_finished').exitCode = -1073741819;
  event(negativeExit, 'task_status').lastTaskResult = 3221225477;
  assert.equal(inspectNativeDayHealth(negativeExit).terminalConfirmed, true);
  assert.equal(inspectNativeDayHealth(complete(fixture())).terminalConfirmed, true);
});
