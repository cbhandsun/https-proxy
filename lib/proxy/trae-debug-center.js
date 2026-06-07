const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const debugSwitchState = {
  rawProgressMode: null,
  logProgressMode: null,
  liveLogProgress: null,
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
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function progressModeIncludes(modeText, value) {
  return String(modeText || '').split(/[,\s]+/).some((item) => item.toLowerCase() === value);
}

function normalizeProgressMode(value, fallback = '') {
  const mode = String(value == null ? fallback : value).trim().toLowerCase();
  if (!mode || mode === 'off' || mode === 'false') return '';
  if (mode === '1' || mode === 'true' || mode === 'comments') return 'comment';
  if (mode === 'comment' || mode === 'visible' || mode === 'content' || mode === 'text' || mode === '0') return mode;
  return fallback;
}

function currentTraeDebugSettings() {
  const rawProgressMode = debugSwitchState.rawProgressMode == null
    ? normalizeProgressMode(process.env.TRAE_BRIDGE_RAW_PROGRESS || '')
    : debugSwitchState.rawProgressMode;
  const logProgressMode = debugSwitchState.logProgressMode == null
    ? normalizeProgressMode(process.env.TRAE_BRIDGE_LOG_PROGRESS || '')
    : debugSwitchState.logProgressMode;
  const liveLogProgress = debugSwitchState.liveLogProgress == null
    ? process.env.TRAE_BRIDGE_LOG_PROGRESS !== '0'
    : Boolean(debugSwitchState.liveLogProgress);
  const apiVisibleProgressEnabled = progressModeIncludes(rawProgressMode, 'visible') ||
    progressModeIncludes(logProgressMode, 'visible');
  return {
    ok: true,
    source: debugSwitchState.rawProgressMode == null && debugSwitchState.logProgressMode == null && debugSwitchState.liveLogProgress == null
      ? 'environment'
      : 'runtime',
    rawProgressMode,
    logProgressMode,
    liveLogProgress,
    rawCommentsEnabled: /^(1|true|comment|comments)$/i.test(rawProgressMode),
    apiVisibleProgressEnabled,
    apiOutputWarning: apiVisibleProgressEnabled
      ? 'API visible progress is enabled. Safe Trae progress summaries are injected into assistant text.'
      : '',
  };
}

function updateTraeDebugSettings(input = {}) {
  const rawCommentsEnabled = input.rawCommentsEnabled === true;
  const apiVisibleProgressEnabled = input.apiVisibleProgressEnabled === true;
  const liveLogProgress = input.liveLogProgress !== false;

  debugSwitchState.liveLogProgress = liveLogProgress;
  debugSwitchState.rawProgressMode = apiVisibleProgressEnabled
    ? 'visible'
    : (rawCommentsEnabled ? 'comment' : '');
  debugSwitchState.logProgressMode = liveLogProgress
    ? (apiVisibleProgressEnabled ? 'visible' : '')
    : '0';

  return currentTraeDebugSettings();
}

function latestSessionLogRoots(logRoot, limit = 2) {
  if (!statExists(logRoot)) return [];
  try {
    return fs.readdirSync(logRoot, { withFileTypes: true })
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
    let entries = [];
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
  if (lower.includes('first token flushed thought')) return { source: 'trae-log', kind: 'model_first_token', label: 'model first token' };
  if (lower.includes('before prepare loop')) return { source: 'trae-log', kind: 'agent_prepare', label: 'agent prepare' };
  if (lower.includes('start_agent_gen_plan') && lower.includes('done')) return { source: 'trae-log', kind: 'agent_stream_done', label: 'agent stream done' };
  if (lower.includes('send chat') || lower.includes('send_to_agent')) return { source: 'trae-log', kind: 'send_to_agent', label: 'send to agent' };
  if (lower.includes('body_len=')) {
    const url = text.match(/url=([^\s]+)/i);
    const len = text.match(/body_len=(\d+)/i);
    return {
      source: 'trae-log',
      kind: 'native_request_shape',
      label: 'native request shape',
      urlPath: url ? safeUrlPath(url[1]) : undefined,
      bodyLen: len ? Number(len[1]) : undefined,
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
  const limit = Math.max(1, Math.min(Number(options.limit || 80), 300));
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
  const payload = rawEvent && rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {};
  const tool = payload.tool_call_info && typeof payload.tool_call_info === 'object' ? payload.tool_call_info : {};
  const result = tool.result && typeof tool.result === 'object' ? tool.result : {};
  const summary = {
    source: 'trae-raw',
    kind: rawEvent && rawEvent.event || payload.event || 'raw_event',
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
  ].filter(Boolean).join(' ');
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
    return { available: res.status === 0, command, output: truncate(res.stdout || res.stderr, 120) };
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
      ahaNetHook: 'python scripts\\trae-frida-native-probe.py --pid <aha_net_pid> --duration 45',
      previewHook: 'python scripts\\trae-frida-native-probe.py --pid <pid> --duration 20 --capture-preview',
      deepProbe: 'node scripts\\trae-deep-probe.js --launch-cmd',
    },
  };
}

function runNativeScan(timeoutMs = 25000) {
  const scriptPath = path.join(repoRoot(), 'scripts', 'trae-frida-scan.py');
  if (!statExists(scriptPath)) return { ok: false, error: 'trae-frida-scan.py not found', scriptPath };
  try {
    const res = cp.spawnSync('python', [scriptPath], {
      cwd: repoRoot(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 3 * 1024 * 1024,
    });
    const output = String((res.stdout || '') + (res.stderr ? `\n${res.stderr}` : ''));
    return {
      ok: res.status === 0,
      status: res.status,
      timedOut: Boolean(res.error && /timed out/i.test(res.error.message)),
      summary: summarizeNativeScanOutput(output),
      output: sanitizeNativeScanOutput(output),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sanitizeNativeScanOutput(output) {
  return String(output || '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'jwt-<redacted>')
    .replace(/(authorization|bearer|token|cookie)["'\s:=]+[^"',}\s]+/ig, '$1=<redacted>');
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
    if (block.includes('"module": "ai_agent.dll"') || block.includes('"name": "ai_agent.dll"')) modules.push('ai_agent.dll');
    if (block.includes('"module": "aha_net.dll"') || block.includes('"name": "aha_net.dll"')) modules.push('aha_net.dll');
    if (block.includes('"name": "sscronet.dll"')) modules.push('sscronet.dll');
    if (modules.length) pids.push({ pid, modules: Array.from(new Set(modules)) });
  }
  return {
    aiAgentPid: pids.find((item) => item.modules.includes('ai_agent.dll'))?.pid || null,
    ahaNetPid: pids.find((item) => item.modules.includes('aha_net.dll'))?.pid || null,
    candidates: pids,
  };
}

module.exports = {
  collectLogEvents,
  fetchBridgeRawEvents,
  currentTraeDebugSettings,
  updateTraeDebugSettings,
  nativeDebugStatus,
  runNativeScan,
};
