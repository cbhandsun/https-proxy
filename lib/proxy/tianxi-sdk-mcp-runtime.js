'use strict';

const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { AbortController } = globalThis;
const { createSdkProtocol } = require('./tianxi-sdk-protocol');
const { prepareSdkWorkspace } = require('./tianxi-sdk-workspace');
const { readLatestAgentCoreHeader } = require('./tianxi-agentcore-local');
const {
  refreshTianxiWithoutChat,
  sameIdentity,
} = require('./tianxi-auth-refresh-manager');
const { sdkModel } = require('./tianxi-sdk-models');
const { createTianxiSdkMcpChannel } = require('./tianxi-sdk-mcp-channel');

// Separate research harness: no profile/config changes and no production listener.
async function runTianxiSdkMcpExperiment(
  {
    modelId,
    prompt,
    tools,
    onCall,
    signal,
    timeoutMs = 180000,
    systemPrompt,
    toolTimeoutMs = 30000,
    allowExtendedLimits = false,
  },
  {
    readHeader = readLatestAgentCoreHeader,
    refresh = refreshTianxiWithoutChat,
    prepare = prepareSdkWorkspace,
    spawnChild = spawn,
    terminate = (child) => {
      if (Number.isSafeInteger(child.pid) && child.pid > 0)
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {}
        );
    },
  } = {}
) {
  const maxSessionTimeoutMs = allowExtendedLimits ? 600000 : 180000;
  if (
    !sdkModel(modelId) ||
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    prompt.length > 32768 ||
    prompt.includes('\0') ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maxSessionTimeoutMs ||
    (systemPrompt !== undefined &&
      (typeof systemPrompt !== 'string' ||
        systemPrompt.length > 128000 ||
        systemPrompt.includes('\0')))
  )
    throw new Error('tianxi_sdk_mcp_invalid');
  const controller = new AbortController();
  const channel = createTianxiSdkMcpChannel({
    tools,
    onCall,
    signal: controller.signal,
    timeoutMs: toolTimeoutMs,
    maxTimeoutMs: allowExtendedLimits ? 600000 : 120000,
    maxCalls: allowExtendedLimits ? 256 : 32,
    maxToolResultBytes: allowExtendedLimits ? 262144 : 65536,
    maxToolsBytes: allowExtendedLimits ? 1048576 : 262144,
    lenientValidation: allowExtendedLimits,
  });
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  // Idle timeout: reset on every SDK frame and tool result so long multi-tool
  // sessions are not killed by a fixed wall clock. Hard cap keeps runaway bounded.
  let timer = setTimeout(abort, timeoutMs);
  const touch = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted) timer = setTimeout(abort, timeoutMs);
  };
  const hardTimer = setTimeout(abort, 30 * 60 * 1000);
  let workspace,
    childStarted = false;
  try {
    const header = readHeader();
    if (!header?.user_id) throw new Error('tianxi_sdk_auth_failed');
    const auth = await refresh(
      { userId: header.user_id, readHeader },
      { signal: controller.signal }
    );
    if (!auth.token || !sameIdentity(header, readHeader()))
      throw new Error('tianxi_sdk_auth_failed');
    if (controller.signal.aborted) throw new Error('tianxi_sdk_mcp_aborted');
    workspace = prepare(modelId);
    return await new Promise((resolve, reject) => {
      const protocol = createSdkProtocol({
        modelId,
        prompt,
        instructions: '',
        token: auth.token,
        sameAccount: () => sameIdentity(header, readHeader()),
        workerArgs: [...workspace.workerArgs, '--allowed-tools', channel.allowedTools.join(',')],
        cwd: workspace.root,
        maxAuthRequests: allowExtendedLimits ? 256 : 4,
        allowExtendedLimits,
      });
      let child;
      try {
        child = spawnChild(workspace.cli, workspace.args, {
          cwd: workspace.root,
          env: workspace.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        childStarted = true;
      } catch {
        reject(new Error('tianxi_sdk_launch_failed'));
        return;
      }
      let finished = false,
        closed = false,
        pending = '',
        bytes = 0,
        frames = 0,
        output = '',
        finalText = '',
        observedModel;
      let terminalError, exitTimer;
      let queue = Promise.resolve();
      const methods = new Set();
      const decoder = new StringDecoder('utf8');
      const stop = () => {
        if (!closed) {
          try { child.stdin.end(); } catch {}
          try { child.stdout.destroy(); } catch {}
          try { child.stderr.destroy(); } catch {}
          terminate(child);
        }
      };
      const finish = (error) => {
        if (finished) return;
        finished = true;
        terminalError = error;
        controller.signal.removeEventListener('abort', onAbort);
        if (!closed) {
          exitTimer = setTimeout(() => {
            if (closed) return;
            closed = true;
            try { workspace?.cleanup(); } catch {}
            if (terminalError) {
              reject(terminalError);
            } else if (finalText || output) {
              resolve({
                modelId,
                observedModel,
                calls: channel.calls,
                output,
                finalText,
                methods: [...methods],
              });
            } else {
              reject(new Error('tianxi_sdk_mcp_exit_unconfirmed'));
            }
          }, 10000);
          stop();
        }
      };
      const onAbort = () => finish(new Error('tianxi_sdk_mcp_aborted'));
      const write = (frame) => {
        if (!finished && !controller.signal.aborted)
          child.stdin.write(JSON.stringify(frame) + '\n');
      };
      async function accept(value) {
        if (finished || controller.signal.aborted) return;
        if (value.type === 'system' && typeof value.model === 'string') observedModel = value.model;
        if (
          value.type === 'control_request' &&
          (value.request?.type || value.request?.subtype) === 'mcp_message'
        ) {
          // Let the existing protocol check session correlation and frame shape;
          // its default denied reply is replaced only for this registered server.
          protocol.accept(value);
          if (!sameIdentity(header, readHeader())) throw new Error('tianxi_sdk_account_changed');
          touch();
          const result = await channel.handle(value.request);
          touch();
          if (!sameIdentity(header, readHeader())) throw new Error('tianxi_sdk_account_changed');
          methods.add(value.request.message.method);
          write({
            type: 'control_response',
            session_id: value.session_id,
            response: {
              subtype: 'success',
              request_id: value.request_id,
              response: { mcp_response: result },
            },
          });
          return;
        }
        if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
          const content = value.message.content;
          for (const block of content)
            if (
              !allowExtendedLimits &&
              block?.type === 'tool_use' &&
              !channel.allowedTools.includes(block.name)
            )
              throw new Error('tianxi_sdk_mcp_invalid');
          finalText = content.some((block) => block?.type === 'tool_use')
            ? ''
            : content
                .filter((block) => block?.type === 'text')
                .map((block) => block.text)
                .join('');
          // Tool payloads are never emitted as assistant prose or evaluated here.
          value = {
            ...value,
            message: {
              ...value.message,
              content: content.filter((block) => block?.type !== 'tool_use'),
            },
          };
        }
        const result = protocol.accept(value);
        for (const message of result.outbound) {
          if (message.request?.type === 'initialize') {
            message.request.sdkMcpServers = [channel.serverName];
            message.request.systemPrompt =
              systemPrompt ??
              'You are a tool-using assistant. Only use tools supplied by the host. Follow the user request exactly. Never invent tool results.';
          }
          write(message);
        }
        for (const frame of result.frames)
          if (frame.type === 'task_output') output += frame.data.content;
        if (result.done) finish();
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });
      child.once('spawn', () => write(protocol.start()));
      child.once('error', () => finish(new Error('tianxi_sdk_launch_failed')));
      child.stdin.on('error', () => {
        if (!finished) finish(new Error('tianxi_sdk_transport_failed'));
      });
      child.stderr.on('data', (chunk) => {
        // stderr is diagnostic noise: drained, never counted against the session.
      });
      child.stdout.on('data', (chunk) => {
        if (finished) return;
        touch();
        bytes += chunk.length;
        pending += decoder.write(chunk);
        // Per-frame bound: one unterminated line may not exceed 32 MB. Long
        // multi-tool sessions legitimately stream far more in total.
        if (pending.length > 32 * 1024 * 1024) return finish(new Error('tianxi_sdk_output_limit'));
        for (;;) {
          const index = pending.indexOf('\n');
          if (index < 0) break;
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (!line.trim()) continue;
          if (++frames > 1000000) return finish(new Error('tianxi_sdk_output_limit'));
          queue = queue
            .then(() => accept(JSON.parse(line)))
            .catch((err) => {
              console.error(
                '[TianxiSdkMcpAcceptFail]',
                err?.message || err,
                typeof line === 'string' ? line.slice(0, 400) : ''
              );
              finish(new Error('tianxi_sdk_mcp_protocol_failed'));
            });
        }
      });
      const onChildClosed = () => {
        if (closed) return;
        closed = true;
        clearTimeout(exitTimer);
        queue.then(() => {
          if (!finished) finish(new Error('tianxi_sdk_incomplete'));
          try {
            workspace.cleanup();
          } catch {
            terminalError = new Error('tianxi_sdk_cleanup_failed');
          }
          if (terminalError) reject(terminalError);
          else
            resolve({
              modelId,
              observedModel,
              calls: channel.calls,
              output,
              finalText,
              methods: [...methods],
            });
        });
      };
      child.once('close', onChildClosed);
      child.once('exit', onChildClosed);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    if (workspace && !childStarted) workspace.cleanup();
    // Child close owns cleanup after a successful spawn. Never delete an
    // active child's files, including when exit could not be confirmed.
  }
}

module.exports = { runTianxiSdkMcpExperiment };
