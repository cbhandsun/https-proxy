'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  DEFAULT_TAC_SERVER_WS_URL,
  inspectTianxiCredentialExpiry,
  readLatestAgentCoreHeader,
  readTianxiRegistryCredentialCacheWithFallback,
} = require('./tianxi-agentcore-local');

const DEFAULT_TIANXI_APP_BUNDLE = 'C:\\Program Files\\Lenovo\\AIAgent\\skin\\dist\\js\\app.js';
const DEFAULT_TIANXI_AGENTCORE_PLUGIN =
  'C:\\Program Files\\Lenovo\\AIAgent\\plugins\\XLAgentCorePlugin.dll';
const DEFAULT_TIANXI_XLAGENT_ROOT = 'C:\\ProgramData\\Lenovo\\AIAgent\\xlagent';
const AGENT_CORE_TOKENS = [
  'NEWPLUGIN_XLAGENTCOREPLUGIN_SENDMESSAGE',
  'NEWPLUGIN_XLAGENTCOREPLUGIN_NOTIFY_OPEN_WSS',
  'NEWPLUGIN_XLAGENTCOREPLUGIN_NOTIFY_ONMESSAGE',
  'NEWPLUGIN_XLAGENTCOREPLUGIN_NOTIFY_CLOSE_WSS',
  'agentCore',
  'auth_check',
  'task_output',
  'task_status',
  'act_exec',
  'act_resp',
  'risk_exec',
  'risk_resp',
  'permission_mode_change',
];

const QODER_NATIVE_TOKENS = [
  '/api/m/ai/token/out/v2/qoder',
  '/cloud-ai-supermode/api/client-config/query',
  'qoder_vpc_token',
  'qoder_vpc_expires_now',
  'qoder_vpc_expires_after',
  'NEWPLUGIN_WRAPPLUGIN_APP_RSASIGN',
  'sign_type',
  'RSA2',
];

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function extractTianxiUrls(source) {
  if (typeof source !== 'string' || !source) return [];
  const hits =
    source.match(
      /(?:https?|wss):\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/gi
    ) || [];
  return uniqueSorted(
    hits
      .map((value) => {
        try {
          const url = new URL(value);
          return `${url.protocol}//${url.host}`;
        } catch (_err) {
          return '';
        }
      })
      .filter((value) => /lenovo|lenovomm|tianxi|as-gateway|mbgtest/i.test(value))
  );
}

function summarizeTianxiBundle(source) {
  const text = typeof source === 'string' ? source : '';
  const foundTokens = AGENT_CORE_TOKENS.filter((token) => text.includes(token));
  const qoderNativeTokens = QODER_NATIVE_TOKENS.filter((token) => text.includes(token));
  const urls = extractTianxiUrls(text);
  return {
    hasBundle: text.length > 0,
    bundleBytes: Buffer.byteLength(text),
    foundTokens,
    qoderNativeTokens,
    agentCoreLikely:
      foundTokens.includes('agentCore') &&
      foundTokens.some((token) => token.startsWith('task_') || token.endsWith('_exec')),
    qoderRefreshLikely:
      qoderNativeTokens.includes('/api/m/ai/token/out/v2/qoder') &&
      qoderNativeTokens.includes('qoder_vpc_token'),
    nativeSignatureLikely:
      qoderNativeTokens.includes('NEWPLUGIN_WRAPPLUGIN_APP_RSASIGN') ||
      (qoderNativeTokens.includes('sign_type') && qoderNativeTokens.includes('RSA2')),
    urls,
    channelPcGatewayUrls: urls.filter((url) => /as-gateway-channel-pc/i.test(url)),
  };
}

function extractPrintableStrings(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) return '';
  const minLength = Number.isSafeInteger(options.minLength) ? options.minLength : 4;
  const values = [];
  const scan = (readChar, step) => {
    let current = '';
    for (let offset = 0; offset + step - 1 < buffer.length; offset += step) {
      const code = readChar(offset);
      if (code >= 32 && code <= 126) {
        current += String.fromCharCode(code);
      } else {
        if (current.length >= minLength) values.push(current);
        current = '';
      }
    }
    if (current.length >= minLength) values.push(current);
  };
  scan((offset) => buffer[offset], 1);
  scan((offset) => buffer.readUInt16LE(offset), 2);
  return values.join('\n');
}

function readTianxiBundleSummary(bundlePath = DEFAULT_TIANXI_APP_BUNDLE) {
  if (!fs.existsSync(bundlePath)) {
    return summarizeTianxiBundle('');
  }
  return summarizeTianxiBundle(fs.readFileSync(bundlePath, 'utf8'));
}

function readTianxiNativePluginSummary(pluginPath = DEFAULT_TIANXI_AGENTCORE_PLUGIN) {
  if (!fs.existsSync(pluginPath)) {
    return summarizeTianxiBundle('');
  }
  return summarizeTianxiBundle(extractPrintableStrings(fs.readFileSync(pluginPath)));
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function readTianxiProcessSummary() {
  const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 10000,
  });
  const wanted = new Set([
    'xlsmartui.exe',
    'xlaui.exe',
    'wspluginhost.exe',
    'xlmcpserverhost.exe',
    'xl_mcp_server.exe',
    'tac-server.exe',
  ]);
  return output
    .split(/\r?\n/)
    .map((line) => parseCsvLine(line.trim()))
    .filter((row) => row.length >= 2 && wanted.has(String(row[0]).toLowerCase()))
    .map((row) => ({
      pid: Number(row[1]),
      name: row[0],
      className: '',
      hasRemoteDebugging: false,
      isRenderer: false,
      isModelManager: false,
      isAgentCorePlugin: false,
      transport: '',
    }))
    .filter((row) => Number.isSafeInteger(row.pid));
}

function summarizeTianxiProcessCommand({ name, pid, commandLine } = {}) {
  const safePid = Number(pid);
  const command = typeof commandLine === 'string' ? commandLine : '';
  const classMatch = command.match(/--classname=([^\s"]+)/i);
  const hasPipe = /\b(pipe|ipc)\b/i.test(command);
  return {
    pid: Number.isSafeInteger(safePid) ? safePid : 0,
    name: typeof name === 'string' ? name : '',
    className: classMatch ? classMatch[1] : '',
    hasRemoteDebugging: /--remote-debugging-(?:port|address)=/i.test(command),
    isRenderer: /\b(type=renderer|--renderer-client-id=)/i.test(command),
    isModelManager: /(?:model\.manager|Model-7b|XLModel)/i.test(command),
    isAgentCorePlugin: /(?:XLAgentCore|agentcore|xlagent)/i.test(command),
    transport: hasPipe ? 'ipc-or-pipe' : '',
  };
}

function readTianxiProcessCommandSummary() {
  const script = [
    "$names = @('XLSmartUI.exe','XLAUI.exe','WSPluginHost.exe','XLMCPServerHost.exe','xl_mcp_server.exe','tac-server.exe');",
    'Get-CimInstance Win32_Process |',
    'Where-Object { $names -contains $_.Name } |',
    "Select-Object @{Name='name';Expression={$_.Name}},@{Name='pid';Expression={$_.ProcessId}},@{Name='commandLine';Expression={$_.CommandLine}} |",
    'ConvertTo-Json -Compress',
  ].join(' ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 10000,
  });
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) =>
    summarizeTianxiProcessCommand(row)
  );
}

function mergeTianxiProcessMetadata(processes, metadata) {
  const byPid = new Map((Array.isArray(metadata) ? metadata : []).map((item) => [item.pid, item]));
  return (Array.isArray(processes) ? processes : []).map((process) => ({
    ...process,
    ...(byPid.get(process.pid) || {}),
  }));
}

function parseNetstatListeners(output, pids) {
  const pidSet = new Set(pids);
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 5 && parts[0].toUpperCase() === 'TCP')
    .map((parts) => {
      const pid = Number(parts[parts.length - 1]);
      const state = parts[parts.length - 2];
      const local = parts[1] || '';
      const splitAt = local.lastIndexOf(':');
      return {
        pid,
        state,
        localAddress: splitAt > 0 ? local.slice(0, splitAt) : '',
        localPort: splitAt > 0 ? Number(local.slice(splitAt + 1)) : NaN,
      };
    })
    .filter(
      (row) =>
        row.state === 'LISTENING' && pidSet.has(row.pid) && Number.isSafeInteger(row.localPort)
    );
}

function readTianxiListenerSummary(processes) {
  const pids = Array.isArray(processes)
    ? processes.map((item) => Number(item.pid)).filter(Number.isSafeInteger)
    : [];
  if (pids.length === 0) return [];
  const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 10000,
  });
  const names = new Map(processes.map((item) => [Number(item.pid), item.name]));
  return parseNetstatListeners(output, pids).map((row) => ({
    pid: row.pid,
    name: names.get(Number(row.pid)) || '',
    localAddress: row.localAddress,
    localPort: row.localPort,
  }));
}

function buildTianxiProbeConclusion(processes, listeners) {
  const safeProcesses = Array.isArray(processes) ? processes : [];
  const safeListeners = Array.isArray(listeners) ? listeners : [];
  return {
    remoteDebuggingAvailable: safeProcesses.some((item) => item.hasRemoteDebugging),
    ordinaryTcpAgentCoreListener: safeListeners.some(
      (item) => item.localPort !== 49304 && /AgentCore|XLCORE/i.test(item.name)
    ),
    localModelManagerPort: safeListeners.find((item) => item.localPort === 49304) || null,
    tacServerPort: safeListeners.find((item) => item.name === 'tac-server.exe') || null,
  };
}

function summarizeAgentCoreHeader(header) {
  if (!header || typeof header !== 'object') {
    return {
      available: false,
      fields: [],
      credentialsType: '',
      credentialState: {
        qoderExpired: null,
        txExpired: null,
        refreshPossibleWithTx: false,
      },
      tacServerWsUrl: DEFAULT_TAC_SERVER_WS_URL,
    };
  }
  const credentialExpiry = inspectTianxiCredentialExpiry(header.credentials);
  const qoderExpired =
    credentialExpiry.qoder_token && typeof credentialExpiry.qoder_token.expired === 'boolean'
      ? credentialExpiry.qoder_token.expired
      : null;
  const txExpired =
    credentialExpiry.tx_token && typeof credentialExpiry.tx_token.expired === 'boolean'
      ? credentialExpiry.tx_token.expired
      : null;
  return {
    available: true,
    fields: Object.keys(header).sort(),
    credentialsType:
      header.credentials && typeof header.credentials === 'object'
        ? 'object'
        : typeof header.credentials,
    credentialExpiry,
    credentialState: {
      qoderExpired,
      txExpired,
      refreshPossibleWithTx: qoderExpired === true && txExpired === false,
    },
    tacServerWsUrl: DEFAULT_TAC_SERVER_WS_URL,
  };
}

function credentialStateFromExpiry(credentialExpiry) {
  const source = credentialExpiry && typeof credentialExpiry === 'object' ? credentialExpiry : {};
  const qoderExpired =
    source.qoder_token && typeof source.qoder_token.expired === 'boolean'
      ? source.qoder_token.expired
      : null;
  const txExpired =
    source.tx_token && typeof source.tx_token.expired === 'boolean'
      ? source.tx_token.expired
      : null;
  const loginExpired =
    source.tianxi_login_token && typeof source.tianxi_login_token.expired === 'boolean'
      ? source.tianxi_login_token.expired
      : null;
  return {
    qoderExpired,
    txExpired,
    loginExpired,
    refreshPossibleWithTx: qoderExpired === true && txExpired === false,
    refreshPossibleWithLogin: qoderExpired === true && loginExpired === false,
  };
}

function readAgentCoreHeaderSummary(options = {}) {
  try {
    return summarizeAgentCoreHeader(
      readLatestAgentCoreHeader({ logPath: options.agentCoreLogPath })
    );
  } catch (_err) {
    return summarizeAgentCoreHeader(null);
  }
}

function summarizeRegistryCredentialCache(cache) {
  const source = cache && typeof cache === 'object' ? cache : {};
  const credentialExpiry =
    source.credentialExpiry && typeof source.credentialExpiry === 'object'
      ? source.credentialExpiry
      : {};
  return {
    available: Boolean(source.available),
    source: source.source || 'tianxi-registry',
    keyScope: source.keyScope || '',
    hasQoderToken: Boolean(source.hasQoderToken),
    hasPlaintextQoderToken: Boolean(
      source.credentials &&
      typeof source.credentials === 'object' &&
      typeof source.credentials.qoder_token === 'string' &&
      source.credentials.qoder_token
    ),
    hasLoginToken: Boolean(source.hasLoginToken),
    credentialExpiry,
    credentialState: credentialStateFromExpiry(credentialExpiry),
  };
}

function readRegistryCredentialCacheSummary(options = {}) {
  try {
    const header = readLatestAgentCoreHeader({ logPath: options.agentCoreLogPath });
    return summarizeRegistryCredentialCache(
      readTianxiRegistryCredentialCacheWithFallback({
        userId: header && header.user_id,
      })
    );
  } catch (_err) {
    return summarizeRegistryCredentialCache(null);
  }
}

function parseLogTimestamp(line) {
  const match = String(line || '').match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
  return match ? match[1] : '';
}

function booleanField(line, name) {
  const match = String(line || '').match(new RegExp(`${name}=(true|false)`, 'i'));
  return match ? match[1].toLowerCase() === 'true' : null;
}

function integerField(line, name) {
  const match = String(line || '').match(new RegExp(`${name}=([0-9]+)`, 'i'));
  return match ? Number(match[1]) : null;
}

function classifyQoderRuntimeSummary(summary) {
  if (summary.initializeStatus === 'success' || summary.catalogReady === true) {
    return 'catalog_ready';
  }
  if (summary.serviceAccountExpired) return 'service_account_expired';
  if (summary.catalogNotReady) return 'catalog_not_ready';
  if (summary.controlResponseSuccess || summary.fetchServiceAccountToken) {
    return 'authenticated_without_catalog';
  }
  return 'unknown';
}

function parseQoderCliLogSummary(text) {
  const summary = {
    firstTimestamp: '',
    lastTimestamp: '',
    fetchServiceAccountToken: false,
    controlResponseSuccess: false,
    runtimeReadyStarted: false,
    runtimeReadyFinished: false,
    authenticated: null,
    runtimeReady: null,
    endpointReady: null,
    catalogReady: null,
    modelReconciled: null,
    catalogLoadedModelCount: null,
    catalogCacheState: '',
    initializeStatus: '',
    initializeDurationMs: null,
    initializeModelCount: null,
    serviceAccountExpired: false,
    catalogNotReady: false,
    classification: 'unknown',
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const timestamp = parseLogTimestamp(line);
    if (timestamp && !summary.firstTimestamp) summary.firstTimestamp = timestamp;
    if (timestamp) summary.lastTimestamp = timestamp;
    if (/subtype=fetch_service_account_token\b/i.test(line)) {
      summary.fetchServiceAccountToken = true;
    }
    if (/inbound control_response received\b.*\bstatus=success\b/i.test(line)) {
      summary.controlResponseSuccess = true;
    }
    if (/phase="qoder_runtime\.ready"/i.test(line)) {
      if (/session\.phase\.started/i.test(line)) summary.runtimeReadyStarted = true;
      if (/session\.phase\.finished/i.test(line)) {
        summary.runtimeReadyFinished = true;
        summary.authenticated = booleanField(line, 'authenticated');
        summary.runtimeReady = booleanField(line, 'runtime_ready');
        summary.endpointReady = booleanField(line, 'endpoint_ready');
        summary.catalogReady = booleanField(line, 'catalog_ready');
        summary.modelReconciled = booleanField(line, 'model_reconciled');
      }
    }
    const loaded = line.match(
      /\[catalog\]\s+Loaded\s+([0-9]+)\s+models\s+from\s+([a-z]+)\s+disk cache/i
    );
    if (loaded) {
      summary.catalogLoadedModelCount = Number(loaded[1]);
      summary.catalogCacheState = loaded[2].toLowerCase();
    }
    if (/Service Account token has expired|service_account_token_expired/i.test(line)) {
      summary.serviceAccountExpired = true;
    }
    if (/catalog not ready after authentication/i.test(line)) {
      summary.catalogNotReady = true;
    }
    if (/subtype=initialize\b/i.test(line)) {
      const status = String((line.match(/\bstatus=([a-z]+)/i) || [])[1] || '').toLowerCase();
      if (status) summary.initializeStatus = status;
      const durationMs = integerField(line, 'duration_ms');
      if (durationMs != null) summary.initializeDurationMs = durationMs;
      const modelCount = integerField(line, 'model_count');
      if (modelCount != null) summary.initializeModelCount = modelCount;
    }
  }
  summary.classification = classifyQoderRuntimeSummary(summary);
  return summary;
}

function readQoderCliLogSummary(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  return {
    fileName: require('node:path').basename(filePath),
    runDir: require('node:path').basename(require('node:path').dirname(filePath)),
    lastWriteTimeMs: stat.mtimeMs,
    bytes: stat.size,
    ...parseQoderCliLogSummary(text),
  };
}

function readLatestQoderRuntimeSummaries(options = {}) {
  const path = require('node:path');
  const root = options.xlagentRoot || DEFAULT_TIANXI_XLAGENT_ROOT;
  const runsRoot = path.join(root, 'logs', 'runs');
  const limit = Number.isSafeInteger(Number(options.limit)) ? Number(options.limit) : 8;
  if (!fs.existsSync(runsRoot)) return [];
  const candidates = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(runsRoot, entry.name, 'qodercli.log');
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch (_err) {}
  }
  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(0, limit))
    .map((item) => {
      try {
        return readQoderCliLogSummary(item.filePath);
      } catch (err) {
        return {
          fileName: path.basename(item.filePath),
          runDir: path.basename(path.dirname(item.filePath)),
          lastWriteTimeMs: item.mtimeMs,
          bytes: 0,
          classification: 'read_error',
          error: err && err.message ? err.message : 'read_error',
        };
      }
    });
}

function probeTianxiSuperMode(options = {}) {
  const bundle = readTianxiBundleSummary(options.bundlePath || DEFAULT_TIANXI_APP_BUNDLE);
  const nativePlugin = readTianxiNativePluginSummary(
    options.nativePluginPath || DEFAULT_TIANXI_AGENTCORE_PLUGIN
  );
  let processes = [];
  let listeners = [];
  let processProbeError = '';
  try {
    processes = readTianxiProcessSummary();
    try {
      processes = mergeTianxiProcessMetadata(processes, readTianxiProcessCommandSummary());
    } catch (_err) {
      processes = mergeTianxiProcessMetadata(processes, []);
    }
    listeners = readTianxiListenerSummary(processes);
  } catch (err) {
    processProbeError = err && err.message ? err.message : 'process probe failed';
  }
  return {
    bundle,
    nativePlugin,
    processes,
    listeners,
    agentCoreHeader: readAgentCoreHeaderSummary(options),
    registryCredentialCache: readRegistryCredentialCacheSummary(options),
    qoderRuntimeRuns: readLatestQoderRuntimeSummaries(options),
    processProbeError,
    conclusion: buildTianxiProbeConclusion(processes, listeners),
  };
}

module.exports = {
  AGENT_CORE_TOKENS,
  DEFAULT_TIANXI_AGENTCORE_PLUGIN,
  DEFAULT_TIANXI_APP_BUNDLE,
  DEFAULT_TIANXI_XLAGENT_ROOT,
  QODER_NATIVE_TOKENS,
  buildTianxiProbeConclusion,
  credentialStateFromExpiry,
  extractPrintableStrings,
  extractTianxiUrls,
  mergeTianxiProcessMetadata,
  parseQoderCliLogSummary,
  probeTianxiSuperMode,
  readAgentCoreHeaderSummary,
  readLatestQoderRuntimeSummaries,
  readTianxiNativePluginSummary,
  readQoderCliLogSummary,
  summarizeAgentCoreHeader,
  summarizeRegistryCredentialCache,
  summarizeTianxiProcessCommand,
  summarizeTianxiBundle,
};
