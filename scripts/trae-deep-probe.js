#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const WANT_JSON = process.argv.includes('--json');
const WANT_LAUNCH_CMD = process.argv.includes('--launch-cmd');
const HTTP_MAX_RESPONSE_BYTES = 1024 * 1024;

const NEEDLES = [
  'api/agent/v3/create_agent_task',
  'api/agent/v3/commit_toolcall_result',
  'api/agent/v3/resume_agent_task',
  'api/agent/v3/llm_utils_chattrae',
  'api/ide/v1/llm_raw_chat',
  'api/ide/v2/llm_raw_chat',
  'LLMClientRequestRaw',
  'LLMClientRequest',
  'LLMRawChatMessage',
  'LLMRawMessage',
  'request body',
  'response body',
  'request_stream',
  'request_stream_lite',
  'ChatPlanItemEventPayload',
  'ChatTimingEventsPayload',
];

const LOG_PATTERNS = [
  'create_agent_task',
  'commit_toolcall_result',
  'llm_raw_chat',
  'LLMClientRequestRaw',
  'LLMRawChatMessage',
  'request body',
  'response body',
  'body_len=',
  'request_stream',
  'ChatPlanItemEventPayload',
];

function envPath(name, suffix) {
  const base = process.env[name];
  return base ? path.join(base, suffix) : '';
}

function exists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

function statSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

function truncate(text, max = 240) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error && res.error.message,
  };
}

function commandExists(command) {
  const res = run('where.exe', [command], { maxBuffer: 256 * 1024 });
  return {
    command,
    available: res.ok,
    path: res.ok
      ? res.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)[0]
      : '',
  };
}

function latestSessionLogRoots(logRoot) {
  if (!exists(logRoot)) return [];
  return fs
    .readdirSync(logRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(logRoot, entry.name);
      const stat = fs.statSync(fullPath);
      return { path: fullPath, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 3);
}

function extractSnippet(text, needle, radius = 160) {
  const index = text.indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return truncate(text.slice(start, end));
}

function scanBinary(filePath) {
  if (!exists(filePath)) return { exists: false, hits: [] };
  const raw = fs.readFileSync(filePath, 'latin1');
  const hits = [];
  for (const needle of NEEDLES) {
    const snippet = extractSnippet(raw, needle);
    if (snippet) hits.push({ needle, snippet });
  }
  return { exists: true, hits };
}

function scanLogs(logRoot) {
  if (!exists(logRoot)) return { exists: false, hits: [] };
  const roots = latestSessionLogRoots(logRoot).map((item) => item.path);
  const ahaLog = path.join(logRoot, 'aha_log');
  if (exists(ahaLog)) roots.push(ahaLog);
  const pattern = LOG_PATTERNS.join('|');
  const hits = [];
  for (const root of roots) {
    const res = run(
      'rg',
      ['-n', '--glob', '*.log', '--glob', '*.alaudalog', '--max-count', '40', pattern, root],
      { maxBuffer: 2 * 1024 * 1024 }
    );
    const lines = (res.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, 80);
    for (const line of lines) {
      hits.push(truncate(line, 360));
    }
  }
  return { exists: true, roots, hits };
}

function getJson(url, timeoutMs = 4000, maxBytes = HTTP_MAX_RESPONSE_BYTES) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      resolve(payload);
    };
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          chunks.length = 0;
          finish({
            ok: false,
            statusCode: res.statusCode,
            error: `response too large; max ${maxBytes} bytes`,
          });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (finished) return;
        const body = Buffer.concat(chunks, bytes).toString('utf8');
        try {
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: JSON.parse(body),
          });
        } catch {
          finish({
            ok: false,
            statusCode: res.statusCode,
            error: 'non-json response',
            body: truncate(body),
          });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => finish({ ok: false, error: err.message }));
  });
}

function summarizeRawEvent(event) {
  const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
  const tool =
    payload.tool_call_info && typeof payload.tool_call_info === 'object'
      ? payload.tool_call_info
      : {};
  const result = tool.result && typeof tool.result === 'object' ? tool.result : {};
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  return {
    event: event && event.event,
    hasSessionId: Boolean(event && event.sessionId),
    hasAgentMessageId: Boolean(event && event.agentMessageId),
    hasTaskId: Boolean(payload.task_id),
    hasReasoningContent: Boolean(payload.reasoning_content),
    reasoningChars: payload.reasoning_content && payload.reasoning_content.chars,
    toolName: tool.name || '',
    hasToolParams: Boolean(tool.params),
    hasToolResult: Boolean(tool.result),
    hasStdout: typeof data.stdout === 'string',
    hasLlmToolcallId: Boolean(tool.meta && tool.meta.llm_toolcall_id),
    hasConfirmInfo: Boolean(payload.confirm_info),
  };
}

async function probeRawBridge() {
  const res = await getJson('http://127.0.0.1:17861/debug/raw-stream');
  if (!res.ok || !res.body) return res;
  const events = Array.isArray(res.body.events) ? res.body.events : [];
  const counts = {};
  for (const event of events)
    counts[event.event || 'unknown'] = (counts[event.event || 'unknown'] || 0) + 1;
  const samples = events
    .map(summarizeRawEvent)
    .filter((item) => item.event)
    .slice(0, 12);
  return {
    ok: true,
    command: res.body.command,
    eventCount: events.length,
    counts,
    capability: {
      hasPlanItems: events.some((event) => event.event === 'plan_item'),
      hasToolCalls: events.some((event) => event.payload && event.payload.tool_call_info),
      hasToolResults: events.some((event) => {
        const tool = event.payload && event.payload.tool_call_info;
        return tool && tool.result && Object.keys(tool.result).length > 0;
      }),
      hasReasoningOnlyAsRedactedShape: events.some((event) => {
        const rc = event.payload && event.payload.reasoning_content;
        return rc && rc.redacted === true;
      }),
      hasNativeLlmMessages: events.some(
        (event) =>
          event.payload && (event.payload.messages || event.payload.model || event.payload.tools)
      ),
    },
    samples,
  };
}

function buildLaunchCommand(traeExe) {
  const lines = [
    "$env:RUST_LOG = 'trace'",
    "$env:ICUBE_RUST_LOG_LEVEL = 'debug'",
    "$env:ICUBE_MODULE_LOG_TO_FILE = 'true'",
  ];
  if (traeExe) lines.push(`Start-Process -FilePath '${traeExe.replace(/'/g, "''")}'`);
  else lines.push('Start-Process -FilePath "$env:LOCALAPPDATA\\Programs\\Trae\\Trae.exe"');
  return lines.join(os.EOL);
}

async function main() {
  const traeRoot = envPath('LOCALAPPDATA', 'Programs\\Trae\\resources\\app');
  const paths = {
    workbenchBundle: path.join(traeRoot, 'out\\vs\\workbench\\workbench.desktop.main.js'),
    aiModulesChatBundle: path.join(
      traeRoot,
      'node_modules\\@byted-icube\\ai-modules-chat\\dist\\index.mjs'
    ),
    aiAgentDll: path.join(traeRoot, 'modules\\ai-agent\\ai_agent.dll'),
    logsRoot: envPath('APPDATA', 'Trae\\logs'),
    traeExe: envPath('LOCALAPPDATA', 'Programs\\Trae\\Trae.exe'),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    paths: Object.fromEntries(
      Object.entries(paths).map(([key, value]) => [key, { path: value, ...statSafe(value) }])
    ),
    tools: {
      frida: commandExists('frida.exe'),
      fridaTrace: commandExists('frida-trace.exe'),
      rg: commandExists('rg.exe'),
      python: commandExists('python.exe'),
      node: commandExists('node.exe'),
    },
    binary: {
      aiAgentDll: scanBinary(paths.aiAgentDll),
    },
    logs: scanLogs(paths.logsRoot),
    rawBridge: await probeRawBridge(),
    nextSteps: [
      'Current extension/raw-stream access reaches Trae agent/UI event payloads, including plan_item, tool_call_info, confirm_info, token_usage, and timing_events.',
      'Native ai_agent.dll contains LLMClientRequestRaw / LLMRawChatMessage / llm_raw_chat strings, so deeper model-protocol objects likely exist inside the native agent.',
      'Default logs currently show request URL/body_len and typed request summaries, not full model messages/body.',
      'Try launching Trae with RUST_LOG=trace and ICUBE_RUST_LOG_LEVEL=debug, then rerun this probe to see whether request body / response body lines appear.',
      'If full body still does not appear, the next real deep probe is an opt-in Frida/Detours hook around ai_agent.dll AhaNet HTTP send or Electron Fetch IPC payloads.',
    ],
    launchDebugCommand: buildLaunchCommand(paths.traeExe),
  };

  if (WANT_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Trae Deep Probe');
  console.log('===============');
  console.log(`Generated: ${report.generatedAt}`);
  console.log('');
  console.log('Paths:');
  for (const [key, item] of Object.entries(report.paths)) {
    console.log(`- ${key}: ${item.exists ? 'ok' : 'missing'} ${item.path}`);
  }
  console.log('');
  console.log('Hook/runtime tools:');
  for (const [key, item] of Object.entries(report.tools)) {
    console.log(`- ${key}: ${item.available ? item.path : 'missing'}`);
  }
  console.log('');
  console.log('Native protocol string hits:');
  for (const hit of report.binary.aiAgentDll.hits.slice(0, 18)) {
    console.log(`- ${hit.needle}`);
  }
  console.log('');
  console.log('Raw bridge capability:');
  if (report.rawBridge.ok) {
    console.log(`- command: ${report.rawBridge.command || 'unknown'}`);
    console.log(`- eventCount: ${report.rawBridge.eventCount}`);
    console.log(`- counts: ${JSON.stringify(report.rawBridge.counts)}`);
    console.log(`- capability: ${JSON.stringify(report.rawBridge.capability)}`);
  } else {
    console.log(
      `- unavailable: ${report.rawBridge.error || report.rawBridge.statusCode || 'unknown'}`
    );
  }
  console.log('');
  console.log('Latest log hits:');
  for (const line of report.logs.hits.slice(0, 12)) console.log(`- ${line}`);
  if (report.logs.hits.length > 12) console.log(`- ... ${report.logs.hits.length - 12} more`);
  console.log('');
  console.log('Next steps:');
  for (const item of report.nextSteps) console.log(`- ${item}`);
  if (WANT_LAUNCH_CMD) {
    console.log('');
    console.log('Debug launch command:');
    console.log(report.launchDebugCommand);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
