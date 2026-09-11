'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { AgyError, MAX_BODY_BYTES, MODELS } = require('./agy-chat-request');
const { createEventParser } = require('./agy-events');
const { ensurePrivateDirectorySync } = require('./secure-files');
const { createLogger } = require('./logger');

const log = createLogger('agy-runtime');
const DENY_RULES = Object.freeze([
  'read_file(*)',
  'write_file(*)',
  'command(*)',
  'unsandboxed(*)',
  'read_url(*)',
  'execute_url(*)',
  'mcp(*)',
]);

function childEnvironment(root, source = process.env) {
  const env = {};
  const allowed = new Set([
    'systemroot',
    'windir',
    'comspec',
    'path',
    'pathext',
    'temp',
    'tmp',
    'appdata',
    'localappdata',
    'username',
    'userdomain',
    'processor_architecture',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'ssl_cert_file',
    'ssl_cert_dir',
  ]);
  for (const [key, value] of Object.entries(source))
    if (allowed.has(key.toLowerCase())) env[key] = value;
  env.USERPROFILE = root;
  return env;
}

function prepareWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-agy-chat-'));
  ensurePrivateDirectorySync(root);
  const settings = path.join(root, '.gemini', 'antigravity-cli');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(settings, { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(
    path.join(settings, 'settings.json'),
    JSON.stringify({
      permissions: { deny: DENY_RULES, allow: [], ask: [] },
      enableTelemetry: false,
    }),
    { mode: 0o600 }
  );
  return { root, cwd, env: childEnvironment(root) };
}

async function cleanWorkspace(workspace) {
  const root = path.resolve(workspace.root);
  if (
    path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('hpm-agy-chat-')
  ) {
    throw new AgyError('agy_cleanup_path_invalid');
  }
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function terminateChild(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 },
        (error) => {
          if (error && child.exitCode === null) child.kill();
          resolve();
        }
      );
    });
  } else child.kill('SIGKILL');
}

function createAgyRuntime({
  executable,
  timeoutMs = 60000,
  spawnProcess = spawn,
  prepare = prepareWorkspace,
  cleanup = cleanWorkspace,
  terminate = terminateChild,
} = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable))
    throw new AgyError('agy_executable_invalid', 500);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw new AgyError('agy_timeout_invalid', 500);
  let busy = false;
  return {
    async generate(request, { signal, onDelta } = {}) {
      if (
        !request ||
        !MODELS.some((model) => model.slice(4) === request.cliModel) ||
        typeof request.prompt !== 'string' ||
        !request.prompt.trim() ||
        Buffer.byteLength(request.prompt) > MAX_BODY_BYTES
      ) {
        throw new AgyError('agy_unsupported_request', 400);
      }
      if (signal?.aborted) throw new AgyError('agy_canceled', 499);
      if (busy) throw new AgyError('agy_busy', 429);
      busy = true;
      let workspace;
      let output;
      let generationError;
      let termination;
      try {
        workspace = prepare();
        output = await new Promise((resolve, reject) => {
          let child,
            failure = null,
            stderrBytes = 0,
            settled = false;
          const parser = createEventParser({ onDelta });
          const fail = (error) => {
            if (failure || settled) return;
            failure = error;
            if (child) termination = Promise.resolve(terminate(child));
          };
          const abort = () => fail(new AgyError('agy_canceled', 499));
          const timer = setTimeout(() => fail(new AgyError('agy_timeout', 504)), timeoutMs);
          const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(result);
          };
          try {
            child = spawnProcess(
              executable,
              [
                '--input-format',
                'stream-json',
                '--output-format',
                'stream-json',
                '--model',
                request.cliModel,
                '--disable-slash-commands',
                '--sandbox',
                '--mode',
                'plan',
                '--log-file',
                path.join(workspace.root, 'cli.log'),
                '--print-timeout',
                `${Math.max(1, Math.floor(timeoutMs / 1000))}s`,
              ],
              {
                cwd: workspace.cwd,
                env: workspace.env,
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
              }
            );
            child.on('error', () => finish(new AgyError('agy_start_failed', 503)));
            child.stdout.on('data', (chunk) => {
              if (failure) return;
              try {
                parser.push(chunk);
              } catch (error) {
                fail(error instanceof AgyError ? error : new AgyError('agy_stream_failed'));
              }
            });
            child.stderr.on('data', (chunk) => {
              // Never retain or forward CLI diagnostics: they may contain prompts or credentials.
              stderrBytes += chunk.length;
              if (stderrBytes > 1024 * 1024) fail(new AgyError('agy_output_too_large'));
            });
            child.stdin.on('error', () => fail(new AgyError('agy_input_failed')));
            child.on('close', (code) => {
              if (failure) return finish(failure);
              try {
                const result = parser.finish();
                finish(code === 0 ? null : new AgyError('agy_process_failed'), result);
              } catch (error) {
                finish(error);
              }
            });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            else
              child.stdin.end(
                JSON.stringify({ event: 'user', message: { content: request.prompt } }) + '\n'
              );
          } catch {
            finish(new AgyError('agy_start_failed', 503));
          }
        });
      } catch (error) {
        generationError = error;
      }
      try {
        // The CLI's close event may precede taskkill finishing its descendant
        // cleanup. Await the whole tree before removing the private workspace.
        if (termination) await termination;
        if (workspace) await cleanup(workspace);
      } catch {
        log.warn({ code: 'agy_cleanup_failed' }, 'AGY private workspace cleanup failed');
        generationError ||= new AgyError('agy_cleanup_failed');
      }
      busy = false;
      if (generationError) throw generationError;
      return output;
    },
  };
}

module.exports = {
  childEnvironment,
  cleanWorkspace,
  createAgyRuntime,
  DENY_RULES,
  prepareWorkspace,
};
