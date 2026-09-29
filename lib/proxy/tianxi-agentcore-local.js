'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const { parseTianxiAgentCoreNotify } = require('./tianxi-agentcore-protocol');

const DEFAULT_TAC_SERVER_WS_URL = 'ws://127.0.0.1:63982/ws/connect';
const DEFAULT_TAC_SERVER_EXE_PATH =
  'C:\\Program Files\\Lenovo\\AIAgent\\Modules\\AgentServer\\tac-server.exe';
const DEFAULT_TAC_SERVER_PORT = 63982;
const DEFAULT_AGENTCORE_LOG_PATH =
  'C:\\ProgramData\\Lenovo\\AIAgent\\logs\\xlagentcoreplugin.dll.log.logdat';

const HEADER_FIELDS = [
  'app_id',
  'app_version',
  'credentials',
  'device_id',
  'device_type',
  'resource_id',
  'role',
  'tab_id',
  'user_id',
];

const DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_TIANXI_REGISTRY_ROOT = 'HKCU:\\Software\\Lenovo\\AIAgent';

function decodeLogdatBuffer(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer)) return '';
  return Buffer.from(
    buffer.map((byte, index) => (offset === 0 && index < 4 ? byte : byte ^ 0xff))
  ).toString('utf8');
}

function readLogdatTail(filePath = DEFAULT_AGENTCORE_LOG_PATH, maxBytes = 512 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, maxBytes);
    const offset = Math.max(0, stat.size - size);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, offset);
    return decodeLogdatBuffer(buffer, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function hasTerminalTianxiNotifyFrame(value) {
  return parseTianxiAgentCoreNotify(value).some((frame) => {
    const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
    const status = String(data.status || frame.status || '').toUpperCase();
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(status);
  });
}

function hasVisibleTianxiNotifyFrame(value) {
  return parseTianxiAgentCoreNotify(value).some((frame) =>
    ['task_output', 'act_exec', 'act_resp', 'risk_exec'].includes(frame && frame.type)
  );
}

function safeHeaderValue(value) {
  if (value == null) return '';
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return String(value).trim();
}

function decodeBase64UrlJson(segment) {
  if (typeof segment !== 'string' || !segment.trim()) return null;
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return JSON.parse(Buffer.from(padded + padding, 'base64').toString('utf8'));
  } catch (_err) {
    return null;
  }
}

function decodeJwtLikePayload(token) {
  if (typeof token !== 'string') return null;
  const compact = token.trim().replace(/^sat-/i, '');
  const parts = compact.split('.');
  if (parts.length < 2) return null;
  return decodeBase64UrlJson(parts[1]);
}

function getJwtExpiryMs(token) {
  const payload = decodeJwtLikePayload(token);
  const exp = payload && Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp < 1e12 ? exp * 1000 : exp;
}

function isPlaintextServiceAccountToken(token) {
  if (typeof token !== 'string') return false;
  const value = token.trim();
  if (!value) return false;
  if (/^\d+(?:\s+\d+){8,}$/.test(value)) return false;
  return Boolean(decodeJwtLikePayload(value));
}

function parseEpochMs(value) {
  const number = Number(String(value || '').trim());
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

function expiryInfo(expiresAtMs, nowMs, skewMs) {
  if (!expiresAtMs) return null;
  return {
    expiresAtMs,
    expired: expiresAtMs <= nowMs + skewMs,
  };
}

function inspectTianxiCredentialExpiry(credentials, options = {}) {
  const source = credentials && typeof credentials === 'object' ? credentials : {};
  const nowMs =
    typeof options.nowMs === 'number'
      ? options.nowMs
      : typeof options.now === 'function'
        ? options.now()
        : Date.now();
  const skewMs =
    typeof options.skewMs === 'number' ? options.skewMs : DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS;
  const result = {};
  for (const key of ['qoder_token', 'tx_token']) {
    const expiresAtMs = getJwtExpiryMs(source[key]);
    const info = expiryInfo(expiresAtMs, nowMs, skewMs);
    if (info) result[key] = info;
  }
  return result;
}

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function readWindowsRegistryValue(keyPath, valueName, options = {}) {
  if (process.platform !== 'win32' && !options.forceWindows) return '';
  if (options.registryValues && typeof options.registryValues === 'object') {
    const direct = options.registryValues[`${keyPath}\\${valueName}`];
    if (direct != null) return String(direct);
    const nested = options.registryValues[keyPath];
    if (nested && typeof nested === 'object' && nested[valueName] != null) {
      return String(nested[valueName]);
    }
    return '';
  }
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const script =
      "$v=(Get-ItemProperty -LiteralPath '" +
      escapePowerShellSingleQuoted(keyPath) +
      "' -Name '" +
      escapePowerShellSingleQuoted(valueName) +
      "' -ErrorAction Stop).'" +
      escapePowerShellSingleQuoted(valueName) +
      "'; [Console]::Out.Write([string]$v)";
    return String(
      execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }) || ''
    ).trim();
  } catch (_err) {
    return '';
  }
}

function tianxiRegistryAccountKey(userId, root = DEFAULT_TIANXI_REGISTRY_ROOT) {
  const safeUserId = String(userId || '').trim();
  return safeUserId ? `${root}\\${safeUserId}` : root;
}

function readTianxiRegistryCredentialCache(options = {}) {
  const nowMs =
    typeof options.nowMs === 'number'
      ? options.nowMs
      : typeof options.now === 'function'
        ? options.now()
        : Date.now();
  const skewMs =
    typeof options.skewMs === 'number' ? options.skewMs : DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS;
  const root = options.root || DEFAULT_TIANXI_REGISTRY_ROOT;
  const keyPath = options.keyPath || tianxiRegistryAccountKey(options.userId, root);
  const readValue =
    typeof options.readValue === 'function'
      ? (name) => options.readValue(keyPath, name)
      : (name) => readWindowsRegistryValue(keyPath, name, options);
  const qoderToken = String(readValue('qoder_vpc_token') || '').trim();
  const loginToken = String(readValue('token4_0') || '').trim();
  const qoderExpiresAtMs = parseEpochMs(readValue('qoder_vpc_expires_after'));
  const loginExpiresAtMs = parseEpochMs(readValue('expires4_0after'));
  const credentialExpiry = {};
  const qoderInfo = expiryInfo(qoderExpiresAtMs, nowMs, skewMs);
  if (qoderInfo) credentialExpiry.qoder_token = qoderInfo;
  const loginInfo = expiryInfo(loginExpiresAtMs, nowMs, skewMs);
  if (loginInfo) credentialExpiry.tianxi_login_token = loginInfo;
  return {
    available: Boolean(qoderToken || loginToken || qoderInfo || loginInfo),
    source: 'tianxi-registry',
    keyScope: options.userId ? 'account' : 'root',
    credentials: {
      ...(isPlaintextServiceAccountToken(qoderToken) ? { qoder_token: qoderToken } : {}),
    },
    credentialExpiry,
    hasQoderToken: Boolean(qoderToken),
    hasLoginToken: Boolean(loginToken),
  };
}

function readTianxiRegistryCredentialCacheWithFallback(options = {}) {
  const accountCache = readTianxiRegistryCredentialCache(options);
  if (accountCache.available || !options.userId) return accountCache;
  const rootCache = readTianxiRegistryCredentialCache({
    ...options,
    userId: '',
    keyPath: options.root || DEFAULT_TIANXI_REGISTRY_ROOT,
  });
  if (!rootCache.available) return accountCache;
  return {
    ...rootCache,
    keyScope: 'root-fallback',
    fallbackFromUserId: String(options.userId || ''),
  };
}

function extractHeaderFromSendMessageLine(line) {
  const marker = 'SENDMESSAGE:';
  const index = String(line || '').indexOf(marker);
  if (index < 0) return null;
  try {
    const parsed = JSON.parse(
      String(line)
        .slice(index + marker.length)
        .trim()
    );
    const source = parsed.header && typeof parsed.header === 'object' ? parsed.header : {};
    const header = {};
    for (const field of HEADER_FIELDS) {
      const value = safeHeaderValue(source[field]);
      if (value) header[field] = value;
    }
    return header.app_id && header.device_id && header.user_id ? header : null;
  } catch (_err) {
    return null;
  }
}

function extractLatestAgentCoreHeader(text) {
  let latest = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    latest = extractHeaderFromSendMessageLine(line) || latest;
  }
  return latest;
}

function readLatestAgentCoreHeader(options = {}) {
  return extractLatestAgentCoreHeader(
    readLogdatTail(options.logPath || DEFAULT_AGENTCORE_LOG_PATH, options.maxBytes)
  );
}

function tacServerPortFromUrl(url) {
  try {
    const parsed = new URL(url || DEFAULT_TAC_SERVER_WS_URL);
    const port = Number(parsed.port);
    return Number.isSafeInteger(port) && port > 0 ? port : DEFAULT_TAC_SERVER_PORT;
  } catch (_err) {
    return DEFAULT_TAC_SERVER_PORT;
  }
}

function isTcpPortListening(port, options = {}) {
  const safePort = Number(port);
  if (!Number.isSafeInteger(safePort) || safePort <= 0) return false;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const output = String(
      execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        windowsHide: true,
      }) || ''
    );
    const portPattern = new RegExp(`(?:^|\\s)(?:\\[[^\\]]+\\]|\\S+):${safePort}\\s+`, 'm');
    return output
      .split(/\r?\n/)
      .some((line) => portPattern.test(line) && /\bLISTENING\b/i.test(line));
  } catch (_err) {
    return false;
  }
}

function discoverTianxiTacServerWsUrls(options = {}) {
  if (process.platform !== 'win32' && !options.forceWindows) return [];
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    let pidOutput = '';
    try {
      pidOutput = String(
        execFileSync('tasklist', ['/FI', 'IMAGENAME eq tac-server.exe', '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          windowsHide: true,
        }) || ''
      );
    } catch (_err) {}
    let pids = new Set(
      pidOutput
        .split(/\r?\n/)
        .map((line) => {
          const match = String(line || '').match(/^"?tac-server\.exe"?,"?(\d+)"?/i);
          return match ? match[1] : '';
        })
        .filter((line) => /^\d+$/.test(line))
    );
    if (pids.size === 0) {
      pidOutput = String(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-Process tac-server -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }',
          ],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10000,
            windowsHide: true,
          }
        ) || ''
      );
      pids = new Set(
        pidOutput
          .split(/\r?\n/)
          .map((line) => String(line || '').trim())
          .filter((line) => /^\d+$/.test(line))
      );
    }
    if (pids.size === 0) return [];
    const output = String(
      execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        windowsHide: true,
      }) || ''
    );
    const ports = [];
    for (const line of output.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const parts = String(line || '')
        .trim()
        .split(/\s+/);
      const pid = parts[parts.length - 1];
      if (!pids.has(pid)) continue;
      const local = parts[1] || '';
      const match = local.match(/:(\d+)$/);
      const port = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(port) && port > 0 && !ports.includes(port)) {
        ports.push(port);
      }
    }
    return ports.map((port) => `ws://127.0.0.1:${port}/ws/connect`);
  } catch (_err) {
    return [];
  }
}

function startTianxiTacServer(options = {}) {
  if (process.platform !== 'win32' && !options.forceWindows) {
    return { attempted: false, status: 'unsupported_platform' };
  }
  const exePath = options.exePath || DEFAULT_TAC_SERVER_EXE_PATH;
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(exePath)) {
    return { attempted: false, status: 'missing_executable' };
  }
  const port = Number.isSafeInteger(Number(options.port))
    ? Number(options.port)
    : DEFAULT_TAC_SERVER_PORT;
  const spawn = options.spawn || childProcess.spawn;
  const args = [
    '-backend',
    String(options.backend || 'qoder'),
    '-profile',
    String(options.profile || 'test'),
    '-port',
    String(port),
  ];
  const child = spawn(exePath, args, {
    cwd: options.cwd || require('node:path').dirname(exePath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (child && typeof child.unref === 'function') child.unref();
  return {
    attempted: true,
    status: 'started',
    pid: child && Number.isSafeInteger(child.pid) ? child.pid : 0,
    port,
  };
}

function sleepSync(ms) {
  const timeout = Number(ms);
  if (!Number.isFinite(timeout) || timeout <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
}

function ensureTianxiTacServer(options = {}) {
  const port = Number.isSafeInteger(Number(options.port))
    ? Number(options.port)
    : tacServerPortFromUrl(options.url);
  const isListening = options.isListening || ((value) => isTcpPortListening(value, options));
  if (isListening(port)) {
    return { attempted: false, status: 'already_listening', port };
  }
  const startResult = startTianxiTacServer({ ...options, port });
  if (startResult.attempted) {
    const deadline = Date.now() + (Number(options.waitMs) || 3000);
    while (Date.now() < deadline) {
      if (isListening(port)) break;
      sleepSync(100);
    }
  }
  return { ...startResult, port };
}

function createTacServerTransport({
  WebSocketImpl = globalThis.WebSocket,
  url = DEFAULT_TAC_SERVER_WS_URL,
  autoStart = true,
  ensureServer = ensureTianxiTacServer,
  discoverWsUrls = discoverTianxiTacServerWsUrls,
} = {}) {
  if (typeof WebSocketImpl !== 'function') {
    throw new TypeError('createTacServerTransport requires WebSocket');
  }
  function sendRawCommand(command, context = {}) {
    return new Promise((resolve, reject) => {
      let activeUrl = url;
      if (typeof discoverWsUrls === 'function') {
        try {
          const urls = discoverWsUrls({ url });
          if (Array.isArray(urls) && typeof urls[0] === 'string' && urls[0]) {
            activeUrl = urls[0];
          }
        } catch (_err) {}
      }
      if (autoStart && typeof ensureServer === 'function') {
        try {
          ensureServer({ url: activeUrl });
        } catch (_err) {}
      }
      const ws = new WebSocketImpl(activeUrl);
      const frames = [];
      let settled = false;
      let idleTimer = null;
      let visibleFrameSeen = false;
      const idleTimeoutMs = Number(context.idleTimeoutMs);
      const clearIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const cleanup = () => {
        clearIdleTimer();
        if (context.signal && typeof context.signal.removeEventListener === 'function') {
          context.signal.removeEventListener('abort', abort);
        }
        try {
          ws.close();
        } catch (_err) {}
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(new Error('tianxi_tac_server_aborted'));
      const scheduleIdleFinish = () => {
        clearIdleTimer();
        if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || frames.length === 0) {
          return;
        }
        idleTimer = setTimeout(
          () =>
            finish(
              context.requireTerminalStatus && !(context.allowPartialOnIdle && visibleFrameSeen)
                ? new Error('tianxi_tac_server_idle_timeout')
                : null,
              frames
            ),
          idleTimeoutMs
        );
      };
      if (context.signal && context.signal.aborted) {
        abort();
        return;
      }
      if (context.signal && typeof context.signal.addEventListener === 'function') {
        context.signal.addEventListener('abort', abort, { once: true });
      }
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(command));
      });
      ws.addEventListener('message', (event) => {
        const text = typeof event.data === 'string' ? event.data : '';
        if (!text) return;
        try {
          const parsed = JSON.parse(text);
          frames.push(parsed);
          if (hasVisibleTianxiNotifyFrame(parsed)) visibleFrameSeen = true;
          if (typeof context.onFrame === 'function') context.onFrame(parsed);
          const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
          const status = String(data.status || parsed.status || '').toUpperCase();
          const type = String(parsed.type || '').toLowerCase();
          const name = String(parsed.name || '').toLowerCase();
          if (
            hasTerminalTianxiNotifyFrame(parsed) ||
            ['COMPLETED', 'FAILED', 'CANCELED'].includes(status) ||
            (type === 'ack' && name === String(command && command.type).toLowerCase()) ||
            type === 'failed'
          ) {
            finish(null, frames);
          } else {
            scheduleIdleFinish();
          }
        } catch (_err) {}
      });
      ws.addEventListener('error', () => finish(new Error('tianxi_tac_server_ws_error')));
      ws.addEventListener('close', () => {
        if (settled) return;
        if (
          frames.length === 0 ||
          (context.requireTerminalStatus && !(context.allowPartialOnIdle && visibleFrameSeen))
        ) {
          finish(new Error('tianxi_tac_server_incomplete'));
        } else {
          finish(null, frames);
        }
      });
    });
  }
  return {
    sendQuery(frame, context = {}) {
      return sendRawCommand(frame, { ...context, requireTerminalStatus: true });
    },
    sendControlCommand(command, context = {}) {
      return sendRawCommand(command, context);
    },
  };
}

module.exports = {
  DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS,
  DEFAULT_AGENTCORE_LOG_PATH,
  DEFAULT_TAC_SERVER_EXE_PATH,
  DEFAULT_TAC_SERVER_PORT,
  DEFAULT_TAC_SERVER_WS_URL,
  DEFAULT_TIANXI_REGISTRY_ROOT,
  createTacServerTransport,
  decodeLogdatBuffer,
  discoverTianxiTacServerWsUrls,
  decodeJwtLikePayload,
  extractHeaderFromSendMessageLine,
  extractLatestAgentCoreHeader,
  getJwtExpiryMs,
  inspectTianxiCredentialExpiry,
  isPlaintextServiceAccountToken,
  ensureTianxiTacServer,
  isTcpPortListening,
  parseEpochMs,
  readLatestAgentCoreHeader,
  readTianxiRegistryCredentialCache,
  readTianxiRegistryCredentialCacheWithFallback,
  readWindowsRegistryValue,
  tianxiRegistryAccountKey,
};
