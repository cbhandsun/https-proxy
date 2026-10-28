'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
const { OPERATION_TYPES } = require('./persistent-io-operation-summary');
const { validatePersistentIoScheduling } = require('./persistent-io-scheduling');
const { validatePersistentIoWindows } = require('./persistent-io-windows');
const { requiredCoverageIoWindows } = require('./coverage-io-windows');
const { coverageIoRecorderFailureDetail } = require('./coverage-io-recorder-failure');
const { coverageIoVerifyScope } = require('./coverage-io-verify-scope');
const fail = () => new Error('coverage_io_capture_failed');
const isSha = (value) =>
  typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
const READY = 'HPM_PERSISTENT_IO_CAPTURE_READY';
const PREFIX = 'HPM_PERSISTENT_IO=';
const WORKFLOWS = [
  ['windows-persistent-io-coverage.yml', 'coverage-file-flush'],
  ['verify.yml', 'coverage'],
];
const KEYS = [
  'schemaVersion',
  'scope',
  'events',
  'pairedFlushes',
  'database',
  'journal',
  'collisions',
  'unmatchedEnds',
  'failedFlushes',
  'unfinishedFlushes',
  'traceCompletenessVerified',
  'fiveSecondQualified',
  'realModelRequests',
];
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw fail();
}
function parseSummary(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw fail();
  const value = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw fail();
  const extended = [2, 3, 4, 5, 6].includes(value?.schemaVersion);
  exact(
    value,
    value?.schemaVersion === 6
      ? [...KEYS, 'ioOperations', 'ioScheduling', 'ioWindows']
      : value?.schemaVersion === 5
        ? [...KEYS, 'ioOperations', 'ioScheduling']
        : extended
          ? [...KEYS, 'ioOperations']
          : KEYS
  );
  if (
    ![1, 2, 3, 4, 5, 6].includes(value.schemaVersion) ||
    value.scope !==
      (extended ? 'synthetic_sqlite_etw_file_operations' : 'synthetic_sqlite_etw_flush_pairs') ||
    value.traceCompletenessVerified !== false ||
    value.fiveSecondQualified !== false ||
    value.realModelRequests !== 0 ||
    value.collisions !== 0
  )
    throw fail();
  for (const key of [
    'events',
    'pairedFlushes',
    'collisions',
    'unmatchedEnds',
    'failedFlushes',
    'unfinishedFlushes',
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100000) throw fail();
  }
  for (const key of ['database', 'journal']) {
    exact(value[key], ['count', 'maxMs', 'over100Ms', 'over1000Ms']);
    for (const number of Object.values(value[key]))
      if (!Number.isSafeInteger(number) || number < 0) throw fail();
    const stats = value[key];
    if (
      stats.count > value.pairedFlushes ||
      stats.over1000Ms > stats.over100Ms ||
      stats.over100Ms > stats.count ||
      (!stats.count && stats.maxMs !== 0)
    )
      throw fail();
  }
  if (
    !value.pairedFlushes ||
    value.events < value.pairedFlushes * 2 ||
    value.pairedFlushes !== value.database.count + value.journal.count
  )
    throw fail();
  if (value.schemaVersion >= 5) validatePersistentIoScheduling(value.ioScheduling, value.events);
  if (extended && !(value.schemaVersion >= 5 && value.ioOperations === null))
    validateIoOperations(
      value.ioOperations,
      value.events,
      value.pairedFlushes,
      value.schemaVersion >= 3,
      value.schemaVersion >= 4
    );
  if (value.schemaVersion === 6) validatePersistentIoWindows(value.ioWindows, value);
  return value;
}
function validateIoOperations(operations, events, flushes, statuses, creates) {
  const operationTypes = OPERATION_TYPES.filter((type) => creates || type !== 'create');
  exact(operations, ['collisions', 'unfinished', ...operationTypes]);
  let completed = 0;
  for (const [name, maximum] of [
    ['collisions', 100000],
    ['unfinished', 8192],
  ]) {
    if (
      !Number.isSafeInteger(operations[name]) ||
      operations[name] < 0 ||
      operations[name] > maximum
    )
      throw fail();
  }
  for (const type of operationTypes) {
    exact(operations[type], ['database', 'journal']);
    for (const stats of Object.values(operations[type])) {
      exact(stats, [
        'count',
        'maxMs',
        'over100Ms',
        'over1000Ms',
        'nonZeroStatus',
        'maxNonZeroStatusMs',
        'accessDenied',
        'sharingViolation',
        'lockConflict',
        ...(statuses ? ['statuses'] : []),
      ]);
      for (const [name, value] of Object.entries(stats)) {
        if (name === 'statuses') continue;
        if (
          !Number.isSafeInteger(value) ||
          value < 0 ||
          (!['maxMs', 'maxNonZeroStatusMs'].includes(name) && value > 100000)
        )
          throw fail();
      }
      if (
        stats.over1000Ms > stats.over100Ms ||
        stats.over100Ms > stats.count ||
        (!stats.count && stats.maxMs !== 0) ||
        (!stats.nonZeroStatus && stats.maxNonZeroStatusMs !== 0) ||
        stats.accessDenied + stats.sharingViolation + stats.lockConflict > stats.nonZeroStatus ||
        stats.over100Ms > 0 !== (stats.count > 0 && stats.maxMs >= 100) ||
        stats.over1000Ms > 0 !== (stats.count > 0 && stats.maxMs >= 1000)
      )
        throw fail();
      if (statuses) validateStatuses(stats);
      completed += stats.count + stats.nonZeroStatus;
    }
  }
  if (
    completed + flushes > Math.floor(events / 2) ||
    (!completed && !operations.collisions && !operations.unfinished)
  )
    throw fail();
}
function validateStatuses(stats) {
  if (!Array.isArray(stats.statuses) || stats.statuses.length > 16) throw fail();
  let previous = 0,
    count = 0;
  const classified = new Map();
  for (const row of stats.statuses) {
    exact(row, ['code', 'count']);
    if (
      !Number.isSafeInteger(row.code) ||
      row.code <= previous ||
      row.code > 0xffffffff ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1 ||
      row.count > 100000
    )
      throw fail();
    previous = row.code;
    count += row.count;
    classified.set(row.code, row.count);
  }
  if (
    count !== stats.nonZeroStatus ||
    (classified.get(0xc0000022) ?? 0) !== stats.accessDenied ||
    (classified.get(0xc0000043) ?? 0) !== stats.sharingViolation ||
    (classified.get(0xc0000054) ?? 0) !== stats.lockConflict
  )
    throw fail();
}
function validWindow(windowId) {
  if (
    ![
      'client-context-target',
      'publication-graceful-http',
      'native-publication-interruption',
    ].includes(windowId)
  )
    throw fail();
}
function captureWindows(environment) {
  try {
    return requiredCoverageIoWindows(environment);
  } catch {
    throw fail();
  }
}
function receiptPath(environment, windowId = 'client-context-target') {
  validWindow(windowId);
  if (!isSha(environment.GITHUB_SHA) || !captureWindows(environment).includes(windowId))
    throw fail();
  return path.join(
    safePath(environment.RUNNER_TEMP, true),
    'hpm-coverage-io-' +
      environment.GITHUB_SHA +
      '-' +
      environment.HPM_COVERAGE_IO_STAGE +
      (windowId === 'client-context-target' ? '' : '-' + windowId) +
      '.json'
  );
}
function readCoverageIoReceipt(environment = process.env, windowId = 'client-context-target') {
  const file = safePath(receiptPath(environment, windowId));
  const pin = fs.statSync(file, { bigint: true });
  if (pin.size < 2n || pin.size > 16384n || pin.nlink !== 1n) throw fail();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const unchanged = (stat) =>
      ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].every((key) => stat[key] === pin[key]);
    if (!unchanged(opened)) throw fail();
    const buffer = Buffer.alloc(16385);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (BigInt(length) !== pin.size || !unchanged(fs.fstatSync(descriptor, { bigint: true })))
      throw fail();
    text = buffer.subarray(0, length).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  const value = JSON.parse(text);
  if (JSON.stringify(value) + '\n' !== text) throw fail();
  exact(value, [
    'schemaVersion',
    'sourceSha',
    'coverageStage',
    'cleanupVerified',
    'summary',
    ...([2, 3].includes(value.schemaVersion) ? ['windowTermination'] : []),
    ...(value.schemaVersion === 3 ? ['windowId'] : []),
  ]);
  if (
    !(windowId === 'client-context-target' ? [1, 2] : [3]).includes(value.schemaVersion) ||
    (value.schemaVersion === 3 &&
      (value.windowId !== windowId ||
        !['file-completed', 'publication-fixture-failed'].includes(value.windowTermination))) ||
    (value.schemaVersion === 2 &&
      !['file-completed', 'persistent-request-failed'].includes(value.windowTermination)) ||
    value.sourceSha !== environment.GITHUB_SHA ||
    value.coverageStage !== environment.HPM_COVERAGE_IO_STAGE ||
    value.cleanupVerified !== true
  )
    throw fail();
  parseSummary(JSON.stringify(value.summary));
  return value;
}
function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail()), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Optional recording around this one complete test file. The original shard
// runner, coverage command, case order and request deadlines remain unchanged.
function installCoverageIoCapture(
  test,
  {
    environment = process.env,
    platform = process.platform,
    start = spawn,
    wait = bounded,
    report = (value) => process.stdout.write('# HPM_COVERAGE_IO=' + JSON.stringify(value) + '\n'),
    onReady,
    windowId = 'client-context-target',
  } = {}
) {
  if (!environment || typeof environment !== 'object' || types.isProxy(environment)) throw fail();
  const read = (name) => {
    const slot = Object.getOwnPropertyDescriptor(environment, name);
    if (!slot) return undefined;
    if (!Object.hasOwn(slot, 'value') || typeof slot.value !== 'string') throw fail();
    return slot.value;
  };
  if (read('HPM_COVERAGE_IO') === undefined) return false;
  validWindow(windowId);
  if (
    onReady !== undefined &&
    (typeof onReady !== 'function' ||
      types.isProxy(onReady) ||
      types.isAsyncFunction(onReady) ||
      types.isGeneratorFunction(onReady))
  )
    throw fail();
  const pinned = Object.create(null);
  for (const key of [
    'HPM_COVERAGE_IO',
    'HPM_COVERAGE_IO_STAGE',
    'HPM_COVERAGE_IO_PROXY_WINDOW',
    'HPM_COVERAGE_IO_VERIFY_PROXY_ONLY',
    'npm_lifecycle_event',
    'GITHUB_SHA',
    'GITHUB_ACTIONS',
    'GITHUB_JOB',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_REPOSITORY',
    'GITHUB_WORKSPACE',
    'RUNNER_TEMP',
    'RUNNER_ENVIRONMENT',
    'RUNNER_OS',
    'RUNNER_ARCH',
    'CI',
    'SystemRoot',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
  ]) {
    const value = read(key);
    if (value !== undefined) pinned[key] = value;
  }
  environment = pinned;
  let verifyScope;
  try {
    verifyScope = coverageIoVerifyScope(environment);
  } catch {
    throw fail();
  }
  const sourceWorkflow =
    environment.GITHUB_JOB === 'source-gates' &&
    environment.GITHUB_WORKFLOW_REF?.startsWith(
      'cbhandsun/https-proxy/.github/workflows/windows-context-recovery-hosted.yml@refs/'
    );
  const workflowAllowed =
    verifyScope !== null
      ? sourceWorkflow
      : WORKFLOWS.some(
          ([file, job]) =>
            environment.GITHUB_JOB === job &&
            environment.GITHUB_WORKFLOW_REF?.startsWith(
              'cbhandsun/https-proxy/.github/workflows/' + file + '@refs/'
            )
        );
  if (
    platform !== 'win32' ||
    environment.CI !== 'true' ||
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    environment.RUNNER_OS !== 'Windows' ||
    environment.RUNNER_ARCH !== 'X64' ||
    environment.GITHUB_REPOSITORY !== 'cbhandsun/https-proxy' ||
    !workflowAllowed ||
    !isSha(environment.HPM_COVERAGE_IO) ||
    environment.HPM_COVERAGE_IO !== environment.GITHUB_SHA ||
    !['proxy', 'client'].includes(environment.HPM_COVERAGE_IO_STAGE)
  )
    throw fail();
  // npm verify later runs client coverage in a separate serial command. Keep
  // this source-gate recorder bound to its one original proxy-file window.
  const windows = captureWindows(environment);
  if (verifyScope === 'omit-client') return false;
  // Exactly one proxy file records across the original parallel shards. The
  // two client windows run in the original serial command, never together.
  if (!windows.includes(windowId)) return false;
  let target, entry, parentIdentity;
  try {
    target = receiptPath(environment, windowId);
    parentIdentity = fs.statSync(environment.RUNNER_TEMP, { bigint: true });
    if (fs.existsSync(target)) throw fail();
    entry = safePath(path.join(environment.GITHUB_WORKSPACE, 'scripts/capture-persistent-io.ps1'));
  } catch {
    throw fail();
  }
  const verifyParent = () => {
    if (receiptPath(environment, windowId) !== target) throw fail();
    const current = fs.statSync(environment.RUNNER_TEMP, { bigint: true });
    if (!['dev', 'ino', 'birthtimeNs'].every((key) => current[key] === parentIdentity[key]))
      throw fail();
  };
  let child,
    closed,
    invalid = false,
    readySeen = false,
    finishing = false,
    windowTermination = 'file-completed',
    summary,
    stdout = '',
    stderr = '',
    bytes = 0;
  function finish(reason) {
    if (finishing) return false;
    // Invalid output must still let the owned recorder stop and clean up. The
    // unchanged final checks reject its receipt; this command grants no proof.
    if (!child || !closed) throw fail();
    finishing = true;
    windowTermination = reason;
    child.stdin.end('finish\n');
    return true;
  }
  test.before(
    async () => {
      let ready, refuse;
      const opening = new Promise((resolve, reject) => {
        ready = resolve;
        refuse = reject;
      });
      const bad = () => {
        invalid = true;
        refuse(fail());
      };
      try {
        child = start('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', entry], {
          cwd: environment.GITHUB_WORKSPACE,
          env: environment,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        closed = new Promise((resolve) => {
          child.once('error', () => {
            bad();
            resolve({ code: null, signal: 'spawn' });
          });
          child.once('close', (code, signal) => {
            if (!readySeen || !finishing) bad();
            resolve({ code, signal });
          });
        });
        child.stdin.on('error', bad);
        child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 16384) {
            bad();
            return;
          }
          stdout += chunk.toString('utf8');
          let end;
          while ((end = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, end).replace(/\r$/, '');
            stdout = stdout.slice(end + 1);
            try {
              if (line === READY && !readySeen && !summary) {
                readySeen = true;
                ready();
              } else if (line.startsWith(PREFIX) && readySeen && finishing && !summary)
                summary = parseSummary(line.slice(PREFIX.length));
              else bad();
            } catch {
              bad();
            }
          }
        });
        child.stderr.on('data', (chunk) => {
          if (Buffer.byteLength(stderr) + chunk.length > 16384) {
            bad();
            return;
          }
          stderr += chunk.toString('utf8');
        });
        await wait(opening, 30000);
        if (invalid) throw fail();
        if (onReady)
          onReady(() =>
            finish(
              windowId === 'client-context-target'
                ? 'persistent-request-failed'
                : 'publication-fixture-failed'
            )
          );
      } catch {
        child?.stdin.end('abort\n');
        if (closed) {
          try {
            await wait(closed, 30000);
          } catch {
            child.kill('SIGKILL');
          }
        }
        throw fail();
      }
    },
    { timeout: 65000 }
  );
  test.after(
    async () => {
      if (!child || !closed) throw fail();
      let result;
      try {
        finish('file-completed');
        result = await wait(closed, 300000);
      } catch {
        child.kill('SIGKILL');
        throw fail();
      }
      const trace = /^persistent_io_trace_bytes=([1-9][0-9]{0,8})\r?\n$/.exec(stderr);
      let refusal;
      if (result.signal !== null) refusal = 'recorder_signal';
      else if (result.code !== 0) refusal = 'recorder_exit';
      else if (invalid) refusal = 'protocol';
      else if (stdout !== '') refusal = 'pending_stdout';
      else if (!summary) refusal = 'missing_summary';
      else if (!trace || trace[0] !== stderr) refusal = 'trace_control';
      else if (Number(trace[1]) > 268435456) refusal = 'trace_limit';
      if (refusal) {
        const detail = refusal === 'recorder_exit' ? coverageIoRecorderFailureDetail(stderr) : '';
        const error = new Error('coverage_io_capture_failed' + detail, {
          // Closed vocabulary only; no recorder output or exception crosses.
          cause: new Error('coverage_io_capture_' + refusal),
        });
        // Node's TAP reporter omits cause details; its fixed code is visible.
        error.code = 'coverage_io_capture_' + refusal;
        throw error;
      }
      const receipt = {
        schemaVersion: windowId === 'client-context-target' ? 2 : 3,
        ...(windowId === 'client-context-target' ? {} : { windowId }),
        sourceSha: environment.GITHUB_SHA,
        coverageStage: environment.HPM_COVERAGE_IO_STAGE,
        cleanupVerified: true,
        summary,
        windowTermination,
      };
      try {
        verifyParent();
        fs.writeFileSync(target, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
        verifyParent();
        report(receipt);
      } catch {
        throw fail();
      }
    },
    { timeout: 305000 }
  );
  return true;
}
module.exports = { installCoverageIoCapture, parseSummary, readCoverageIoReceipt };
