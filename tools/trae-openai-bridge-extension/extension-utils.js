/**
 * Trae OpenAI Bridge Extension - 工具层
 *
 * 拆分自 extension.js (536 行),只包含常量、HTTP 工具、命令发现等
 * 纯函数。VSCode 命令 / 网络 IO 在更上层的 extension-bridge.js 包装。
 *
 * 不依赖 vscode 模块,可在普通 Node 下做单元测试。
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.TRAE_OPENAI_BRIDGE_PORT || process.env.TRAE_BRIDGE_PORT || 17861);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const WAIT_COMMAND_CANDIDATES = [
  'wx.bridge.sendAndWaitResponse',
  'feishu.bridge.sendAndWaitResponse'
];
const STREAMING_COMMAND_CANDIDATES = [
  'im.bridge.sendPromptStreaming'
];
const RAW_STREAM_COMMAND = 'im.bridge.subscribeRawStream';
const DISCOVERY_PATTERNS = [
  /bridge\.(send|chat|prompt)/i,
  /bridge\.subscribeRawStream/i,
  /sendPrompt/i,
  /sendAndWait/i,
  /agent.*chat/i
];

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const BUSY_RETRY_ATTEMPTS = parsePositiveInt(process.env.TRAE_BRIDGE_BUSY_RETRY_ATTEMPTS, 30);
const BUSY_RETRY_DELAY_MS = parsePositiveInt(process.env.TRAE_BRIDGE_BUSY_RETRY_DELAY_MS, 1000);

function createLogger(getOutput) {
  return function log(message) {
    const out = typeof getOutput === 'function' ? getOutput() : getOutput;
    if (out && typeof out.appendLine === 'function') {
      out.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function sendSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isBusyTraeError(message) {
  return /not waiting input|busy|running/i.test(message || '');
}

function normalizeResult(result) {
  if (result == null) return { text: '' };
  if (typeof result === 'string') return { text: result };
  if (typeof result.text === 'string') return { ...result, text: result.text };
  if (result.response && typeof result.response.text === 'string') return { ...result, text: result.response.text };
  return { text: JSON.stringify(result), raw: result };
}

function pickTraeCommand(allCommands) {
  if (!Array.isArray(allCommands)) return null;
  for (const command of WAIT_COMMAND_CANDIDATES) {
    if (allCommands.includes(command)) return command;
  }
  return null;
}

function listTraeBridgeCommands(allCommands) {
  const commands = Array.isArray(allCommands) ? allCommands : [];
  const commandSet = new Set(commands);
  const discovered = commands
    .filter((command) => {
      return WAIT_COMMAND_CANDIDATES.includes(command)
        || STREAMING_COMMAND_CANDIDATES.includes(command)
        || DISCOVERY_PATTERNS.some((pattern) => pattern.test(command));
    })
    .sort();
  return {
    waitCommand: pickTraeCommand(commands),
    streamCommand: STREAMING_COMMAND_CANDIDATES.find((command) => commandSet.has(command)) || null,
    rawStreamCommand: commandSet.has(RAW_STREAM_COMMAND) ? RAW_STREAM_COMMAND : null,
    waitCommands: WAIT_COMMAND_CANDIDATES.map((command) => ({ command, available: commandSet.has(command) })),
    streamingCommands: STREAMING_COMMAND_CANDIDATES.map((command) => ({ command, available: commandSet.has(command) })),
    rawStreamingCommands: [{ command: RAW_STREAM_COMMAND, available: commandSet.has(RAW_STREAM_COMMAND) }],
    discoveredCommands: discovered.slice(0, 100),
    discoveredCommandCount: discovered.length
  };
}

module.exports = {
  HOST,
  PORT,
  MAX_BODY_BYTES,
  WAIT_COMMAND_CANDIDATES,
  STREAMING_COMMAND_CANDIDATES,
  RAW_STREAM_COMMAND,
  DISCOVERY_PATTERNS,
  BUSY_RETRY_ATTEMPTS,
  BUSY_RETRY_DELAY_MS,
  createLogger,
  sendJson,
  sendSseEvent,
  delay,
  readBody,
  isBusyTraeError,
  normalizeResult,
  pickTraeCommand,
  listTraeBridgeCommands,
};
