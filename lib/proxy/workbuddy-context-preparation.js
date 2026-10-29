'use strict';

const { performance } = require('node:perf_hooks');
const { usesNativeContextPlanning } = require('./context-recovery-policy');
const { planNativeWorkBuddyContext } = require('./workbuddy-native-context');
const { createContextCompactionSchedule } = require('./context-compaction-schedule');
const { captureContextHistorySnapshot } = require('./context-history-branch');
const { prepareWorkBuddyTaskStateContext } = require('./workbuddy-task-state-planner');
const { resolveContextGrowthBudget } = require('./context-growth-budget');
const { estimateTokensForValue } = require('./inline-media');
const { preservesResponsesHistory } = require('./responses-history-policy');
const { createLogger } = require('./logger');

const log = createLogger('workbuddy-context-preparation');
const successful = (response) =>
  response?.ok === true &&
  Number.isInteger(response.status) &&
  response.status >= 200 &&
  response.status < 300;

function unchangedPlan(body, options, schedule) {
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const tokens = estimateTokensForValue(body);
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  return {
    body,
    fits: bytes <= options.targetBodyBytes && tokens <= options.operationalInputTokens,
    changed: false,
    diagnostics: {
      preflightApplied: false,
      originalBodyBytes: bytes,
      finalBodyBytes: bytes,
      originalEstimatedTokens: tokens,
      finalEstimatedTokens: tokens,
      hardBodyBytes: options.targetBodyBytes,
      operationalInputTokens: options.operationalInputTokens,
      originalToolCount: tools,
      selectedToolCount: tools,
      cleanupSavedBytes: 0,
      minimumCleanupSatisfied: true,
      taskStateStatus: 'background_pending',
      backgroundSchedule: schedule,
    },
  };
}

function createBackgroundOperation(produce, parentSignal, diagnosticLog) {
  if (
    typeof produce !== 'function' ||
    (parentSignal != null && !(parentSignal instanceof globalThis.AbortSignal)) ||
    !dataOptions(diagnosticLog, ['error']) ||
    typeof diagnosticLog.error !== 'function'
  )
    throw new TypeError('Invalid background compaction operation');
  const controller = new globalThis.AbortController();
  let state = 'idle',
    candidate = null,
    terminal = null;
  let settleReady;
  const ready = new Promise((resolve) => {
    settleReady = resolve;
  });
  const detach = () => parentSignal?.removeEventListener('abort', close);
  function report(code = 'background_compaction_failed') {
    try {
      diagnosticLog.error({ code }, 'Background compaction failed; original context retained');
    } catch {
      log.error(
        { code: 'background_compaction_log_failed' },
        'Background diagnostic logging failed'
      );
    }
  }
  function discard(result) {
    try {
      const capability =
        result && typeof result === 'object'
          ? Object.getOwnPropertyDescriptor(result, 'pendingCommit')?.value
          : null;
      const rollback =
        capability && typeof capability === 'object'
          ? Object.getOwnPropertyDescriptor(capability, 'rollback')?.value
          : null;
      if (typeof rollback === 'function') rollback.call(capability);
    } catch {
      report('background_compaction_cleanup_failed');
    }
  }
  function close() {
    if (state === 'closed') return false;
    state = 'closed';
    controller.abort();
    discard(candidate);
    candidate = null;
    detach();
    settleReady({ ok: false, reason: 'background_compaction_cancelled' });
    return true;
  }
  const operation = Object.freeze({
    ready,
    start() {
      if (state !== 'idle' || parentSignal?.aborted) {
        if (parentSignal?.aborted) close();
        return false;
      }
      state = 'running';
      // The caller dispatches the main request before calling start(). No
      // summary promise is placed ahead of the authorized main host request.
      Promise.resolve()
        .then(() => (state === 'closed' ? null : produce(controller.signal)))
        .then((result) => {
          if (state === 'closed') {
            discard(result);
            return;
          }
          candidate = result;
          if (
            !dataOptions(result, ['body', 'fits', 'changed', 'pendingCommit', 'diagnostics']) ||
            !dataOptions(
              result.diagnostics,
              result.diagnostics && Reflect.ownKeys(result.diagnostics)
            )
          )
            throw new TypeError('Invalid background compaction candidate');
          if (
            result.fits !== true ||
            result.changed !== true ||
            !result.pendingCommit ||
            (result.diagnostics.taskStateSummaryAttempted &&
              result.diagnostics.taskStateStatus !== 'applied')
          ) {
            discard(result);
            candidate = null;
            state = 'failed';
            detach();
            settleReady({ ok: false, reason: 'background_candidate_unavailable' });
            return;
          }
          state = 'ready';
          settleReady({ ok: true });
        })
        .catch(() => {
          discard(candidate);
          candidate = null;
          if (state !== 'closed') {
            state = 'failed';
            detach();
            report();
            settleReady({ ok: false, reason: 'background_compaction_failed' });
          }
        });
      return true;
    },
    take() {
      if (terminal) return terminal;
      if (state !== 'ready') return { ok: false, reason: 'background_not_ready' };
      try {
        terminal = candidate.pendingCommit.commit();
        if (!dataOptions(terminal, ['ok', 'reason', 'plan']) || typeof terminal.ok !== 'boolean')
          throw new TypeError('Invalid background compaction commit');
      } catch {
        report();
        terminal = { ok: false, reason: 'background_commit_failed' };
      }
      if (!terminal.ok) discard(candidate);
      candidate = null;
      state = terminal.ok ? 'committed' : 'failed';
      detach();
      return terminal;
    },
    close,
  });
  parentSignal?.addEventListener('abort', close, { once: true });
  if (parentSignal?.aborted) close();
  return operation;
}

function dataOptions(value, allowed) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(
      (key) =>
        allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
    )
  );
}

function createWorkBuddyContextPreparation(options = {}) {
  if (!dataOptions(options, ['schedule', 'clock', 'diagnosticLog']))
    throw new TypeError('Invalid context preparation options');
  const schedule =
    options.schedule === undefined ? createContextCompactionSchedule() : options.schedule;
  const clock = options.clock === undefined ? () => performance.now() : options.clock;
  if (
    !dataOptions(schedule, ['observe', 'decide', 'stats']) ||
    typeof schedule.observe !== 'function' ||
    typeof schedule.decide !== 'function' ||
    typeof clock !== 'function' ||
    (options.diagnosticLog !== undefined &&
      (!dataOptions(options.diagnosticLog, ['error']) ||
        typeof options.diagnosticLog.error !== 'function'))
  )
    throw new TypeError('Invalid context preparation options');
  // Capture injected methods now; later caller mutation cannot replace a
  // validated dependency with an accessor or a different observer.
  const observe = schedule.observe.bind(schedule),
    decide = schedule.decide.bind(schedule);
  const diagnosticLog = {
    error: (options.diagnosticLog || log).error.bind(options.diagnosticLog || log),
  };
  return Object.freeze({
    observeMain(key, durationMs) {
      return observe({ key, kind: 'main', durationMs });
    },
    async prepare(body, options, runtime) {
      if (usesNativeContextPlanning(options.contextPolicyOptions || {}))
        return { plan: planNativeWorkBuddyContext(body, options), background: null };
      const snapshot = captureContextHistorySnapshot(
        runtime.historyBranch,
        body,
        options.artifactOwner,
        options.artifactScope
      );
      if (
        !snapshot ||
        options.force === true ||
        preservesResponsesHistory(snapshot.body) ||
        !Number.isSafeInteger(options.operationalInputTokens) ||
        options.operationalInputTokens < 1 ||
        !Number.isSafeInteger(options.targetBodyBytes) ||
        options.targetBodyBytes < 1
      )
        return {
          plan: await prepareWorkBuddyTaskStateContext(body, options, runtime),
          background: null,
        };
      if (options.protectedMessages instanceof Set) {
        const original = body;
        options = {
          ...options,
          protectedMessages: new Set(
            snapshot.body.messages.filter((_entry, index) =>
              options.protectedMessages.has(original.messages[index])
            )
          ),
        };
      }
      body = snapshot.body;
      const growth = resolveContextGrowthBudget(body, options.targetBodyBytes, options);
      const decision = decide({
        key: runtime.policyKey,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
        inputTokens: estimateTokensForValue(body),
        hardBodyBytes: options.targetBodyBytes,
        inputTokenLimit: options.operationalInputTokens,
        growthReserveBytes: growth.growthReserveBytes,
        preflightBodyBytes: Math.min(
          options.preflightBodyBytes || options.targetBodyBytes,
          options.targetBodyBytes
        ),
      });
      if (decision.mode !== 'background')
        return {
          plan: await prepareWorkBuddyTaskStateContext(body, options, runtime),
          background: null,
        };
      const background = createBackgroundOperation(
        (signal) =>
          prepareWorkBuddyTaskStateContext(
            body,
            {
              ...options,
              preflightBodyBytes: Math.max(1, decision.triggerBodyBytes),
              growthReserveBytes: decision.reserveBytes,
              // A measured token forecast may trigger before the byte trigger.
              ...(estimateTokensForValue(body) > decision.triggerInputTokens
                ? { preflightBodyBytes: 1 }
                : {}),
            },
            {
              ...runtime,
              signal,
              deferCommit: true,
              requestSummary: async (request, requestOptions) => {
                const started = clock();
                const response = await runtime.requestSummary(request, requestOptions);
                const elapsed = clock() - started;
                if (
                  successful(response) &&
                  Number.isFinite(elapsed) &&
                  elapsed >= 0 &&
                  elapsed <= 3600000
                )
                  observe({
                    key: runtime.policyKey,
                    kind: 'summary',
                    durationMs: elapsed,
                  });
                return response;
              },
            }
          ),
        runtime.signal,
        diagnosticLog
      );
      return { plan: unchangedPlan(body, options, decision), background };
    },
  });
}

module.exports = { createWorkBuddyContextPreparation, createBackgroundOperation };
