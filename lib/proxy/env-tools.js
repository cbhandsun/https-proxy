const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const https = require('https');
const cp = require('child_process');

const ENV_CHECK_TOOLS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    command: 'claude',
    allowCommandFallback: true,
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    packageName: 'antigravity-cli',
    command: 'agy',
    allowCommandFallback: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    packageName: '@openai/codex',
    command: 'codex',
    allowCommandFallback: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    packageName: 'opencode-ai',
    command: 'opencode',
    allowCommandFallback: true,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    packageName: 'openclaw',
    command: 'openclaw',
    allowCommandFallback: true,
  },
  {
    id: 'hermes',
    name: 'Hermes',
    packageName: 'hermes-agent',
    command: 'hermes',
    allowCommandFallback: true,
  },
];

const envInstallJobs = new Map();
const ENV_INSTALL_JOB_RETENTION_MS = 10 * 60 * 1000;
const CACHE_DURATION = 10 * 60 * 1000;
const LOCAL_PACKAGE_CACHE_DURATION = 60 * 1000;
const GLOBAL_NPM_ROOT_CACHE_DURATION = 10 * 60 * 1000;
const VERSION_COMMAND_TIMEOUT_MS = 1500;
const NPM_ROOT_TIMEOUT_MS = 2500;
const DEFAULT_VERSION_RESPONSE_MAX_BYTES = 256 * 1024;
const DEFAULT_INSTALL_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_INSTALL_JOB_TIMEOUT_MS = 60 * 60 * 1000;

let latestVersionsCache = null;
let latestVersionsCacheTime = 0;
let latestVersionsRefreshInFlight = null;
let installedPackagesCache = null;
let installedPackagesCacheTime = 0;
let globalNpmRootCache = null;
let globalNpmRootCacheTime = 0;
const localVersionFallbackCache = new Map();
let isUpgradeRunning = false;

function readResponseTextBounded(
  res,
  ownerReq,
  callback,
  maxBytes = DEFAULT_VERSION_RESPONSE_MAX_BYTES
) {
  const chunks = [];
  let bytes = 0;
  let finished = false;
  function finish(err, text) {
    if (finished) return;
    finished = true;
    callback(err, text || '');
  }
  res.on('data', (chunk) => {
    if (finished) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) {
      const err = new Error('Response body too large; max ' + maxBytes + ' bytes');
      if (typeof res.destroy === 'function') res.destroy();
      if (ownerReq && typeof ownerReq.destroy === 'function') ownerReq.destroy(err);
      finish(err);
      return;
    }
    chunks.push(buffer);
  });
  res.on('end', () => {
    if (finished) return;
    finish(null, Buffer.concat(chunks, bytes).toString('utf8'));
  });
  res.on('error', (err) => finish(err));
}

function detectLocalProxyPort() {
  return new Promise((resolve) => {
    const candidatePorts = [10808, 7890, 1080, 10809, 7891];
    let index = 0;
    function checkNext() {
      if (index >= candidatePorts.length) {
        return resolve(null);
      }
      const port = candidatePorts[index];
      const socket = new net.Socket();
      socket.setTimeout(150);
      socket.on('connect', () => {
        socket.destroy();
        resolve(port);
      });
      socket.on('error', () => {
        index++;
        checkNext();
      });
      socket.on('timeout', () => {
        socket.destroy();
        index++;
        checkNext();
      });
      socket.connect(port, '127.0.0.1');
    }
    checkNext();
  });
}

function getToolInstallCommand(tool) {
  if (!tool || !tool.packageName) return '';
  if (tool.id === 'claude-code') {
    return 'irm https://claude.ai/install.ps1 | iex';
  }
  if (tool.id === 'antigravity-cli') {
    return 'irm https://antigravity.google/cli/install.ps1 | iex';
  }
  return `npm i -g ${tool.packageName}@latest`;
}

function getToolInstallProcessSpec(tool) {
  if (tool && (tool.id === 'claude-code' || tool.id === 'antigravity-cli')) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', getToolInstallCommand(tool)],
      displayCommand: getToolInstallCommand(tool),
      usesIrm: true,
    };
  }
  return {
    file: process.platform === 'win32' ? 'cmd.exe' : 'npm',
    args:
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm.cmd', 'install', '-g', `${tool.packageName}@latest`]
        : ['install', '-g', `${tool.packageName}@latest`],
    displayCommand: getToolInstallCommand(tool),
    usesIrm: false,
  };
}

function appendInstallJobOutput(job, chunk) {
  const text = String(chunk || '').replace(/\r/g, '\n');
  if (!text.trim()) return;
  job.output = `${job.output || ''}${text}`;
  if (job.output.length > 8000) {
    job.output = job.output.slice(-8000);
  }
  const lines = job.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  job.lastLine = lines[lines.length - 1] || job.lastLine || '';
}

function serializeInstallJob(job) {
  return {
    jobId: job.jobId,
    toolId: job.toolId,
    name: job.name,
    status: job.status,
    ok: job.ok,
    error: job.error || null,
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
    timeoutMs: job.timeoutMs || null,
    installCommand: job.installCommand,
    usesIrm: job.usesIrm,
    lastLine: job.lastLine || '',
    outputTail: (job.output || '').slice(-2000),
  };
}

function pruneInstallJobs() {
  const cutoff = Date.now() - ENV_INSTALL_JOB_RETENTION_MS;
  for (const [jobId, job] of envInstallJobs.entries()) {
    if (job.endedAt && job.endedAt < cutoff) {
      envInstallJobs.delete(jobId);
    }
  }
}

function parseInstallJobTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INSTALL_JOB_TIMEOUT_MS;
  return Math.min(MAX_INSTALL_JOB_TIMEOUT_MS, Math.max(30 * 1000, Math.floor(parsed)));
}

function startToolInstallJob(tool) {
  pruneInstallJobs();
  const spec = getToolInstallProcessSpec(tool);
  const timeoutMs = parseInstallJobTimeoutMs(process.env.PROXY_ENV_INSTALL_TIMEOUT_MS);
  const jobId = `env-install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    toolId: tool.id,
    name: tool.name,
    status: 'running',
    ok: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    timeoutMs,
    installCommand: spec.displayCommand,
    usesIrm: spec.usesIrm,
    output: '',
    lastLine: spec.usesIrm ? '正在执行官方 irm 安装脚本...' : '正在执行 npm 全局安装...',
  };
  envInstallJobs.set(jobId, job);

  try {
    let settled = false;
    let timeoutId = null;
    const child = cp.spawn(spec.file, spec.args, {
      windowsHide: true,
      shell: false,
    });
    const finishJob = (status, ok, error, lastLine) => {
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      job.status = status;
      job.ok = ok;
      job.error = error || null;
      job.endedAt = Date.now();
      if (lastLine) job.lastLine = lastLine;
      if (ok) clearEnvCaches();
    };
    job.pid = child.pid || null;
    appendInstallJobOutput(job, `> ${spec.displayCommand}\n`);
    timeoutId = setTimeout(() => {
      appendInstallJobOutput(
        job,
        `\n安装任务超过 ${Math.round(timeoutMs / 1000)} 秒，已尝试终止。\n`
      );
      try {
        if (child && typeof child.kill === 'function') child.kill();
      } catch (errKill) {}
      finishJob(
        'failed',
        false,
        `安装任务超时 (${Math.round(timeoutMs / 1000)} 秒)`,
        '安装/升级超时'
      );
    }, timeoutMs);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
    child.stdout.on('data', (chunk) => appendInstallJobOutput(job, chunk));
    child.stderr.on('data', (chunk) => appendInstallJobOutput(job, chunk));
    child.on('error', (err) => {
      appendInstallJobOutput(job, `\n${err.message}\n`);
      finishJob('failed', false, err.message);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finishJob('succeeded', true, null, '安装/升级完成');
      } else {
        const error = `安装进程退出码 ${code}`;
        finishJob('failed', false, error, job.lastLine || error);
      }
    });
  } catch (err) {
    job.status = 'failed';
    job.ok = false;
    job.error = err.message;
    job.endedAt = Date.now();
    appendInstallJobOutput(job, `\n${err.message}\n`);
  }

  return job;
}

function runToolInstall(tool) {
  return new Promise((resolve) => {
    const job = startToolInstallJob(tool);
    const finish = () => {
      if (job.status === 'running') {
        setTimeout(finish, 500);
        return;
      }
      if (job.ok) {
        resolve({ id: tool.id, name: tool.name, ok: true, jobId: job.jobId });
      } else {
        resolve({
          id: tool.id,
          name: tool.name,
          ok: false,
          error: job.error || job.lastLine || '安装失败',
          jobId: job.jobId,
        });
      }
    };
    finish();
  });
}

function listInstallJobs(ids) {
  pruneInstallJobs();
  const sourceJobs =
    Array.isArray(ids) && ids.length > 0
      ? ids.map((id) => envInstallJobs.get(id)).filter(Boolean)
      : Array.from(envInstallJobs.values());
  return sourceJobs.map(serializeInstallJob);
}

function execFileText(file, args = [], options = {}, timeout = VERSION_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      cp.execFile(
        file,
        args,
        {
          timeout,
          windowsHide: true,
          maxBuffer: 128 * 1024,
          ...options,
        },
        (err, stdout) => {
          if (err) return resolve(null);
          const text = stdout ? String(stdout).trim() : '';
          resolve(text || null);
        }
      );
    } catch (err) {
      resolve(null);
    }
  });
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

function buildShellCommandExecSpec(file, args = []) {
  const command = [file, ...args].map(quoteCmd).join(' ');
  return {
    file: process.platform === 'win32' ? 'cmd.exe' : file,
    args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : args,
  };
}

function execCommandText(file, args = [], options = {}, timeout = VERSION_COMMAND_TIMEOUT_MS) {
  const spec = buildShellCommandExecSpec(file, args);
  return execFileText(spec.file, spec.args, options, timeout);
}

function execPowerShellText(script, timeout = VERSION_COMMAND_TIMEOUT_MS) {
  return execFileText(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', String(script || '')],
    {},
    timeout
  );
}

function isSafeHttpsUrl(value) {
  try {
    const text = String(value || '');
    if (/[\r\n\0]/.test(text)) return false;
    const parsed = new URL(text);
    return parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function normalizeProxyPort(value) {
  if (value == null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('proxyPort must be an integer between 1 and 65535');
  }
  return port;
}

function buildCurlArgs(url, proxyPort, extraArgs = []) {
  if (!isSafeHttpsUrl(url)) throw new Error('Only https URLs are allowed');
  const safeProxyPort = normalizeProxyPort(proxyPort);
  const args = [];
  if (safeProxyPort) args.push('-x', `socks5h://127.0.0.1:${safeProxyPort}`);
  args.push(...extraArgs, url);
  return args;
}

function execCurlText(url, proxyPort, extraArgs = [], timeout = 8000) {
  return new Promise((resolve) => {
    let args;
    try {
      args = buildCurlArgs(url, proxyPort, extraArgs);
    } catch (err) {
      resolve(null);
      return;
    }
    cp.execFile(
      'curl.exe',
      args,
      { timeout, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout ? String(stdout).trim() : null);
      }
    );
  });
}

function downloadWithCurl(url, dest, proxyPort) {
  return new Promise((resolve, reject) => {
    let args;
    try {
      args = buildCurlArgs(url, proxyPort, [
        '-L',
        '--retry',
        '5',
        '--retry-delay',
        '2',
        '-o',
        dest,
      ]);
    } catch (err) {
      reject(err);
      return;
    }
    cp.execFile('curl.exe', args, { windowsHide: true, timeout: 120000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function downloadWithPowerShell(url, dest, proxyPort) {
  return new Promise((resolve, reject) => {
    if (!isSafeHttpsUrl(url)) {
      reject(new Error('Only https URLs are allowed'));
      return;
    }
    let safeProxyPort;
    try {
      safeProxyPort = normalizeProxyPort(proxyPort);
    } catch (err) {
      reject(err);
      return;
    }
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    ];
    if (safeProxyPort) command.push(`$proxy = 'http://127.0.0.1:${safeProxyPort}'`);
    command.push(
      safeProxyPort
        ? 'Invoke-WebRequest -Proxy $proxy -Uri $args[0] -OutFile $args[1] -UseBasicParsing'
        : 'Invoke-WebRequest -Uri $args[0] -OutFile $args[1] -UseBasicParsing'
    );
    cp.execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command.join('; '),
        url,
        dest,
      ],
      { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      }
    );
  });
}

function validateAntigravityManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest');
  }
  if (!isSafeHttpsUrl(manifest.url)) {
    throw new Error('Manifest release URL must be https');
  }
  const sha512 = String(manifest.sha512 || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(sha512)) {
    throw new Error('Manifest is missing a valid sha512 checksum');
  }
  return {
    ...manifest,
    sha512,
  };
}

function parseVersionText(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : String(text).trim();
}

function escapePowerShellSingleQuotedString(value) {
  return String(value || '').replace(/'/g, "''");
}

function parseWindowsAppsPackageVersion(commandPath) {
  if (!commandPath) return null;
  const match = String(commandPath).match(/[\\/][^\\/]+_(\d+\.\d+(?:\.\d+){0,2})_[^\\/]+[\\/]/i);
  return match ? match[1] : null;
}

async function resolveWindowsCommandSource(commandName) {
  if (process.platform !== 'win32' || !commandName) return null;
  const escaped = escapePowerShellSingleQuotedString(commandName);
  const source = await execPowerShellText(
    `(Get-Command '${escaped}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)`,
    1000
  );
  return source ? source.split(/\r?\n/)[0].trim() : null;
}

async function readWindowsExecutableVersion(commandPath) {
  if (process.platform !== 'win32' || !commandPath) return null;
  const packageVersion = parseWindowsAppsPackageVersion(commandPath);
  if (packageVersion) return packageVersion;
  const psPath = escapePowerShellSingleQuotedString(commandPath);
  const productVersion = await execPowerShellText(
    `(Get-Item '${psPath}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`,
    1000
  );
  return parseVersionText(productVersion);
}

function pushExistingCommandCandidates(commandsToTry, dir, cmdName) {
  if (!dir || !cmdName) return;
  for (const ext of ['.exe', '.cmd', '']) {
    const commandPath = path.join(dir, `${cmdName}${ext}`);
    try {
      if (fs.existsSync(commandPath)) {
        commandsToTry.push(commandPath);
      }
    } catch (err) {}
  }
}

function addPathCommandCandidates(commandsToTry, cmdName) {
  const pathValue = process.env.PATH || process.env.Path || '';
  for (const dir of pathValue.split(path.delimiter)) {
    pushExistingCommandCandidates(commandsToTry, dir.trim(), cmdName);
  }
}

function addCodexAppCommandCandidates(commandsToTry, appDataLocal, cmdName) {
  if (cmdName !== 'codex') return;
  const codexBinRoot = path.join(appDataLocal, 'OpenAI', 'Codex', 'bin');
  try {
    if (!fs.existsSync(codexBinRoot)) return;
    const dirs = fs
      .readdirSync(codexBinRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(codexBinRoot, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs || 0;
        } catch (err) {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const dir of dirs) {
      pushExistingCommandCandidates(commandsToTry, dir.fullPath, cmdName);
    }
  } catch (err) {}
}

async function resolveGlobalNpmRoot() {
  const now = Date.now();
  if (globalNpmRootCache && now - globalNpmRootCacheTime < GLOBAL_NPM_ROOT_CACHE_DURATION) {
    return globalNpmRootCache;
  }

  const npmRoot =
    process.platform === 'win32'
      ? await execCommandText('npm.cmd', ['root', '-g'], {}, NPM_ROOT_TIMEOUT_MS)
      : await execFileText('npm', ['root', '-g'], {}, NPM_ROOT_TIMEOUT_MS);
  if (npmRoot) {
    globalNpmRootCache = npmRoot.split(/\r?\n/)[0].trim();
    globalNpmRootCacheTime = Date.now();
    return globalNpmRootCache;
  }

  try {
    const fallbackRoot =
      process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'node_modules')
        : '/usr/local/lib/node_modules';
    globalNpmRootCache = fallbackRoot;
    globalNpmRootCacheTime = Date.now();
    return fallbackRoot;
  } catch (err) {
    return null;
  }
}

function readInstalledPackageVersion(root, packageName) {
  try {
    if (!root || !packageName) return null;
    const packageJsonPath = path.join(root, ...packageName.split('/'), 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return parsed && parsed.version ? parsed.version : null;
  } catch (err) {
    return null;
  }
}

function fetchLatestVersion(packageName) {
  return new Promise((resolve) => {
    let resolved = false;

    function safeResolve(val) {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    }

    if (packageName === 'antigravity-cli') {
      try {
        let osPlatform = process.platform;
        if (osPlatform === 'win32') osPlatform = 'windows';
        let arch = process.arch;
        if (arch === 'x64') arch = 'amd64';
        const platform = `${osPlatform}_${arch}`;
        const url = `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`;

        detectLocalProxyPort().then((proxyPort) => {
          execCurlText(url, proxyPort, ['-L', '-s', '-m', '5'], 8000).then((stdout) => {
            if (stdout) {
              try {
                const parsed = JSON.parse(stdout);
                if (parsed && parsed.version) {
                  return safeResolve(parsed.version);
                }
              } catch (e) {}
            }

            try {
              const req = https.request(url, { timeout: 4000 }, (res) => {
                readResponseTextBounded(res, req, (bodyErr, body) => {
                  if (bodyErr) {
                    safeResolve(null);
                    return;
                  }
                  try {
                    const parsed = JSON.parse(body);
                    safeResolve(parsed.version || null);
                  } catch (e) {
                    safeResolve(null);
                  }
                });
              });

              req.on('timeout', () => {
                req.destroy();
              });

              req.on('error', () => {
                safeResolve(null);
              });

              req.end();
            } catch (errHttps) {
              safeResolve(null);
            }
          });
        });
      } catch (err) {
        safeResolve(null);
      }
      return;
    }

    try {
      const req = https.request(
        `https://registry.npmmirror.com/${packageName}/latest`,
        { timeout: 4000 },
        (res) => {
          readResponseTextBounded(res, req, (bodyErr, body) => {
            if (bodyErr) {
              safeResolve(null);
              return;
            }
            try {
              const parsed = JSON.parse(body);
              safeResolve(parsed.version || null);
            } catch (e) {
              safeResolve(null);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
      });

      req.on('error', () => {
        try {
          const reqJs = https.request(
            `https://registry.npmjs.org/${packageName}/latest`,
            { timeout: 4000 },
            (resJs) => {
              readResponseTextBounded(resJs, reqJs, (bodyErr, bodyJs) => {
                if (bodyErr) {
                  safeResolve(null);
                  return;
                }
                try {
                  const parsedJs = JSON.parse(bodyJs);
                  safeResolve(parsedJs.version || null);
                } catch (e) {
                  safeResolve(null);
                }
              });
            }
          );

          reqJs.on('timeout', () => {
            reqJs.destroy();
          });

          reqJs.on('error', () => {
            safeResolve(null);
          });

          reqJs.end();
        } catch (errJs) {
          safeResolve(null);
        }
      });

      req.end();
    } catch (err) {
      safeResolve(null);
    }
  });
}

function refreshLatestVersionsCache() {
  if (latestVersionsRefreshInFlight) return latestVersionsRefreshInFlight;
  latestVersionsRefreshInFlight = Promise.all(
    ENV_CHECK_TOOLS.map((t) => fetchLatestVersion(t.packageName))
  )
    .then((latestResults) => {
      latestVersionsCache = {};
      ENV_CHECK_TOOLS.forEach((t, i) => {
        latestVersionsCache[t.id] = latestResults[i];
      });
      latestVersionsCacheTime = Date.now();
      return latestVersionsCache;
    })
    .catch(() => latestVersionsCache || {})
    .finally(() => {
      latestVersionsRefreshInFlight = null;
    });
  return latestVersionsRefreshInFlight;
}

function getLocalVersionFallback(tool) {
  const cacheKey = tool && tool.id ? tool.id : tool.command;
  const cached = localVersionFallbackCache.get(cacheKey);
  if (cached && Date.now() - cached.time < LOCAL_PACKAGE_CACHE_DURATION) {
    return Promise.resolve(cached.version);
  }

  return new Promise((resolve) => {
    function finish(version) {
      localVersionFallbackCache.set(cacheKey, { version: version || null, time: Date.now() });
      resolve(version || null);
    }

    (async () => {
      try {
        let commandsToTry = [];
        const commandNames = [tool.command];
        if (tool.id === 'antigravity-cli' && tool.command !== 'agy') {
          commandNames.push('agy');
        }

        if (process.platform === 'win32') {
          const home = os.homedir();
          const appDataLocal = path.join(home, 'AppData', 'Local');
          const appDataRoaming = path.join(home, 'AppData', 'Roaming');

          for (const cmdName of commandNames) {
            const candidateDirs = [
              path.join(home, '.local', 'bin'),
              path.join(home, '.antigravity', 'bin'),
              path.join(appDataLocal, 'agy', 'bin'),
              path.join(appDataRoaming, 'npm'),
              path.join(appDataLocal, 'Programs', cmdName),
              path.join(appDataLocal, 'Programs', `${cmdName}-cli`),
              path.join(appDataLocal, cmdName, 'bin'),
              path.join(appDataLocal, cmdName),
              path.join(appDataRoaming, cmdName, 'bin'),
              path.join(appDataRoaming, cmdName),
            ];

            addCodexAppCommandCandidates(commandsToTry, appDataLocal, cmdName);
            addPathCommandCandidates(commandsToTry, cmdName);

            for (const dir of candidateDirs) {
              pushExistingCommandCandidates(commandsToTry, dir, cmdName);
            }

            commandsToTry.push(cmdName);
            commandsToTry.push(`${cmdName}.cmd`);
          }

          const resolvedSources = await Promise.all(
            commandNames.flatMap((cmdName) => [
              resolveWindowsCommandSource(cmdName),
              resolveWindowsCommandSource(`${cmdName}.exe`),
              resolveWindowsCommandSource(`${cmdName}.cmd`),
            ])
          );
          for (const source of resolvedSources) {
            if (source) commandsToTry.push(source);
          }
        } else {
          for (const cmdName of commandNames) {
            commandsToTry.push(cmdName);
          }
        }

        const seenCommands = new Set();
        commandsToTry = commandsToTry.filter((cmd) => {
          const key = String(cmd).toLowerCase();
          if (seenCommands.has(key)) return false;
          seenCommands.add(key);
          return true;
        });

        const tryNextCommand = async function (index) {
          if (index >= commandsToTry.length) {
            return finish(null);
          }
          const cmd = commandsToTry[index];
          const canExecFile =
            process.platform === 'win32' &&
            path.isAbsolute(cmd) &&
            !cmd.toLowerCase().endsWith('.cmd');
          const versionOut = canExecFile
            ? await execFileText(cmd, ['--version'])
            : await execCommandText(cmd, ['--version']);
          const version = parseVersionText(versionOut);
          if (version) return finish(version);

          const shortVersionOut = canExecFile
            ? await execFileText(cmd, ['-v'])
            : await execCommandText(cmd, ['-v']);
          const shortVersion = parseVersionText(shortVersionOut);
          if (shortVersion) return finish(shortVersion);

          if (process.platform === 'win32') {
            const executableVersion = await readWindowsExecutableVersion(cmd);
            if (executableVersion) return finish(executableVersion);
          }

          tryNextCommand(index + 1);
        };

        tryNextCommand(0);
      } catch (e) {
        finish(null);
      }
    })();
  });
}

async function checkLocalNpmPackages() {
  const now = Date.now();
  if (installedPackagesCache && now - installedPackagesCacheTime < LOCAL_PACKAGE_CACHE_DURATION) {
    return installedPackagesCache;
  }

  const installed = {};
  const root = await resolveGlobalNpmRoot();
  for (const tool of ENV_CHECK_TOOLS) {
    const version = readInstalledPackageVersion(root, tool.packageName);
    if (version) installed[tool.packageName] = version;
  }

  installedPackagesCache = installed;
  installedPackagesCacheTime = Date.now();
  return installed;
}

function isVersionNewer(current, latest) {
  if (!current || !latest) return false;
  const parseComparableVersion = (value) => {
    const text = String(value || '').trim();
    const match = text.match(/^(\d+(?:\.\d+){0,3})(-.+)?(?:\+.+)?$/);
    const numeric = (match ? match[1] : text).split('.').map((x) => parseInt(x, 10) || 0);
    return {
      numeric,
      prerelease: !!(match && match[2]),
    };
  };
  const p1 = parseComparableVersion(current);
  const p2 = parseComparableVersion(latest);
  const maxLen = Math.max(p1.numeric.length, p2.numeric.length);
  for (let i = 0; i < maxLen; i++) {
    const v1 = p1.numeric[i] || 0;
    const v2 = p2.numeric[i] || 0;
    if (v2 > v1) return true;
    if (v2 < v1) return false;
  }
  if (p1.prerelease && !p2.prerelease) return true;
  return false;
}

async function checkEnvironmentTools() {
  const installedNpm = await checkLocalNpmPackages();
  const now = Date.now();
  const latestIsFresh = latestVersionsCache && now - latestVersionsCacheTime <= CACHE_DURATION;
  const latestPending = !latestIsFresh;
  if (latestPending) {
    refreshLatestVersionsCache();
  }

  const checkPromises = ENV_CHECK_TOOLS.map(async (tool) => {
    let current = installedNpm[tool.packageName] || null;
    if (tool.id === 'antigravity-cli') {
      const nativeVer = await getLocalVersionFallback(tool);
      if (nativeVer) {
        current = nativeVer;
      }
    } else if (!current && tool.allowCommandFallback) {
      current = await getLocalVersionFallback(tool);
    }

    const latest = latestVersionsCache ? latestVersionsCache[tool.id] || null : null;
    let hasUpdate = false;
    if (current && latest) {
      try {
        hasUpdate = isVersionNewer(current, latest);
      } catch (e) {}
    }

    return {
      id: tool.id,
      name: tool.name,
      packageName: tool.packageName,
      command: tool.command,
      installCommand: getToolInstallCommand(tool),
      current,
      latest,
      hasUpdate,
    };
  });

  return {
    tools: await Promise.all(checkPromises),
    latestPending,
    latestUpdatedAt: latestVersionsCacheTime || null,
  };
}

function clearEnvCaches() {
  latestVersionsCache = null;
  installedPackagesCache = null;
  localVersionFallbackCache.clear();
}

function upgradeAntigravityCli() {
  if (isUpgradeRunning) {
    console.log(
      'Antigravity CLI upgrade is already running in the background. Skipping duplicate request.'
    );
    return Promise.resolve({ ok: true });
  }
  isUpgradeRunning = true;

  return new Promise((resolve) => {
    function finish(res) {
      isUpgradeRunning = false;
      resolve(res);
    }

    let osPlatform = process.platform;
    if (osPlatform === 'win32') osPlatform = 'windows';
    let arch = process.arch;
    if (arch === 'x64') arch = 'amd64';
    const platform = `${osPlatform}_${arch}`;
    const manifestUrl = `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`;

    function getJson(url, proxyPort) {
      return new Promise((resVal, rejVal) => {
        if (!isSafeHttpsUrl(url)) {
          rejVal(new Error('Only https manifest URLs are allowed'));
          return;
        }
        execCurlText(url, proxyPort, ['-L', '-s', '-m', '8'], 12000).then((stdout) => {
          if (stdout) {
            try {
              return resVal(JSON.parse(stdout));
            } catch (e) {}
          }

          const req = https.get(url, { timeout: 10000 }, (res) => {
            readResponseTextBounded(res, req, (bodyErr, body) => {
              if (bodyErr) {
                rejVal(bodyErr);
                return;
              }
              try {
                resVal(JSON.parse(body));
              } catch (e) {
                rejVal(e);
              }
            });
          });
          req.on('timeout', () => {
            req.destroy();
            rejVal(new Error('Manifest request timeout'));
          });
          req.on('error', rejVal);
        });
      });
    }

    function downloadFileViaPowershell(url, dest, proxyPort) {
      return downloadWithCurl(url, dest, proxyPort).catch((curlErr) => {
        console.warn(`curl.exe failed: ${curlErr.message}. Falling back to PowerShell.`);
        return downloadWithPowerShell(url, dest, proxyPort);
      });
    }

    detectLocalProxyPort().then((proxyPort) => {
      getJson(manifestUrl, proxyPort)
        .then((manifest) => {
          let releaseManifest;
          try {
            releaseManifest = validateAntigravityManifest(manifest);
          } catch (err) {
            return finish({ ok: false, error: err.message });
          }

          const targetDir = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin');
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          const targetExe = path.join(targetDir, 'agy.exe');

          const stagingDir = path.join(os.homedir(), 'AppData', 'Local', 'antigravity', 'staging');
          if (!fs.existsSync(stagingDir)) {
            fs.mkdirSync(stagingDir, { recursive: true });
          }
          const stagingExe = path.join(stagingDir, 'agy.exe');

          downloadFileViaPowershell(releaseManifest.url, stagingExe, proxyPort)
            .then(() => {
              const crypto = require('crypto');
              const hash = crypto.createHash('sha512');
              const fileBuffer = fs.readFileSync(stagingExe);
              hash.update(fileBuffer);
              const fileHash = hash.digest('hex').toLowerCase();
              if (fileHash !== releaseManifest.sha512) {
                return finish({ ok: false, error: 'Checksum verification failed' });
              }

              try {
                let execPath = stagingExe;
                try {
                  if (fs.existsSync(targetExe)) {
                    fs.unlinkSync(targetExe);
                  }
                  fs.copyFileSync(stagingExe, targetExe);
                  execPath = targetExe;
                } catch (errCopy) {
                  console.warn(
                    `Could not copy to target path, executing from staging: ${errCopy.message}`
                  );
                }

                cp.execFile(execPath, ['install'], { windowsHide: true }, (errInst) => {
                  if (errInst) {
                    console.error(`agy.exe install failed: ${errInst.message}`);
                  }
                  setTimeout(() => {
                    try {
                      if (fs.existsSync(stagingExe)) {
                        fs.unlinkSync(stagingExe);
                      }
                    } catch (e) {}
                  }, 10000);
                });

                finish({ ok: true });
              } catch (errWrite) {
                finish({ ok: false, error: `Failed to execute installer: ${errWrite.message}` });
              }
            })
            .catch((errDl) => {
              finish({ ok: false, error: `Failed to download: ${errDl.message}` });
            });
        })
        .catch((errManifest) => {
          finish({ ok: false, error: `Failed to fetch manifest: ${errManifest.message}` });
        });
    });
  });
}

module.exports = {
  ENV_CHECK_TOOLS,
  getToolInstallCommand,
  getToolInstallProcessSpec,
  startToolInstallJob,
  runToolInstall,
  listInstallJobs,
  checkEnvironmentTools,
  clearEnvCaches,
  upgradeAntigravityCli,
  isVersionNewer,
  parseVersionText,
  _test: {
    buildCurlArgs,
    buildShellCommandExecSpec,
    execPowerShellText,
    isSafeHttpsUrl,
    normalizeProxyPort,
    parseInstallJobTimeoutMs,
    readResponseTextBounded,
    validateAntigravityManifest,
  },
};
