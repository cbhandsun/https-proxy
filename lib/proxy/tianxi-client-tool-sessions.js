'use strict';

const { randomUUID, createHash } = require('node:crypto');
const {
  compileTianxiClientRead,
  tianxiClientReadMetadata,
  tianxiClientCommandInput,
  tianxiClientArgumentFailure,
} = require('./tianxi-client-read-tools');
const { assertTianxiPermissionSupported } = require('./tianxi-permission-boundary');
const { buildTianxiResponsesResponse } = require('./tianxi-responses');
const { unavailableTianxiResultResponse } = require('./tianxi-tool-result-replay');
const { trackTianxiNativeTask } = require('./tianxi-live-result-wait');
const { createTianxiClientToolStream } = require('./tianxi-client-tool-stream');
const { createTianxiClientToolWait, hasNativeProgress } = require('./tianxi-client-tool-wait');
const { extractTianxiPromptText } = require('./tianxi-agentcore-protocol');
const { clientFinalFrames } = require('./tianxi-client-final-frames');

const NATIVE_TOOL_KINDS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Bash',
  'Write',
  'Edit',
  'Task',
  'Agent',
  'TodoWrite',
  'TodoRead',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);
function nativeToolKind(error) {
  try {
    const kind = Object.getOwnPropertyDescriptor(error, 'nativeToolKind')?.value;
    return NATIVE_TOOL_KINDS.has(kind) ? kind : 'other';
  } catch {
    return 'other';
  }
}

const FAILURE_MESSAGES = {
  tianxi_client_session_expired:
    '天禧会话长时间没有有效活动，已停止等待。已完成的读取不会重复执行；请发起新任务。',
  tianxi_client_progress_timeout:
    '天禧持续未返回有效进展，本次等待已结束。已完成的读取不会重复执行；请稍后发起新任务。',
  tianxi_client_output_batch_too_large: '工具批次的返回内容超过安全限制，本次任务已停止。',
  tianxi_client_native_tool_unsupported:
    '天禧请求了当前客户端链路不支持的原生工具。本次任务已停止；已完成的读取不会重复执行。',
  tianxi_client_action_batch_unsupported:
    '天禧返回的工具批次超出当前链路限制。本次任务已停止；已完成的读取不会重复执行。',
  tianxi_client_tool_arguments_invalid:
    '天禧工具参数不符合只读工具的安全边界。本次任务已停止；请使用工作区内的文件路径。',
  tianxi_native_permission_required:
    '天禧请求了额外授权，当前客户端只读链路无法处理。本次任务已停止。',
  tianxi_tac_server_idle_timeout:
    '天禧长时间未返回后续事件，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_native_runtime_timeout: '天禧任务等待超时，已停止等待。已完成的读取不会重复执行。',
  tianxi_external_tool_invalid:
    '天禧返回的工具消息未通过协议校验，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_external_tool_callback_failed:
    '天禧工具调用交接失败，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_tac_server_aborted: '天禧上游连接已取消，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_tac_server_send_failed:
    '向天禧上游发送消息失败，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_tac_server_ws_error: '天禧上游连接发生错误，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_tac_server_incomplete:
    '天禧上游连接在任务完成前关闭。已完成的读取不会重复执行；请稍后发起新任务。',
  tianxi_tac_server_output_limit:
    '天禧上游事件超过安全容量限制，本次任务已停止。已完成的读取不会重复执行。',
  tianxi_client_terminal_invalid:
    '天禧任务结束时仍有未完成工具或结果超过安全限制，本次任务未完成。',
};

const PREFIX = 'call_tianxi_client_';
const CORRECTABLE_ARGUMENTS = new Set([
  'argument_shape',
  'unknown_field',
  'read_range',
  'read_tail',
  'option_type',
  'ignored_scope',
  'search_pattern',
  'path_missing',
  'path_type',
]);
const CALL = /^call_tianxi_client_[0-9a-f]{32}$/;
function failureCategory(error) {
  try {
    for (let depth = 0, cause = error; depth < 3 && cause && typeof cause === 'object'; depth++) {
      // Exception metadata can contain accessors or proxies. Read only data
      // properties; classification must never execute an untrusted getter.
      for (const key of ['code', 'message']) {
        const candidate = Object.getOwnPropertyDescriptor(cause, key)?.value;
        if (typeof candidate === 'string' && Object.hasOwn(FAILURE_MESSAGES, candidate))
          return candidate;
      }
      cause = Object.getOwnPropertyDescriptor(cause, 'cause')?.value;
    }
  } catch {
    // A hostile proxy can reject descriptor inspection. Terminate normally
    // with the fixed generic category instead of losing the response waiter.
  }
  return 'tianxi_client_provider_failed';
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
function clientOutputText(value) {
  if (Array.isArray(value)) {
    if (
      value.length > 128 ||
      value.some(
        (part) =>
          !part ||
          typeof part !== 'object' ||
          Array.isArray(part) ||
          !['input_text', 'output_text', 'text'].includes(part.type) ||
          typeof part.text !== 'string' ||
          Object.keys(part).some((key) => !['type', 'text'].includes(key))
      )
    )
      invalid();
    value = value.map((part) => part.text).join('\n');
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536) invalid();
  return value;
}
function invalid(code = 'tianxi_client_continuation_invalid', status = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = status;
  throw error;
}
function response(model, call) {
  return {
    id: 'resp_' + randomUUID().replace(/-/g, ''),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output: [call],
    output_text: '',
    parallel_tool_calls: false,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}
function parseClientOutputs(input) {
  if (!Array.isArray(input)) return null;
  if (input.length > 4096) invalid();
  let boundary = -1;
  input.forEach((item, index) => {
    if (item?.role === 'user' && (!item.type || item.type === 'message')) boundary = index;
  });
  const outputs = input
    .slice(boundary + 1)
    .filter((item) => ['custom_tool_call_output', 'function_call_output'].includes(item?.type));
  if (!outputs.some((item) => typeof item.call_id === 'string' && item.call_id.startsWith(PREFIX)))
    return null;
  if (
    outputs.length > 128 ||
    outputs.some(
      (item) =>
        item.type !== 'custom_tool_call_output' ||
        typeof item.call_id !== 'string' ||
        !CALL.test(item.call_id)
    )
  )
    invalid();
  return outputs.map((item) => ({ ...item, output: clientOutputText(item.output) }));
}

function createTianxiClientToolSessions({
  ttlMs = 600000,
  maxSessions = 32,
  compile = compileTianxiClientRead,
  now = Date.now,
  onDiagnostic,
  onCorrection,
  nativeIdleTimeoutMs = 300000,
  waitNoticeMs = 30000,
  setProgressTimer = setTimeout,
  clearProgressTimer = clearTimeout,
  setSessionTimer = setTimeout,
  clearSessionTimer = clearTimeout,
} = {}) {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 3600000 ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 64 ||
    typeof setSessionTimer !== 'function' ||
    typeof clearSessionTimer !== 'function'
  )
    invalid();
  const sessions = new Set(),
    calls = new Map();
  function prune() {
    for (const session of sessions) {
      if (now() < session.touched || now() - session.touched >= ttlMs) expire(session);
    }
  }
  function remove(session) {
    cancel(session);
    clearSessionTimer(session.timer);
    session.expiryGeneration++;
    for (const id of session.ids) calls.delete(id);
    sessions.delete(session);
  }
  function expire(session) {
    if (!session.terminal) fail(session, new Error('tianxi_client_session_expired'));
    remove(session);
  }
  function touch(session) {
    session.touched = now();
    clearSessionTimer(session.timer);
    const generation = ++session.expiryGeneration;
    session.timer = setSessionTimer(() => {
      if (session.expiryGeneration === generation) expire(session);
    }, ttlMs);
    session.timer?.unref?.();
  }
  function publish(session, result) {
    if (session.pending?.progress && result.output?.includes(session.pending.call))
      for (const listener of session.listeners) listener({ progress: session.pending.progress });
    if (session.terminal) session.terminalResult = result;
    if (session.waiter) {
      const resolve = session.waiter;
      session.waiter = null;
      resolve(result);
    } else session.ready = result;
  }
  function next(session) {
    if (session.ready) {
      const result = session.ready;
      session.ready = null;
      return Promise.resolve(result);
    }
    if (session.waiter) invalid('tianxi_client_session_busy', 409);
    return new Promise((resolve) => {
      session.waiter = resolve;
    });
  }
  function cancel(session) {
    if (session.terminal) return;
    session.terminal = true;
    session.controller.abort();
    cleanup(session);
    publish(session, unavailableTianxiResultResponse('canceled', session.model));
  }
  function cleanup(session) {
    // Retain terminal results for a full replay window after completion.
    touch(session);
    session.terminalEntry = session.pending;
    session.progressWait.close();
    session.listeners.clear();
    session.pending = null;
    for (const batch of session.batches) {
      batch.outputs = [];
      batch.reply = null;
    }
    session.batches.clear();
  }
  function fail(session, error) {
    if (session.terminal) return;
    session.terminal = true;
    session.controller.abort();
    cleanup(session);
    const category = failureCategory(error);
    const argumentFailure =
      category === 'tianxi_client_tool_arguments_invalid'
        ? tianxiClientArgumentFailure(error)
        : null;
    // Diagnostics are best effort; their failure must never suppress termination.
    try {
      onDiagnostic?.({
        category,
        clientCalls: session.count,
        ...(category === 'tianxi_client_native_tool_unsupported'
          ? { nativeToolKind: nativeToolKind(error) }
          : {}),
        ...(argumentFailure ? { argumentReason: argumentFailure.reason } : {}),
      });
    } catch {
      session.diagnosticFailed = true;
    }
    const failure = unavailableTianxiResultResponse('failed', session.model);
    failure.error.message =
      (argumentFailure
        ? `天禧工具参数被拒绝：${argumentFailure.message} 本次任务已停止。`
        : null) ||
      FAILURE_MESSAGES[category] ||
      '天禧客户端工具任务未能完成。已完成的读取不会重复执行；请检查代理的安全诊断分类。';
    publish(session, failure);
  }
  function lease(session, promise, allowTools = true) {
    return {
      model: session.model,
      promise,
      cancel: () => cancel(session),
      onDelivered: session.onFinal,
      allowTools,
      subscribe(listener) {
        session.listeners.add(listener);
        if (session.pending?.progress) listener({ progress: session.pending.progress });
        else if (!session.count) listener('started');
        return () => session.listeners.delete(listener);
      },
    };
  }
  function resume(owner, input, options = {}) {
    const outputs = parseClientOutputs(input);
    if (!outputs) return null;
    prune();
    let session;
    const submitted = new Map();
    for (const output of outputs) {
      const entry = calls.get(output.call_id);
      if (!entry || entry.session.owner !== owner) invalid('tianxi_client_call_not_found', 404);
      if (session && session !== entry.session) invalid();
      session = entry.session;
      const digest = hash(output.output);
      if (
        (entry.digest && entry.digest !== digest) ||
        (submitted.has(output.call_id) && submitted.get(output.call_id).digest !== digest)
      )
        invalid('tianxi_client_output_conflict', 409);
      submitted.set(output.call_id, { entry, digest, output: output.output });
    }
    const unsubmitted = [...submitted.values()].filter(({ entry }) => !entry.digest);
    if (unsubmitted.length > 1) invalid();
    const current = unsubmitted[0];
    if (!current) {
      const entry = session.lastSubmitted;
      if (!entry || ![...submitted.values()].some((value) => value.entry === entry))
        invalid('tianxi_client_output_stale', 409);
      return lease(session, entry.followup, options.allowTools !== false);
    }
    if (session.terminal) {
      if (session.terminalEntry !== current.entry || !session.terminalResult)
        invalid('tianxi_client_session_ended', 409);
      // The native task may fail while an already-issued client command is
      // executing. Return its fixed terminal response without sending late
      // output to the closed native socket or manufacturing another task.
      current.entry.digest = current.digest;
      current.entry.followup = Promise.resolve(session.terminalResult);
      session.lastSubmitted = current.entry;
      return lease(session, current.entry.followup, options.allowTools !== false);
    }
    if (session.pending !== current.entry) invalid('tianxi_client_session_ended', 409);
    touch(session);
    // Install the waiter and seal the output before sending to the native socket.
    const entry = current.entry;
    entry.digest = current.digest;
    entry.followup = next(session);
    session.pending = null;
    session.lastSubmitted = entry;
    try {
      entry.batch.outputs.push(current.output);
      if (entry.batch.outputs.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 262144)
        invalid('tianxi_client_output_batch_too_large');
      const following = entry.batch.entries[entry.batch.outputs.length];
      if (following) {
        session.pending = following;
        publish(session, response(session.model, following.call));
      } else {
        if (entry.batch.reply(entry.batch.outputs) !== true) cancel(session);
        else {
          for (const value of entry.batch.entries)
            if (typeof value.actionId === 'string') session.returnedActions.add(value.actionId);
          session.progressWait.resume();
        }
        entry.batch.outputs = [];
        entry.batch.reply = null;
        session.batches.delete(entry.batch);
      }
    } catch (error) {
      fail(session, error);
    }
    return lease(session, entry.followup, options.allowTools !== false);
  }
  function start({ owner, model, payload, nativeTools, run, onFinal }) {
    prune();
    if (
      typeof owner !== 'string' ||
      !owner ||
      owner.length > 1024 ||
      typeof model !== 'string' ||
      !model ||
      model.length > 256 ||
      [...model].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      typeof run !== 'function' ||
      !nativeTools ||
      typeof nativeTools.cwd !== 'string' ||
      !Array.isArray(nativeTools.disallowedTools) ||
      sessions.size >= maxSessions
    )
      invalid('tianxi_client_capacity_unavailable', 503);
    const metadata = tianxiClientReadMetadata(nativeTools);
    const session = {
      owner,
      model,
      created: now(),
      touched: now(),
      expiryGeneration: 0,
      ids: [],
      count: 0,
      pending: null,
      waiter: null,
      ready: null,
      terminal: false,
      onFinal,
      controller: new globalThis.AbortController(),
      returnedActions: new Set(),
      listeners: new Set(),
      batches: new Set(),
      correctedBatches: 0,
    };
    session.progressWait = createTianxiClientToolWait({
      idleTimeoutMs: nativeIdleTimeoutMs,
      noticeAfterMs: waitNoticeMs,
      setTimer: setProgressTimer,
      clearTimer: clearProgressTimer,
      onWaiting() {
        try {
          for (const listener of session.listeners) listener('waiting');
        } catch (error) {
          fail(session, error);
        }
      },
      onTimeout: () => fail(session, new Error('tianxi_client_progress_timeout')),
    });
    sessions.add(session);
    touch(session);
    const first = next(session);
    const policy =
      'Use only codex_readonly client tools within the configured workspace. ' +
      'These tools execute in the client and results are returned to this same task. ' +
      'Call one tool at a time. Do not use native Read, Glob, Grep, Bash, Write, Edit, Task or Agent. ' +
      'Use codex_readonly.read_file instead of Read, find_files instead of Glob or LS, and search_text instead of Grep. ' +
      'Search patterns are literal text; find_files accepts glob patterns. Report failed tools honestly. ' +
      'Start discovery with recursive source globs (for example src/**), avoiding node_modules. ' +
      'Default searches omit hidden files; text searches also omit ignored files, while positive find_files globs can override ignore rules. Empty results do not prove absence. ' +
      'Use include_hidden for .github, and include_ignored only for explicit artifact subdirectories. ' +
      'For known log files use an explicit search path or read_file tail; do not guess EOF with repeated offsets. ' +
      'Prefer read_file limit 80 with include_metadata true; truncated output is incomplete evidence. ' +
      'Separate source observations, historical test artifacts, and checks actually run during this task. ' +
      'Read-only tools execute commands: say tests/builds/audits were not run when appropriate, not that no commands ran. ' +
      'Individual passing test lines without a final summary and exit status do not prove a successful run. ' +
      'Do not infer timeout causes, assert comparative security maturity, or recommend relaxing gates without evidence. ' +
      'Honor the user requested final-answer format. Tool metadata assists interpretation and is not extra answer content. ' +
      'If the user requests only a value, return only that value in the final answer; put operation explanations in progress instead. ' +
      'Do not call native planning or task tools (TodoWrite, TodoRead, EnterPlanMode, ExitPlanMode). ' +
      'For each tool call, include progress: one short user-facing sentence in the user language ' +
      'explaining what you are checking and its purpose. Use only current task and observed results. ' +
      'When useful, mention a concrete observation or unresolved question; avoid repetitive praise and generic narration. ' +
      'Do not include private chain-of-thought, credentials, or claim findings before verification.';
    const nativePayload = {
      ...payload,
      // The native endpoint extracts only the latest user text. Keep the
      // execution contract in that actual prompt as well as custom_context.
      input: `${policy}\n\nUser task:\n${extractTianxiPromptText(payload.input)}`,
      instructions: `${policy}\n${typeof payload.instructions === 'string' ? payload.instructions : ''}\n${policy}`,
      metadata: { ...payload.metadata, tianxi: { ...payload.metadata?.tianxi, ...metadata } },
    };
    if (nativePayload.input.length > 128000) {
      remove(session);
      invalid('tianxi_client_prompt_too_large', 413);
    }
    const endNativeTask = trackTianxiNativeTask();
    session.progressWait.resume();
    Promise.resolve()
      .then(() =>
        run(nativePayload, {
          signal: session.controller.signal,
          onFrame(frame) {
            assertTianxiPermissionSupported(frame);
            session.progressWait.progress(frame);
            if (!session.terminal && hasNativeProgress(frame)) touch(session);
            if (
              frame?.type === 'act_exec' &&
              !(
                frame.data?.exec_mode === 'local' &&
                Array.isArray(frame.data.actions) &&
                frame.data.actions.length &&
                frame.data.actions.every((action) => action.mcpServerName === 'codex_readonly')
              )
            ) {
              const error = new Error('tianxi_client_native_tool_unsupported');
              const actions = frame.data?.actions;
              const name = Array.isArray(actions) && actions.length === 1 ? actions[0]?.name : null;
              error.nativeToolKind = NATIVE_TOOL_KINDS.has(name) ? name : 'other';
              throw error;
            }
          },
          onExternalToolCall(frame, reply) {
            try {
              if (
                session.terminal ||
                session.pending ||
                !Array.isArray(frame?.data?.actions) ||
                frame.data.actions.length < 1 ||
                frame.data.actions.length > 8 ||
                session.count + frame.data.actions.length > 128
              )
                invalid('tianxi_client_action_batch_unsupported');
              // Validate the whole native batch before dispatching its first command.
              const compiled = frame.data.actions.map((action) => compile(action, nativeTools.cwd));
              touch(session);
              const batch = { reply, outputs: [], entries: [] };
              session.batches.add(batch);
              for (const [index, args] of compiled.entries()) {
                const callId = PREFIX + randomUUID().replace(/-/g, '');
                const call = {
                  id: 'ctc_' + randomUUID().replace(/-/g, ''),
                  type: 'custom_tool_call',
                  namespace: 'functions',
                  name: 'exec',
                  call_id: callId,
                  status: 'completed',
                  input: tianxiClientCommandInput(args),
                };
                const entry = {
                  session,
                  batch,
                  call,
                  digest: null,
                  followup: null,
                  actionId: frame.data.actions[index].id,
                  progress:
                    (frame.data.actions[index].parameters &&
                      Object.getOwnPropertyDescriptor(
                        frame.data.actions[index].parameters,
                        'progress'
                      )?.value) ||
                    {
                      read_file: '正在读取项目文件。',
                      find_files: '正在查找项目文件。',
                      search_text: '正在检索代码内容。',
                    }[frame.data.actions[index].name?.replace('mcp__codex_readonly__', '')] ||
                    '正在执行只读操作。',
                };
                calls.set(callId, entry);
                session.ids.push(callId);
                session.count++;
                batch.entries.push(entry);
              }
              session.pending = batch.entries[0];
              session.progressWait.pause();
              publish(session, response(model, session.pending.call));
            } catch (error) {
              const argumentFailure = tianxiClientArgumentFailure(error);
              if (
                !session.terminal &&
                !session.pending &&
                argumentFailure &&
                CORRECTABLE_ARGUMENTS.has(argumentFailure.reason) &&
                session.correctedBatches < 2 &&
                typeof reply === 'function'
              ) {
                session.correctedBatches++;
                try {
                  onCorrection?.({
                    argumentReason: argumentFailure.reason,
                    rejectedActions: frame.data.actions.length,
                    correctedBatches: session.correctedBatches,
                  });
                } catch {
                  // A diagnostic sink cannot prevent a bounded tool correction.
                  session.diagnosticFailed = true;
                }
                // Return only a fixed validation explanation. No rejected
                // action (including valid siblings in its batch) is executed.
                const rejected = JSON.stringify({
                  isError: true,
                  error: {
                    code: 'tianxi_client_tool_arguments_invalid',
                    reason: argumentFailure.reason,
                    message: argumentFailure.message,
                  },
                });
                try {
                  if (reply(frame.data.actions.map(() => rejected)) !== true) cancel(session);
                  else {
                    for (const action of frame.data.actions)
                      if (typeof action.id === 'string') session.returnedActions.add(action.id);
                    session.progressWait.resume();
                  }
                } catch (replyError) {
                  fail(session, replyError);
                  throw replyError;
                }
                return;
              }
              // Preserve the fixed validation category before the native channel
              // replaces callback exceptions with its generic transport error.
              fail(session, error);
              throw error;
            }
          },
        })
      )
      .then((bridge) => {
        if (session.terminal) return;
        for (const frame of bridge.frames || []) assertTianxiPermissionSupported(frame);
        // These actions already completed through client continuations. Feeding
        // their starts into the generic converter would manufacture pending
        // function calls because same-socket replies need not be echoed back.
        const finalFrames = clientFinalFrames(bridge.frames, session.returnedActions);
        const final = buildTianxiResponsesResponse(payload, finalFrames, model);
        final.output = final.output.filter(
          (item) => item.type === 'message' && item.phase !== 'commentary'
        );
        final.output_text = final.output
          .flatMap((item) => item.content)
          .map((part) => part.text || '')
          .join('');
        if (Buffer.byteLength(JSON.stringify(final)) > 1048576 || session.pending)
          invalid('tianxi_client_terminal_invalid');
        session.terminal = true;
        cleanup(session);
        publish(session, final);
      })
      .catch((error) => fail(session, error))
      .finally(endNativeTask);
    return lease(session, first);
  }
  return {
    start,
    resume,
    close() {
      for (const session of sessions) remove(session);
    },
  };
}

async function serveTianxiClientToolLease(clientRes, lease, stream) {
  let canceled = false;
  const cancelLease = () => {
    if (canceled) return;
    canceled = true;
    lease.cancel();
  };
  const onClose = () => {
    if (!clientRes.writableEnded) cancelLease();
  };
  clientRes.on?.('close', onClose);
  let heartbeat;
  let unsubscribe;
  let liveStream;
  try {
    if (clientRes.destroyed || clientRes.writableEnded) {
      cancelLease();
      return await lease.promise;
    }
    if (stream) {
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      liveStream = createTianxiClientToolStream(clientRes, lease.model);
      unsubscribe = lease.subscribe?.((code) => liveStream.notice(code));
      heartbeat = setInterval(() => {
        if (clientRes.destroyed || clientRes.writableEnded) return;
        try {
          clientRes.write(': tianxi-client-waiting\n\n');
        } catch {
          cancelLease();
          clearInterval(heartbeat);
        }
      }, 15000);
    }
    let value = await lease.promise;
    if (lease.allowTools === false && value.output[0]?.type === 'custom_tool_call') {
      cancelLease();
      value = unavailableTianxiResultResponse('failed', value.model);
    }
    if (clientRes.destroyed || clientRes.writableEnded) {
      cancelLease();
      return value;
    }
    if (!stream) {
      const body = JSON.stringify(value);
      clientRes.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      clientRes.end(body);
    } else value = liveStream.finish(value);
    if (!value.output.some((item) => item.type === 'custom_tool_call')) lease.onDelivered?.(value);
    return value;
  } catch {
    cancelLease();
    invalid('tianxi_client_response_write_failed', 502);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    clientRes.removeListener?.('close', onClose);
  }
}

module.exports = { createTianxiClientToolSessions, serveTianxiClientToolLease, parseClientOutputs };
