const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const cp = require('child_process');

const {
  checkEnvironmentTools,
  startToolInstallJob,
  runToolInstall,
  listInstallJobs,
  clearEnvCaches,
  ENV_CHECK_TOOLS,
} = require('../env-tools');
const { readJsonBodyFromRequest } = require('../management-utils');

const SAFE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireJsonObjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('JSON body must be an object');
    err.statusCode = 400;
    throw err;
  }
  return body;
}

function parseCliArgs(input) {
  const text = String(input || '').trim();
  if (!text) return [];
  if (/[\r\n\0]/.test(text)) throw new Error('customArgs contains unsupported control characters');

  const args = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('customArgs contains an unterminated quote');
  if (current) args.push(current);
  if (args.length > 64) throw new Error('customArgs contains too many arguments');
  if (args.some((arg) => arg.length > 2048)) {
    throw new Error('customArgs contains an argument that is too long');
  }
  return args;
}

function quotePowerShell(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

function quoteCmd(value) {
  return (
    '"' +
    String(value == null ? '' : value)
      .replace(/%/g, '%%')
      .replace(/"/g, '""') +
    '"'
  );
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ''), 'utf16le').toString('base64');
}

function safeTitle(value) {
  return (
    String(value || 'default')
      .replace(/[\r\n&|<>"]/g, ' ')
      .trim() || 'default'
  );
}

function normalizeCliModelOverride(value) {
  const model = String(value || '').trim();
  if (!model || model.toLowerCase() === 'default') return '';
  if (/[\r\n\0]/.test(model)) throw new Error('model contains unsupported control characters');
  if (model.length > 2048) throw new Error('model is too long');
  return model;
}

const CLI_MODEL_ARG_RULES = {
  'claude-code': {
    flags: ['--model'],
    append(model) {
      return ['--model', model];
    },
  },
  'antigravity-cli': {
    flags: ['--model'],
    append(model) {
      return ['--model', model];
    },
  },
  codex: {
    flags: ['--model', '-m'],
    hasModelArg(args) {
      for (let index = 0; index < args.length; index += 1) {
        const text = String(args[index] || '');
        const next = String(args[index + 1] || '');
        if ((text === '-c' || text === '--config') && /^model\s*=/.test(next)) return true;
        if (/^(?:-c|--config)=model\s*=/.test(text)) return true;
      }
      return false;
    },
    append(model) {
      return ['--model', model];
    },
  },
};

function hasCliModelArg(args, rule) {
  if (!rule || !Array.isArray(rule.flags)) return false;
  if (typeof rule.hasModelArg === 'function' && rule.hasModelArg(args)) return true;
  const flags = new Set(rule.flags);
  return (Array.isArray(args) ? args : []).some((arg) => {
    const text = String(arg || '');
    if (flags.has(text)) return true;
    return rule.flags.some((flag) => text.startsWith(flag + '='));
  });
}

function buildToolCliArgs({ toolId, args, model }) {
  const baseArgs = Array.isArray(args) ? args.slice() : [];
  const selectedModel = normalizeCliModelOverride(model);
  const rule = CLI_MODEL_ARG_RULES[toolId];
  if (!selectedModel || !rule || hasCliModelArg(baseArgs, rule)) return baseArgs;
  return baseArgs.concat(rule.append(selectedModel));
}

function normalizeCliTerminal(value) {
  const terminal = String(value || 'cmd')
    .trim()
    .toLowerCase();
  if (
    !terminal ||
    terminal === 'cmd' ||
    terminal === 'commandprompt' ||
    terminal === 'command-prompt'
  ) {
    return 'cmd';
  }
  if (
    terminal === 'pwsh' ||
    terminal === 'pwsh.exe' ||
    terminal === 'powershell7' ||
    terminal === 'powershell-7' ||
    terminal === 'powershell 7' ||
    terminal === 'power-shell-7' ||
    terminal === 'power-shell 7'
  ) {
    return 'PowerShell 7';
  }
  if (terminal === 'powershell' || terminal === 'power-shell') return 'PowerShell';
  throw new Error('Unsupported terminal: ' + String(value || ''));
}

function resolveCliWorkDir(value, fallbackDir = process.cwd()) {
  const resolved = path.resolve(value ? String(value) : fallbackDir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new Error('Working directory does not exist: ' + resolved);
  }
  if (!stat.isDirectory()) throw new Error('Working directory is not a directory: ' + resolved);
  return resolved;
}

function buildCliLaunchCommand({ terminal, command, args, workDir, model }) {
  const normalizedTerminal = normalizeCliTerminal(terminal);
  const argv = [command, ...args];
  if (normalizedTerminal === 'PowerShell' || normalizedTerminal === 'PowerShell 7') {
    const psCommand = [
      `$Host.UI.RawUI.WindowTitle=${quotePowerShell('Claude Code (' + safeTitle(model) + ')')}`,
      `Set-Location -LiteralPath ${quotePowerShell(workDir)}`,
      '& ' + argv.map(quotePowerShell).join(' '),
    ].join('; ');
    const shellCommand = normalizedTerminal === 'PowerShell 7' ? 'pwsh' : 'powershell';
    return `start ${shellCommand} -NoExit -EncodedCommand ${encodePowerShellCommand(psCommand)}`;
  }
  const cmd = [
    `title Claude Code (${safeTitle(model)})`,
    `cd /d ${quoteCmd(workDir)}`,
    argv.map(quoteCmd).join(' '),
  ].join(' && ');
  return `cmd /c start cmd /k ${quoteCmd(cmd)}`;
}

function buildCliLaunchSpec({ terminal, command, args, workDir, model }) {
  const normalizedTerminal = normalizeCliTerminal(terminal);
  const argv = [command, ...args];
  if (normalizedTerminal === 'PowerShell' || normalizedTerminal === 'PowerShell 7') {
    const psCommand = [
      `$Host.UI.RawUI.WindowTitle=${quotePowerShell('Claude Code (' + safeTitle(model) + ')')}`,
      `Set-Location -LiteralPath ${quotePowerShell(workDir)}`,
      '& ' + argv.map(quotePowerShell).join(' '),
    ].join('; ');
    const shellExecutable = normalizedTerminal === 'PowerShell 7' ? 'pwsh.exe' : 'powershell.exe';
    const startCommand = [
      'Start-Process',
      '-FilePath',
      quotePowerShell(shellExecutable),
      '-ArgumentList',
      '@(' +
        [
          quotePowerShell('-NoExit'),
          quotePowerShell('-EncodedCommand'),
          quotePowerShell(encodePowerShellCommand(psCommand)),
        ].join(',') +
        ')',
    ].join(' ');
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(startCommand),
      ],
    };
  }
  const cmd = [
    `title Claude Code (${safeTitle(model)})`,
    `cd /d ${quoteCmd(workDir)}`,
    argv.map(quoteCmd).join(' '),
  ].join(' && ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'start', `Claude Code (${safeTitle(model)})`, 'cmd.exe', '/k', cmd],
  };
}

function createManagementCliEnvHandlers({
  sendJson,
  cliSessions,
  getEntryServersSnapshot,
  getLocalServerSnapshot,
  defaultPort,
} = {}) {
  if (typeof sendJson !== 'function') throw new Error('sendJson is required');
  if (!cliSessions || typeof cliSessions.set !== 'function')
    throw new Error('cliSessions is required');
  if (typeof getEntryServersSnapshot !== 'function') {
    throw new Error('getEntryServersSnapshot is required');
  }
  if (typeof getLocalServerSnapshot !== 'function') {
    throw new Error('getLocalServerSnapshot is required');
  }

  async function handleLocalEnvCheckRequest(clientReq, clientRes) {
    try {
      const result = await checkEnvironmentTools();
      sendJson(clientRes, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  async function handleLocalEnvUpgradeRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body = {}) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { error: bodyErr.message });
        return;
      }
      try {
        body = requireJsonObjectBody(body);
        const { toolId } = body;
        const toolIds = Array.isArray(body.toolIds) ? body.toolIds.filter(Boolean) : null;
        let targetTools = [];
        if (toolIds && toolIds.length > 0) {
          const allowedIds = new Set(toolIds);
          targetTools = ENV_CHECK_TOOLS.filter((tool) => allowedIds.has(tool.id));
        } else if (toolId) {
          const found = ENV_CHECK_TOOLS.find((tool) => tool.id === toolId);
          if (found) targetTools.push(found);
        } else {
          targetTools = [...ENV_CHECK_TOOLS];
        }

        if (targetTools.length === 0) {
          throw new Error('未找到指定的工具包');
        }

        const results = [];
        for (const tool of targetTools) {
          const job = startToolInstallJob(tool);
          results.push({
            id: tool.id,
            name: tool.name,
            ok: job.status !== 'failed',
            jobId: job.jobId,
            status: job.status,
            error: job.error || null,
            startedAt: job.startedAt,
            endedAt: job.endedAt || null,
            installCommand: job.installCommand,
            usesIrm: job.usesIrm,
            lastLine: job.lastLine || '',
            outputTail: (job.output || '').slice(-2000),
          });
        }

        clearEnvCaches();
        sendJson(clientRes, 200, { ok: true, results });
      } catch (err) {
        sendJson(clientRes, err.statusCode || 500, { error: err.message });
      }
    });
  }

  function handleLocalEnvInstallJobsRequest(clientReq, clientRes) {
    try {
      const reqUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const ids = (reqUrl.searchParams.get('ids') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const jobs = listInstallJobs(ids);
      sendJson(clientRes, 200, { ok: true, jobs });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalSelectDirectoryRequest(clientReq, clientRes) {
    try {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dialog.Description = '选择工作目录'",
        '$dialog.ShowNewFolderButton = $true',
        "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
      ].join('; ');

      cp.execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 120000, windowsHide: false },
        (err, stdout) => {
          if (err) {
            const timedOut = err.killed || err.signal === 'SIGTERM';
            sendJson(clientRes, 500, {
              ok: false,
              error: timedOut ? '选择文件夹超时，请重试' : err.message,
            });
            return;
          }
          const selectedPath = stdout.trim();
          if (!selectedPath) {
            sendJson(clientRes, 200, { ok: true, cancelled: true });
            return;
          }
          sendJson(clientRes, 200, { ok: true, path: selectedPath });
        }
      );
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  async function handleLocalCliLaunchRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { error: bodyErr.message });
        return;
      }
      try {
        body = requireJsonObjectBody(body);
        const { toolId, model, cwd, envs, terminal, upgrade, customArgs } = body;

        if (!toolId) throw new Error('toolId is required');

        const foundTool = ENV_CHECK_TOOLS.find((tool) => tool.id === toolId);
        if (!foundTool) throw new Error('Unknown tool: ' + toolId);

        if (upgrade) {
          await new Promise((resolve) => {
            runToolInstall(foundTool)
              .then((res) => {
                if (!res.ok) {
                  console.error(`[cli-launch] Failed to upgrade ${foundTool.name}:`, res.error);
                }
                resolve();
              })
              .catch((err) => {
                console.error(`[cli-launch] Failed to upgrade ${foundTool.name}:`, err.message);
                resolve();
              });
          });
        }

        const sessionToken = 'hpm-session-' + crypto.randomBytes(12).toString('hex');
        const customArgList = parseCliArgs(customArgs);
        const launchArgList = buildToolCliArgs({
          toolId,
          args: customArgList,
          model,
        });
        cliSessions.set(sessionToken, {
          toolId,
          toolName: foundTool.name,
          modelOverride: model,
          customArgs: customArgs || '',
          createdAt: Date.now(),
          lastUsedAt: 0,
          requestCount: 0,
        });

        let proxyUrl = 'https://localhost:3443';
        const entries = getEntryServersSnapshot();
        const httpsEntry = entries.find(
          (entry) => entry.protocol === 'claude' || entry.protocol === 'openai'
        );
        if (httpsEntry) {
          proxyUrl = `${httpsEntry.tls === false ? 'http' : 'https'}://localhost:${httpsEntry.listenPort}`;
        } else {
          const localServer = getLocalServerSnapshot();
          if (localServer)
            proxyUrl = `${localServer.tls === false ? 'http' : 'https'}://localhost:${defaultPort}`;
        }

        const customEnvs = {};
        if (envs && typeof envs === 'string') {
          const lines = envs.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
              const key = trimmed.substring(0, idx).trim();
              const value = trimmed.substring(idx + 1).trim();
              if (key) {
                if (!SAFE_ENV_NAME_RE.test(key))
                  throw new Error('Invalid environment variable name: ' + key);
                customEnvs[key] = value;
              }
            }
          }
        }

        const injectedEnvs = {
          ANTHROPIC_BASE_URL: proxyUrl,
          ANTHROPIC_API_KEY: sessionToken,
          ANTHROPIC_AUTH_TOKEN: sessionToken,
          OPENAI_BASE_URL: proxyUrl + '/v1',
          OPENAI_API_KEY: sessionToken,
          GEMINI_API_BASE: proxyUrl + '/v1',
          GEMINI_API_KEY: sessionToken,
          GOOGLE_GEMINI_BASE_URL: proxyUrl + '/v1',
          DEEPSEEK_API_KEY: sessionToken,
          ...customEnvs,
        };
        if (toolId === 'claude-code') {
          delete injectedEnvs['ANTHROPIC_AUTH_TOKEN'];
        }

        const terminalName = normalizeCliTerminal(terminal);
        const workDir = resolveCliWorkDir(cwd, process.cwd());
        const launchSpec = buildCliLaunchSpec({
          terminal: terminalName,
          command: foundTool.command,
          args: launchArgList,
          workDir,
          model,
        });

        console.log(
          `[cli-launch] Launching ${foundTool.name} via ${terminalName} in ${workDir} with args: ${launchArgList.length ? launchArgList.join(' ') : 'none'}`
        );
        cp.execFile(
          launchSpec.file,
          launchSpec.args,
          { cwd: workDir, env: { ...process.env, ...injectedEnvs }, windowsHide: false },
          (err) => {
            if (err) {
              console.error(`[cli-launch] Exec error:`, err.message);
            }
          }
        );

        sendJson(clientRes, 200, { ok: true, sessionToken });
      } catch (err) {
        sendJson(clientRes, err.statusCode || 500, { error: err.message });
      }
    });
  }

  function handleLocalCliSessionsRequest(clientReq, clientRes) {
    try {
      const list = [];
      for (const [token, session] of cliSessions.entries()) {
        list.push({
          sessionToken: token,
          toolId: session.toolId,
          toolName: session.toolName || session.toolId,
          modelOverride: session.modelOverride,
          customArgs: session.customArgs || '',
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt || 0,
          requestCount: session.requestCount || 0,
        });
      }
      sendJson(clientRes, 200, { ok: true, sessions: list });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalCliSessionDeleteRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { error: bodyErr.message });
        return;
      }
      try {
        body = requireJsonObjectBody(body);
        const { sessionToken } = body;
        if (!sessionToken) throw new Error('sessionToken is required');

        const deleted = cliSessions.delete(sessionToken);
        sendJson(clientRes, 200, { ok: true, deleted });
      } catch (err) {
        sendJson(clientRes, err.statusCode || 500, { error: err.message });
      }
    });
  }

  return {
    handleLocalEnvCheckRequest,
    handleLocalEnvUpgradeRequest,
    handleLocalEnvInstallJobsRequest,
    handleLocalSelectDirectoryRequest,
    handleLocalCliLaunchRequest,
    handleLocalCliSessionsRequest,
    handleLocalCliSessionDeleteRequest,
  };
}

module.exports = {
  createManagementCliEnvHandlers,
  buildToolCliArgs,
  buildCliLaunchCommand,
  buildCliLaunchSpec,
  encodePowerShellCommand,
  normalizeCliModelOverride,
  normalizeCliTerminal,
  parseCliArgs,
  requireJsonObjectBody,
  resolveCliWorkDir,
};
