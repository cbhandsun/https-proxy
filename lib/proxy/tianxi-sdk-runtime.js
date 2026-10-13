'use strict';
const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createSdkProtocol, parseSdkInput } = require('./tianxi-sdk-protocol');
const { prepareSdkWorkspace } = require('./tianxi-sdk-workspace');
const { refreshTianxiWithoutChat, sameIdentity } = require('./tianxi-auth-refresh-manager');
const { readLatestAgentCoreHeader } = require('./tianxi-agentcore-local');
const { createTransportTianxiNativeRuntime } = require('./tianxi-native-runtime');
const log = require('./logger').createLogger('tianxi-sdk');
let active = 0;
function terminateOwnedChild(child) {
  if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    execFile(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
      () => {}
    );
  } else child.kill();
}
function runSdkProcess(
  input,
  header,
  token,
  context,
  {
    spawnChild = spawn,
    prepare = prepareSdkWorkspace,
    readHeader = readLatestAgentCoreHeader,
    terminate = terminateOwnedChild,
  } = {}
) {
  return new Promise((resolve, reject) => {
    if (context.signal?.aborted) {
      reject(new Error('tianxi_sdk_aborted'));
      return;
    }
    let workspace, child, protocol;
    try {
      workspace = prepare(input.modelId);
      protocol = createSdkProtocol({
        ...input,
        token,
        sameAccount: () => sameIdentity(header, readHeader()),
        workerArgs: workspace.workerArgs,
        cwd: workspace.root,
      });
      child = spawnChild(workspace.cli, workspace.args, {
        cwd: workspace.root,
        env: workspace.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      workspace?.cleanup();
      reject(new Error('tianxi_sdk_launch_failed', { cause: error }));
      return;
    }
    let finished = false,
      closed = false,
      pending = '',
      bytes = 0,
      count = 0;
    const frames = [],
      decoder = new StringDecoder('utf8');
    const finish = (error) => {
      if (finished) return;
      finished = true;
      context.signal?.removeEventListener('abort', abort);
      if (!closed) terminate(child);
      if (error) reject(error);
      else resolve({ frames });
    };
    const abort = () => finish(new Error('tianxi_sdk_aborted'));
    const write = (frame) => child.stdin.write(JSON.stringify(frame) + '\n');
    context.signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      try {
        write(protocol.start());
      } catch {
        finish(new Error('tianxi_sdk_transport_failed'));
      }
    });
    child.on('error', () => finish(new Error('tianxi_sdk_launch_failed')));
    child.stdin.on('error', () => {
      if (!finished) finish(new Error('tianxi_sdk_transport_failed'));
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) finish(new Error('tianxi_sdk_output_limit'));
    });
    child.stdout.on('data', (chunk) => {
      if (finished) return;
      try {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) throw new Error('tianxi_sdk_output_limit');
        pending += decoder.write(chunk);
        if (pending.length > 2 * 1024 * 1024) throw new Error('tianxi_sdk_output_limit');
        for (;;) {
          const index = pending.indexOf('\n');
          if (index < 0) break;
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (!line.trim()) continue;
          if (++count > 8192) throw new Error('tianxi_sdk_output_limit');
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            throw new Error('tianxi_sdk_frame_invalid');
          }
          const result = protocol.accept(value);
          for (const message of result.outbound) write(message);
          for (const frame of result.frames) {
            frames.push(frame);
            context.onFrame?.(frame);
          }
          if (result.done) {
            finish();
            break;
          }
        }
      } catch (error) {
        finish(
          new Error(
            /^tianxi_sdk_[a-z_]+$/.test(error?.message || '')
              ? error.message
              : 'tianxi_sdk_transport_failed',
            { cause: error }
          )
        );
      }
    });
    child.once('close', () => {
      closed = true;
      try {
        workspace.cleanup();
      } catch {
        log.warn(
          { code: 'tianxi_sdk_cleanup_failed' },
          'Unable to remove owned Tianxi SDK workspace'
        );
      }
      if (!finished) finish(new Error('tianxi_sdk_incomplete'));
    });
  });
}
function createTianxiSdkRuntime(options = {}) {
  const readHeader = options.readHeader || readLatestAgentCoreHeader;
  const refresh = options.refresh || refreshTianxiWithoutChat;
  return createTransportTianxiNativeRuntime({
    name: 'tianxi-sdk',
    timeoutMs: options.timeoutMs || 180000,
    async send(payload, context) {
      const input = parseSdkInput(payload);
      if (active >= 4) throw new Error('tianxi_sdk_busy');
      active++;
      try {
        const header = readHeader();
        if (!header?.user_id) throw new Error('tianxi_sdk_auth_invalid');
        const result = await refresh({ userId: header.user_id, readHeader }, context);
        if (!result.token || !sameIdentity(header, readHeader()))
          throw new Error('tianxi_sdk_auth_failed');
        return await runSdkProcess(input, header, result.token, context, {
          ...options,
          readHeader,
        });
      } finally {
        active--;
      }
    },
  });
}
module.exports = { createTianxiSdkRuntime, runSdkProcess };
