const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { parseBoundedInteger } = require('./management-utils');

const debugSwitchState = {
  rawProgressMode: null,
  logProgressMode: null,
  liveLogProgress: null,
};

const nativeDeepState = {
  child: null,
  startedAt: 0,
  endedAt: 0,
  pid: null,
  durationSeconds: 0,
  mode: '',
  status: 'idle',
  error: '',
  events: [],
  counts: {},
};

const NATIVE_DEEP_EVENT_LIMIT = 240;
const NATIVE_SCAN_TIMEOUT_MS = 30 * 1000;
const NATIVE_DEEP_STOP_GRACE_MS = 10 * 1000;
let nativeDeepSequence = 0;
let lastNativeScanSummary = null;
const nativeScanState = {
  running: false,
  startedAt: 0,
  endedAt: 0,
  result: null,
  error: '',
  child: null,
};

function defaultTraeLogRoot() {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'Trae', 'logs') : '';
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function statExists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

function truncate(text, max = 180) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function progressModeIncludes(modeText, value) {
  return String(modeText || '')
    .split(/[,\s]+/)
    .some((item) => item.toLowerCase() === value);
}

function normalizeProgressMode(value, fallback = '') {
  const text = String(value == null ? fallback : value)
    .trim()
    .toLowerCase();
  if (!text || text === 'off' || text === 'false') return '';
  if (text === '1' || text === 'true' || text === 'comments') return 'comment';
  const allowed = new Set([
    'comment',
    'comments',
    'visible',
    'content',
    'text',
    '0',
    'claude',
    'process',
    'thinking',
    'claude-thinking',
    'claude-process',
    'claude-text',
    'process-text',
    'text-process',
  ]);
  const tokens = text.split(/[,\s]+/).filter((item) => allowed.has(item));
  return tokens.length ? Array.from(new Set(tokens)).join(',') : fallback;
}

function claudeProcessStyleFromMode(modeText) {
  if (
    progressModeIncludes(modeText, 'claude-text') ||
    progressModeIncludes(modeText, 'process-text') ||
    progressModeIncludes(modeText, 'text-process')
  ) {
    return 'text';
  }
  if (
    progressModeIncludes(modeText, 'claude') ||
    progressModeIncludes(modeText, 'process') ||
    progressModeIncludes(modeText, 'thinking') ||
    progressModeIncludes(modeText, 'claude-thinking') ||
    progressModeIncludes(modeText, 'claude-process')
  ) {
    return 'thinking';
  }
  return '';
}

function currentTraeDebugSettings() {
  const rawProgressMode =
    debugSwitchState.rawProgressMode == null
      ? normalizeProgressMode(process.env.TRAE_BRIDGE_RAW_PROGRESS || '')
      : debugSwitchState.rawProgressMode;
  const logProgressMode =
    debugSwitchState.logProgressMode == null
      ? normalizeProgressMode(process.env.TRAE_BRIDGE_LOG_PROGRESS || '')
      : debugSwitchState.logProgressMode;
  const liveLogProgress =
    debugSwitchState.liveLogProgress == null
      ? process.env.TRAE_BRIDGE_LOG_PROGRESS !== '0'
      : Boolean(debugSwitchState.liveLogProgress);
  const apiVisibleProgressEnabled =
    progressModeIncludes(rawProgressMode, 'visible') ||
    progressModeIncludes(logProgressMode, 'visible');
  const claudeProcessStyle = claudeProcessStyleFromMode(rawProgressMode);
  const claudeProcessProgressEnabled = Boolean(claudeProcessStyle);
  return {
    ok: true,
    source:
      debugSwitchState.rawProgressMode == null &&
      debugSwitchState.logProgressMode == null &&
      debugSwitchState.liveLogProgress == null
        ? 'environment'
        : 'runtime',
    rawProgressMode,
    logProgressMode,
    liveLogProgress,
    rawCommentsEnabled:
      /^(1|true|comment|comments)$/i.test(rawProgressMode) ||
      progressModeIncludes(rawProgressMode, 'comment') ||
      progressModeIncludes(rawProgressMode, 'comments'),
    apiVisibleProgressEnabled,
    claudeProcessProgressEnabled,
    claudeProcessStyle,
    apiOutputWarning: apiVisibleProgressEnabled
      ? 'API visible progress is enabled. Safe Trae progress summaries are injected into assistant text.'
      : claudeProcessProgressEnabled
        ? `Claude process progress is enabled. Safe Trae progress summaries are emitted as Claude ${claudeProcessStyle} blocks.`
        : '',
  };
}

function updateTraeDebugSettings(input = {}) {
  const rawCommentsEnabled = input.rawCommentsEnabled === true;
  const apiVisibleProgressEnabled = input.apiVisibleProgressEnabled === true;
  const requestedClaudeStyle = String(input.claudeProcessStyle || '').toLowerCase();
  const claudeProcessStyle =
    requestedClaudeStyle === 'text' || input.claudeProcessTextFallbackEnabled === true
      ? 'text'
      : requestedClaudeStyle === 'thinking' || input.claudeProcessProgressEnabled === true
        ? 'thinking'
        : '';
  const liveLogProgress = input.liveLogProgress !== false;

  debugSwitchState.liveLogProgress = liveLogProgress;
  debugSwitchState.rawProgressMode = [
    rawCommentsEnabled ? 'comment' : '',
    claudeProcessStyle === 'text' ? 'claude-text' : '',
    claudeProcessStyle === 'thinking' ? 'claude-process' : '',
    apiVisibleProgressEnabled ? 'visible' : '',
  ]
    .filter(Boolean)
    .join(',');
  debugSwitchState.logProgressMode = liveLogProgress
    ? apiVisibleProgressEnabled
      ? 'visible'
      : ''
    : '0';

  return currentTraeDebugSettings();
}

function latestSessionLogRoots(logRoot, limit = 2) {
  if (!statExists(logRoot)) return [];
  try {
    return fs
      .readdirSync(logRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(logRoot, entry.name);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((item) => item.path);
  } catch {
    return [];
  }
}

function readTextTail(filePath, maxBytes = 256 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function walkLogFiles(root, limit = 24) {
  const out = [];
  function walk(dir) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(log|alaudalog)$/i.test(entry.name)) {
        out.push(fullPath);
        if (out.length >= limit) return;
      }
    }
  }
  walk(root);
  return out;
}

function parseTraeLogLine(line) {
  const text = String(line || '');
  const lower = text.toLowerCase();
  if (lower.includes('toolcall') || lower.includes('tool call') || lower.includes('tooling.')) {
    const command = text.match(/command[:=\s"]+([^",\]\s]+)/i);
    return { source: 'trae-log', kind: 'tool', label: command ? command[1] : 'tool activity' };
  }
  if (lower.includes('first token flushed thought'))
    return { source: 'trae-log', kind: 'model_first_token', label: 'model first token' };
  if (lower.includes('before prepare loop'))
    return { source: 'trae-log', kind: 'agent_prepare', label: 'agent prepare' };
  if (lower.includes('start_agent_gen_plan') && lower.includes('done'))
    return { source: 'trae-log', kind: 'agent_stream_done', label: 'agent stream done' };
  if (lower.includes('send chat') || lower.includes('send_to_agent'))
    return { source: 'trae-log', kind: 'send_to_agent', label: 'send to agent' };
  if (lower.includes('body_len=')) {
    const url = text.match(/url=([^\s]+)/i);
    const len = text.match(/body_len=(\d+)/i);
    return {
      source: 'trae-log',
      kind: 'native_request_shape',
      label: 'native request shape',
      urlPath: url ? safeUrlPath(url[1]) : undefined,
      bodyLen: len ? parseBoundedInteger(len[1], 0, 0, 1024 * 1024 * 1024) : undefined,
    };
  }
  return null;
}

function safeUrlPath(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    return `${url.host}${url.pathname}`;
  } catch {
    return truncate(String(rawUrl).split('?')[0], 120);
  }
}

function collectLogEvents(options = {}) {
  const logRoot = options.logRoot || defaultTraeLogRoot();
  const limit = parseBoundedInteger(options.limit, 80, 1, 300);
  const roots = latestSessionLogRoots(logRoot, 2);
  const ahaLog = path.join(logRoot, 'aha_log');
  if (statExists(ahaLog)) roots.push(ahaLog);
  const events = [];
  for (const root of roots) {
    for (const filePath of walkLogFiles(root, 30)) {
      const rel = path.relative(logRoot, filePath);
      const lines = readTextTail(filePath).split(/\r?\n/).slice(-1200);
      for (const line of lines) {
        const event = parseTraeLogLine(line);
        if (!event) continue;
        events.push({
          ...event,
          file: rel,
          message: event.urlPath ? `${event.label}: ${event.urlPath}` : event.label,
        });
      }
    }
  }
  return events.slice(-limit);
}

function summarizeRawEvent(rawEvent) {
  const payload =
    rawEvent && rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {};
  const tool =
    payload.tool_call_info && typeof payload.tool_call_info === 'object'
      ? payload.tool_call_info
      : {};
  const result = tool.result && typeof tool.result === 'object' ? tool.result : {};
  const summary = {
    source: 'trae-raw',
    kind: (rawEvent && rawEvent.event) || payload.event || 'raw_event',
    event: rawEvent && rawEvent.event,
    sessionId: rawEvent && rawEvent.sessionId,
    agentMessageId: rawEvent && rawEvent.agentMessageId,
    taskId: payload.task_id,
    toolName: tool.name,
    toolStatus: result.status,
  };
  summary.message = [
    summary.kind,
    summary.toolName ? `tool=${summary.toolName}` : '',
    summary.toolStatus ? `status=${summary.toolStatus}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  Object.keys(summary).forEach((key) => {
    if (summary[key] == null || summary[key] === '') delete summary[key];
  });
  return summary;
}

async function fetchBridgeRawEvents(makeRequest, getBridgeUrl, limit = 80) {
  const bridgeUrl = getBridgeUrl('/debug/raw-stream');
  try {
    const res = await makeRequest(bridgeUrl, { method: 'GET', timeout: 2500 }, null);
    let parsed = {};
    try {
      parsed = JSON.parse(res.body || '{}');
    } catch {
      return { ok: false, bridgeUrl, error: 'Trae raw stream returned non-JSON response' };
    }
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      bridgeUrl,
      command: parsed.command,
      events: events.slice(-limit).map(summarizeRawEvent),
      rawEventCount: events.length,
    };
  } catch (err) {
    return { ok: false, bridgeUrl, error: err.message };
  }
}

function commandExists(command, args = ['--version']) {
  try {
    const res = cp.spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 256 * 1024,
    });
    return {
      available: res.status === 0,
      command,
      output: truncate(res.stdout || res.stderr, 120),
    };
  } catch (err) {
    return { available: false, command, error: err.message };
  }
}

function nativeDebugStatus() {
  const root = repoRoot();
  const scanScript = path.join(root, 'scripts', 'trae-frida-scan.py');
  const nativeProbeScript = path.join(root, 'scripts', 'trae-frida-native-probe.py');
  const deepProbeScript = path.join(root, 'scripts', 'trae-deep-probe.js');
  return {
    ok: true,
    scripts: {
      scan: { path: scanScript, exists: statExists(scanScript) },
      nativeProbe: { path: nativeProbeScript, exists: statExists(nativeProbeScript) },
      deepProbe: { path: deepProbeScript, exists: statExists(deepProbeScript) },
    },
    tools: {
      python: commandExists('python', ['-c', 'import sys; print(sys.version.split()[0])']),
      node: commandExists('node', ['--version']),
      frida: commandExists('python', ['-c', 'import frida; print(frida.__version__)']),
    },
    commands: {
      installFrida: 'python -m pip install --user frida-tools',
      scan: 'python scripts\\trae-frida-scan.py',
      aiAgentHook: 'python scripts\\trae-frida-native-probe.py --pid <ai_agent_pid> --duration 45',
      ahaNetHook:
        'python scripts\\trae-frida-native-probe.py --pid <aha_net_pid> --duration 45 --capture-matched-preview',
      matchedPreviewHook:
        'python scripts\\trae-frida-native-probe.py --pid <pid> --duration 20 --capture-matched-preview',
      previewHook:
        'python scripts\\trae-frida-native-probe.py --pid <pid> --duration 20 --capture-preview',
      deepProbe: 'node scripts\\trae-deep-probe.js --launch-cmd',
    },
    lastScan: lastNativeScanSummary,
    scan: getNativeScanStatus(),
    deep: getNativeDeepEvents({ limit: 1, includeEvents: false }),
  };
}

function getNativeScanStatus() {
  return {
    running: nativeScanState.running,
    startedAt: nativeScanState.startedAt || null,
    endedAt: nativeScanState.endedAt || null,
    elapsedMs: nativeScanState.startedAt
      ? (nativeScanState.endedAt || Date.now()) - nativeScanState.startedAt
      : 0,
    result: nativeScanState.result,
    error: nativeScanState.error || undefined,
  };
}

function resetNativeDebugState() {
  nativeDeepState.child = null;
  nativeDeepState.startedAt = 0;
  nativeDeepState.endedAt = 0;
  nativeDeepState.pid = null;
  nativeDeepState.durationSeconds = 0;
  nativeDeepState.mode = '';
  nativeDeepState.status = 'idle';
  nativeDeepState.error = '';
  nativeDeepState.events = [];
  nativeDeepState.counts = {};
  nativeDeepSequence = 0;
  nativeScanState.running = false;
  nativeScanState.startedAt = 0;
  nativeScanState.endedAt = 0;
  nativeScanState.result = null;
  nativeScanState.error = '';
  nativeScanState.child = null;
  lastNativeScanSummary = null;
}

function runNativeScan() {
  if (nativeScanState.running) {
    return {
      ok: true,
      running: true,
      status: 'running',
      summary: lastNativeScanSummary,
      scan: getNativeScanStatus(),
    };
  }
  if (nativeScanState.result) {
    return { ...nativeScanState.result, cached: true, running: false, scan: getNativeScanStatus() };
  }
  return startNativeScanJob();
}

function startNativeScanJob() {
  const scriptPath = path.join(repoRoot(), 'scripts', 'trae-frida-scan.py');
  if (!statExists(scriptPath))
    return { ok: false, error: 'trae-frida-scan.py not found', scriptPath };
  nativeScanState.running = true;
  nativeScanState.startedAt = Date.now();
  nativeScanState.endedAt = 0;
  nativeScanState.error = '';
  nativeScanState.result = nativeScanState.result || null;
  let output = '';
  const child = cp.spawn('python', [scriptPath], {
    cwd: repoRoot(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nativeScanState.child = child;
  let settled = false;
  let timeoutId = null;
  const appendOutput = (chunk) => {
    output += String(chunk || '');
    if (output.length > 3 * 1024 * 1024) output = output.slice(-3 * 1024 * 1024);
  };
  const finishScan = ({ ok, code, signal, error, timedOut }) => {
    if (settled) return;
    settled = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    nativeScanState.running = false;
    nativeScanState.endedAt = Date.now();
    nativeScanState.child = null;
    const summary = summarizeNativeScanOutput(output);
    if (
      summary &&
      (summary.ahaNetPid || summary.aiAgentPid || (summary.candidates && summary.candidates.length))
    ) {
      lastNativeScanSummary = summary;
    }
    nativeScanState.result = {
      ok: Boolean(ok),
      status: code,
      signal: signal || undefined,
      timedOut: Boolean(timedOut),
      summary,
      output: sanitizeNativeScanOutput(output),
    };
    nativeScanState.error = ok ? '' : error || `native scan exited with ${signal || code}`;
    if (nativeScanState.error) nativeScanState.result.error = nativeScanState.error;
  };
  timeoutId = setTimeout(() => {
    appendOutput(
      `\nNative scan timed out after ${Math.round(NATIVE_SCAN_TIMEOUT_MS / 1000)} seconds.\n`
    );
    try {
      if (child && typeof child.kill === 'function') child.kill();
    } catch (errKill) {}
    finishScan({
      ok: false,
      code: 124,
      error: `native scan timed out after ${Math.round(NATIVE_SCAN_TIMEOUT_MS / 1000)} seconds`,
      timedOut: true,
    });
  }, NATIVE_SCAN_TIMEOUT_MS);
  if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  child.on('error', (err) => {
    appendOutput(`\n${err.message}\n`);
    finishScan({ ok: false, code: null, error: err.message });
  });
  child.on('exit', (code, signal) => {
    finishScan({
      ok: code === 0,
      code,
      signal,
      error: code === 0 ? '' : `native scan exited with ${signal || code}`,
    });
  });
  return {
    ok: true,
    running: true,
    status: 'running',
    summary: lastNativeScanSummary,
    output: 'Native scan started in background. Refresh after a few seconds.',
    scan: getNativeScanStatus(),
  };
}

function sanitizeNativeScanOutput(output) {
  return String(output || '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'jwt-<redacted>')
    .replace(/(authorization|bearer|token|cookie)["'\s:=]+[^"',}\s]+/gi, '$1=<redacted>');
}

function summarizeNativeScanOutput(output) {
  const text = String(output || '');
  const pids = [];
  const attachBlocks = text.split(/--- attach /).slice(1);
  for (const block of attachBlocks) {
    const first = block.split(/\r?\n/, 1)[0] || '';
    const pidMatch = first.match(/^(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    if (!pid) continue;
    const modules = [];
    if (block.includes('"module": "ai_agent.dll"') || block.includes('"name": "ai_agent.dll"'))
      modules.push('ai_agent.dll');
    if (block.includes('"module": "aha_net.dll"') || block.includes('"name": "aha_net.dll"'))
      modules.push('aha_net.dll');
    if (block.includes('"name": "sscronet.dll"')) modules.push('sscronet.dll');
    if (modules.length) pids.push({ pid, modules: Array.from(new Set(modules)) });
  }
  return {
    aiAgentPid: pids.find((item) => item.modules.includes('ai_agent.dll'))?.pid || null,
    ahaNetPid: pids.find((item) => item.modules.includes('aha_net.dll'))?.pid || null,
    candidates: pids,
  };
}

function pushNativeDeepEvent(event) {
  const safe = sanitizeNativeDeepEvent(event);
  if (!safe) return;
  nativeDeepState.events.push({ ...safe, seq: ++nativeDeepSequence });
  while (nativeDeepState.events.length > NATIVE_DEEP_EVENT_LIMIT) nativeDeepState.events.shift();
  const key = safe.kind || safe.event || 'event';
  nativeDeepState.counts[key] = (nativeDeepState.counts[key] || 0) + 1;
}

function sanitizeNativeDeepEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.ok === true && Array.isArray(event.processes)) {
    return {
      source: 'trae-native',
      kind: 'probe_start',
      message: `native probe started: ${event.mode || 'redacted'}`,
      mode: event.mode,
      durationSeconds: event.durationSeconds,
      processes: event.processes.map((item) => ({ pid: item.pid, name: item.name })),
      at: Date.now(),
    };
  }
  const name = String(event.event || '');
  if (name === 'hooked' || name === 'hooked_callback' || name === 'hook_callback_error') {
    return {
      source: 'trae-native',
      kind: name,
      message: name === 'hooked' ? `hooked ${event.module || ''}!${event.export || ''}` : name,
      module: event.module,
      export: event.export,
      callback: event.callback,
      error: event.error && truncate(event.error, 160),
      at: event.at || Date.now(),
    };
  }
  if (
    name === 'native_probe_line' ||
    name === 'native_probe_stderr' ||
    name === 'native_probe_timeout'
  ) {
    return {
      source: 'trae-native',
      kind: name,
      message: truncate(event.message || event.error || name, 180),
      error: event.error && truncate(event.error, 180),
      at: event.at || Date.now(),
    };
  }
  if (
    name !== 'Cronet_UrlRequestCallback_OnReadCompleted' &&
    name !== 'Cronet_UrlRequestCallback_OnResponseStarted' &&
    name !== 'Cronet_UrlRequestCallback_OnSucceeded' &&
    name !== 'Cronet_UrlRequest_InitWithParams'
  ) {
    return null;
  }
  const meta = event.meta && typeof event.meta === 'object' ? event.meta : {};
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const urlPath = meta.url ? safeUrlPath(meta.url) : undefined;
  const isAgent = /\/api\/agent\//.test(urlPath || '');
  const sseSummary = summarizeNativeSse(data.sse);
  const isAgentProtocol = Boolean(
    isAgent ||
    sseSummary.contains.task ||
    sseSummary.contains.reasoning ||
    sseSummary.contains.token ||
    sseSummary.contains.plan ||
    sseSummary.eventNames.some((item) =>
      /^(task_created|model_config|agent_status|history|progress_notice|metadata|timing_cost|thought|token_usage|required_context|turn_completion)$/.test(
        item
      )
    )
  );
  const hasSignal = Boolean(
    data.hasProtocolNeedle ||
    data.startsLikeJson ||
    data.preview ||
    data.hasSse ||
    isAgent ||
    meta.hasProtocolNeedle ||
    isAgentProtocol
  );
  if (!hasSignal) return null;
  const displayUrlPath = !isAgent && isAgentProtocol ? 'trae-agent-sse' : urlPath;
  const keys = sseSummary.keys.length ? sseSummary.keys : extractPreviewKeys(data.preview);
  const kind =
    name === 'Cronet_UrlRequestCallback_OnReadCompleted'
      ? 'native_response_chunk'
      : name === 'Cronet_UrlRequest_InitWithParams'
        ? 'native_request_init'
        : name === 'Cronet_UrlRequestCallback_OnResponseStarted'
          ? 'native_response_started'
          : 'native_request_done';
  const contains = mergeSignalSummaries(summarizeNativePreview(data.preview), sseSummary.contains);
  const message = [
    kind,
    displayUrlPath ? `url=${displayUrlPath}` : '',
    event.bytesRead == null ? '' : `bytes=${event.bytesRead}`,
    sseSummary.eventNames.length ? `sse=${sseSummary.eventNames.join(',')}` : '',
    contains.reasoning ? 'reasoning' : '',
    contains.token ? 'token' : '',
    contains.task ? 'task' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    source: 'trae-native',
    kind,
    event: name,
    message,
    urlPath: displayUrlPath,
    observedUrlPath: displayUrlPath !== urlPath ? urlPath : undefined,
    urlPathUncertain: Boolean(displayUrlPath !== urlPath),
    method: meta.method,
    bytesRead: event.bytesRead,
    startsLikeJson: Boolean(data.startsLikeJson),
    hasProtocolNeedle: Boolean(data.hasProtocolNeedle || meta.hasProtocolNeedle),
    printableRatio: data.printableRatio,
    hasSse: Boolean(data.hasSse),
    sseEventNames: sseSummary.eventNames,
    sseDataShapes: sseSummary.dataShapes,
    sseSemantics: sseSummary.semantics,
    keys,
    contains,
    at: event.at || Date.now(),
  };
}

function extractPreviewKeys(preview) {
  const text = String(preview || '');
  if (!text) return [];
  const keys = [];
  const seen = new Set();
  const re = /"([A-Za-z0-9_-]{2,80})"\s*:/g;
  let match;
  while ((match = re.exec(text)) && keys.length < 24) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    keys.push(match[1]);
  }
  return keys;
}

function summarizeNativePreview(preview) {
  const text = String(preview || '').toLowerCase();
  return {
    sse: /(^|\s)(data|event):/.test(text),
    reasoning: /reasoning_content|thought/.test(text),
    token: /token_usage|prompt_tokens|completion_tokens|total_tokens/.test(text),
    task: /task_id|agent_run_id|session_id|conversation_id/.test(text),
    model: /model_name|config_name|"model"/.test(text),
    tool: /tool|function_call|native_function_call/.test(text),
  };
}

function mergeSignalSummaries(primary = {}, secondary = {}) {
  const out = { ...primary };
  for (const [key, value] of Object.entries(secondary || {})) {
    out[key] = Boolean(out[key] || value);
  }
  return out;
}

function summarizeNativeSse(sse) {
  const events = sse && Array.isArray(sse.events) ? sse.events : [];
  const eventNames = [];
  const keys = [];
  const seenEvents = new Set();
  const seenKeys = new Set();
  const contains = {};
  const dataShapes = [];
  const semantics = [];
  for (const item of events.slice(0, 10)) {
    if (item.event && !seenEvents.has(item.event)) {
      seenEvents.add(item.event);
      eventNames.push(item.event);
    }
    Object.assign(contains, mergeSignalSummaries(contains, item.signals || {}));
    const shape = item.dataShape && typeof item.dataShape === 'object' ? item.dataShape : null;
    const shapeKeys = shape && Array.isArray(shape.keys) ? shape.keys : [];
    if (shape) {
      dataShapes.push({
        event: item.event,
        type: shape.type,
        keys: shapeKeys.slice(0, 16),
        fieldTypes: shape.fieldTypes || undefined,
      });
    }
    if (item.semantic && typeof item.semantic === 'object') {
      semantics.push({ event: item.event, ...item.semantic });
    }
    for (const key of shapeKeys) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      keys.push(key);
      if (keys.length >= 36) break;
    }
  }
  if (sse && sse.signals) Object.assign(contains, mergeSignalSummaries(contains, sse.signals));
  return { eventNames, keys, contains, dataShapes, semantics };
}

function formatNativeDeepVisibleText(event) {
  if (!event || event.source !== 'trae-native') return '';
  if (!/^native_/.test(event.kind || '')) return '';
  const signals =
    event.contains && typeof event.contains === 'object'
      ? Object.keys(event.contains).filter((key) => event.contains[key])
      : [];
  const isAgentUrl = /\/api\/agent\//.test(event.urlPath || '');
  const hasUsefulSignal = signals.some((key) =>
    ['reasoning', 'token', 'task', 'model', 'tool'].includes(key)
  );
  if (!isAgentUrl && !hasUsefulSignal) return '';
  const signalText = signals.length ? ` signals=${signals.slice(0, 4).join(',')}` : '';
  const keys =
    Array.isArray(event.keys) && event.keys.length
      ? ` keys=${event.keys.slice(0, 6).join(',')}`
      : '';
  const url = event.urlPath ? ` url=${event.urlPath}` : '';
  const bytes = event.bytesRead == null ? '' : ` bytes=${event.bytesRead}`;
  return `[Trae ${event.kind}${url}${bytes}${signalText}${keys}]`;
}

function startNativeDeepProgress(writeVisibleText, options = {}) {
  if (typeof writeVisibleText !== 'function') return () => {};
  let lastSeq = nativeDeepState.events.reduce(
    (max, event) => Math.max(max, Number(event.seq || 0)),
    0
  );
  const emitted = new Set();
  const intervalMs = parseBoundedInteger(options.intervalMs, 500, 250, 3000);
  const poll = () => {
    const snapshot = getNativeDeepEvents({ limit: NATIVE_DEEP_EVENT_LIMIT });
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    for (const event of events) {
      const seq = Number(event.seq || 0);
      if (!seq || seq <= lastSeq) continue;
      lastSeq = seq;
      const text = formatNativeDeepVisibleText(event);
      if (!text || emitted.has(text)) continue;
      emitted.add(text);
      if (emitted.size > 40) emitted.clear();
      writeVisibleText(text);
    }
    if (!snapshot.running && snapshot.status !== 'running') {
      stop();
    }
  };
  const timer = setInterval(poll, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }
  poll();
  return stop;
}

function findAhaNetPidFromScanSummary(summary) {
  if (summary && summary.ahaNetPid) return Number(summary.ahaNetPid);
  const candidate =
    summary && Array.isArray(summary.candidates)
      ? summary.candidates.find(
          (item) => Array.isArray(item.modules) && item.modules.includes('aha_net.dll')
        )
      : null;
  return candidate ? Number(candidate.pid) : 0;
}

function startNativeDeepProbe(input = {}) {
  if (nativeDeepState.child && nativeDeepState.status === 'running') {
    return getNativeDeepEvents({
      includeEvents: false,
      message: 'Native deep probe is already running.',
    });
  }
  const scriptPath = path.join(repoRoot(), 'scripts', 'trae-frida-native-probe.py');
  if (!statExists(scriptPath))
    return { ok: false, error: 'trae-frida-native-probe.py not found', scriptPath };
  const duration = parseBoundedInteger(input.durationSeconds, 45, 5, 120);
  const pid =
    parseBoundedInteger(input.pid, 0, 0, 2147483647) ||
    findAhaNetPidFromScanSummary(lastNativeScanSummary) ||
    parseBoundedInteger(nativeDeepState.pid, 0, 0, 2147483647);
  if (!pid) {
    return {
      ok: false,
      error: '未找到可用的 Trae aha_net PID。请确认 Trae 正在运行，或稍后重试一键启用。',
      lastScan: lastNativeScanSummary,
    };
  }
  nativeDeepState.startedAt = Date.now();
  nativeDeepState.endedAt = 0;
  nativeDeepState.pid = pid;
  nativeDeepState.durationSeconds = duration;
  nativeDeepState.mode = input.capturePreview ? 'preview' : 'matched-preview';
  nativeDeepState.status = 'running';
  nativeDeepState.error = '';
  nativeDeepState.events = [];
  nativeDeepState.counts = {};

  const args = [
    scriptPath,
    '--pid',
    String(pid),
    '--duration',
    String(duration),
    input.capturePreview ? '--capture-preview' : '--capture-matched-preview',
    '--max-preview',
    String(parseBoundedInteger(input.maxPreview, 360, 80, 1200)),
  ];
  const child = cp.spawn('python', args, {
    cwd: repoRoot(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nativeDeepState.child = child;
  let stdoutBuffer = '';
  let settled = false;
  let timeoutId = null;
  const handleText = (text) => {
    stdoutBuffer += String(text || '');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        pushNativeDeepEvent(JSON.parse(line));
      } catch (err) {
        pushNativeDeepEvent({ event: 'native_probe_line', error: truncate(line, 180) });
      }
    }
  };
  const flushStdoutBuffer = () => {
    if (!stdoutBuffer.trim()) return;
    try {
      pushNativeDeepEvent(JSON.parse(stdoutBuffer));
    } catch (err) {}
    stdoutBuffer = '';
  };
  const finishDeep = ({ status, error }) => {
    if (settled) return;
    settled = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    flushStdoutBuffer();
    nativeDeepState.status = status;
    nativeDeepState.error = error || '';
    nativeDeepState.endedAt = Date.now();
    nativeDeepState.child = null;
  };
  const timeoutMs = (duration + NATIVE_DEEP_STOP_GRACE_MS / 1000) * 1000;
  timeoutId = setTimeout(() => {
    try {
      if (child && typeof child.kill === 'function') child.kill();
    } catch (errKill) {}
    const error = `native probe timed out after ${Math.round(timeoutMs / 1000)} seconds`;
    pushNativeDeepEvent({ event: 'native_probe_timeout', error });
    finishDeep({ status: 'error', error });
  }, timeoutMs);
  if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
  child.stdout.on('data', handleText);
  child.stderr.on('data', (chunk) => {
    const text = truncate(String(chunk || ''), 500);
    if (text) {
      nativeDeepState.error = text;
      pushNativeDeepEvent({ event: 'native_probe_stderr', error: text });
    }
  });
  child.on('error', (err) => {
    finishDeep({ status: 'error', error: err.message });
  });
  child.on('exit', (code, signal) => {
    if (nativeDeepState.status === 'stopping') {
      finishDeep({ status: 'stopped', error: '' });
    } else {
      finishDeep({
        status: code === 0 ? 'completed' : 'error',
        error: code === 0 ? '' : `native probe exited with ${signal || code}`,
      });
    }
  });
  return getNativeDeepEvents({ includeEvents: false, scan: lastNativeScanSummary });
}

function stopNativeDeepProbe() {
  if (nativeDeepState.child && nativeDeepState.status === 'running') {
    try {
      nativeDeepState.child.kill();
    } catch (err) {}
    nativeDeepState.status = 'stopping';
  }
  return getNativeDeepEvents({ includeEvents: false });
}

function getNativeDeepEvents(options = {}) {
  const limit = parseBoundedInteger(options.limit, 80, 0, NATIVE_DEEP_EVENT_LIMIT);
  const running = Boolean(nativeDeepState.child && nativeDeepState.status === 'running');
  const elapsedMs = nativeDeepState.startedAt
    ? (nativeDeepState.endedAt || Date.now()) - nativeDeepState.startedAt
    : 0;
  const payload = {
    ok: true,
    status: nativeDeepState.status,
    running,
    pid: nativeDeepState.pid,
    mode: nativeDeepState.mode,
    durationSeconds: nativeDeepState.durationSeconds,
    elapsedMs,
    startedAt: nativeDeepState.startedAt || null,
    endedAt: nativeDeepState.endedAt || null,
    error: nativeDeepState.error || undefined,
    counts: nativeDeepState.counts,
    eventCount: nativeDeepState.events.length,
    warning:
      'Native deep mode attaches to Trae with Frida and may observe sensitive response fragments. Events are summarized and redacted; use only for short local diagnostics.',
  };
  if (options.message) payload.message = options.message;
  if (options.scan) payload.scan = options.scan;
  if (options.includeEvents !== false) payload.events = nativeDeepState.events.slice(-limit);
  return payload;
}

module.exports = {
  collectLogEvents,
  fetchBridgeRawEvents,
  currentTraeDebugSettings,
  updateTraeDebugSettings,
  nativeDebugStatus,
  runNativeScan,
  startNativeDeepProbe,
  stopNativeDeepProbe,
  getNativeDeepEvents,
  startNativeDeepProgress,
  formatNativeDeepVisibleText,
  _test: {
    resetNativeDebugState,
    nativeScanState,
    nativeDeepState,
    sanitizeNativeDeepEvent,
  },
};
