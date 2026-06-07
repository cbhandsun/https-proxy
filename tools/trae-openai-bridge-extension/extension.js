const http = require('http');
const vscode = require('vscode');

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

let server = null;
let output = null;

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const BUSY_RETRY_ATTEMPTS = parsePositiveInt(process.env.TRAE_BRIDGE_BUSY_RETRY_ATTEMPTS, 30);
const BUSY_RETRY_DELAY_MS = parsePositiveInt(process.env.TRAE_BRIDGE_BUSY_RETRY_DELAY_MS, 1000);

function log(message) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${message}`);
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

const SENSITIVE_RAW_KEY_PATTERN = /authorization|bearer|token|api[_-]?key|secret|password|credential|access[_-]?key|refresh|session[_-]?key|(?:^|[_-])(ak|sk)(?:$|[_-])/i;
const TEXT_RAW_KEY_PATTERN = /reasoning|thought|prompt|content|text|markdown|delta|answer|reply/i;
const SAFE_RAW_TEXT_KEYS = new Set([
  'event',
  'type',
  'status',
  'phase',
  'code',
  'id',
  'session_id',
  'sessionid',
  'message_id',
  'messageid',
  'agent_message_id',
  'agentmessageid',
  'tool_call_id',
  'toolcallid',
  'plan_item_id',
  'planitemid',
  'tool_name',
  'toolname',
  'model_name',
  'modelname',
  'config_name',
  'configname'
]);

function normalizeRawKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sanitizeRawValue(value, key, depth = 0) {
  if (value == null) return value;
  const keyText = String(key || '');
  const normalizedKey = normalizeRawKey(keyText);

  if (SENSITIVE_RAW_KEY_PATTERN.test(keyText)) return '[redacted]';
  if (typeof value === 'string') {
    if (TEXT_RAW_KEY_PATTERN.test(keyText) && !SAFE_RAW_TEXT_KEYS.has(normalizedKey)) {
      return { redacted: true, chars: value.length };
    }
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated ${value.length - 500} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (depth >= 4) return '[max-depth]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item, index) => sanitizeRawValue(item, `${keyText}.${index}`, depth + 1));
    if (value.length > items.length) items.push(`[truncated ${value.length - items.length} items]`);
    return items;
  }

  const output = {};
  const entries = Object.entries(value).slice(0, 80);
  for (const [childKey, childValue] of entries) {
    output[childKey] = sanitizeRawValue(childValue, childKey, depth + 1);
  }
  const totalKeys = Object.keys(value).length;
  if (totalKeys > entries.length) output.__truncatedKeys = totalKeys - entries.length;
  return output;
}

function sanitizeRawStreamEvent(event) {
  const payload = event && typeof event === 'object' ? event : {};
  return {
    ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
    service: typeof payload.service === 'string' ? payload.service : undefined,
    method: typeof payload.method === 'string' ? payload.method : undefined,
    channelId: typeof payload.channelId === 'string' ? payload.channelId : undefined,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
    agentMessageId: typeof payload.agentMessageId === 'string' ? payload.agentMessageId : undefined,
    event: typeof payload.event === 'string' ? payload.event : String(payload.event || ''),
    payload: sanitizeRawValue(payload.payload, 'payload')
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyTraeError(message) {
  return /not waiting input|busy|running/i.test(message || '');
}

async function pickTraeCommand() {
  const commands = await vscode.commands.getCommands(true);
  for (const command of WAIT_COMMAND_CANDIDATES) {
    if (commands.includes(command)) return command;
  }
  return null;
}

async function listTraeBridgeCommands() {
  const commands = await vscode.commands.getCommands(true);
  const commandSet = new Set(commands);
  const discovered = commands
    .filter((command) => {
      return WAIT_COMMAND_CANDIDATES.includes(command)
        || STREAMING_COMMAND_CANDIDATES.includes(command)
        || DISCOVERY_PATTERNS.some((pattern) => pattern.test(command));
    })
    .sort();
  return {
    waitCommand: WAIT_COMMAND_CANDIDATES.find((command) => commandSet.has(command)) || null,
    streamCommand: STREAMING_COMMAND_CANDIDATES.find((command) => commandSet.has(command)) || null,
    rawStreamCommand: commandSet.has(RAW_STREAM_COMMAND) ? RAW_STREAM_COMMAND : null,
    waitCommands: WAIT_COMMAND_CANDIDATES.map((command) => ({ command, available: commandSet.has(command) })),
    streamingCommands: STREAMING_COMMAND_CANDIDATES.map((command) => ({ command, available: commandSet.has(command) })),
    rawStreamingCommands: [{ command: RAW_STREAM_COMMAND, available: commandSet.has(RAW_STREAM_COMMAND) }],
    discoveredCommands: discovered.slice(0, 100),
    discoveredCommandCount: discovered.length
  };
}

function normalizeResult(result) {
  if (result == null) return { text: '' };
  if (typeof result === 'string') return { text: result };
  if (typeof result.text === 'string') return { ...result, text: result.text };
  if (result.response && typeof result.response.text === 'string') return { ...result, text: result.response.text };
  return { text: JSON.stringify(result), raw: result };
}

async function dispatchChat(payload, onProgress) {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw new Error('prompt is required');
  const images = Array.isArray(payload.images) ? payload.images : undefined;
  let lastError = null;

  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
    const command = await pickTraeCommand();
    if (!command) {
      throw new Error(`Trae bridge command not found: ${WAIT_COMMAND_CANDIDATES.join(', ')}`);
    }
    try {
      log(`execute ${command}, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
      const result = await vscode.commands.executeCommand(command, prompt, images);
      return { ok: true, command, ...normalizeResult(result) };
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      log(`command failed: ${message}`);
      const isBusy = isBusyTraeError(message);
      if (!isBusy || attempt === BUSY_RETRY_ATTEMPTS - 1) break;
      if (onProgress) {
        onProgress({
          phase: 'busy',
          attempt: attempt + 1,
          maxAttempts: BUSY_RETRY_ATTEMPTS,
          retryInMs: BUSY_RETRY_DELAY_MS,
          message
        });
      }
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }

  throw lastError || new Error('Trae bridge command failed');
}

async function dispatchChatStream(payload, res) {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw new Error('prompt is required');
  const images = Array.isArray(payload.images) ? payload.images : undefined;
  const commands = await listTraeBridgeCommands();
  const command = commands.streamCommand;
  if (!command) {
    throw new Error(`Trae streaming bridge command not found: ${STREAMING_COMMAND_CANDIDATES.join(', ')}`);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  sendSseEvent(res, 'start', { ok: true, command, port: PORT });

  let fullText = '';
  let closed = false;
  const progressStarted = Date.now();
  let progressTimer = null;
  let rawPollTimer = null;
  let rawStreamSubscription = null;
  const rawStreamStartedAt = Date.now();
  const seenRawEvents = new Set();
  const cleanupRawStream = () => {
    if (rawPollTimer) {
      clearInterval(rawPollTimer);
      rawPollTimer = null;
    }
    if (rawStreamSubscription && typeof rawStreamSubscription.dispose === 'function') {
      try {
        rawStreamSubscription.dispose();
      } catch (err) {
        log(`raw stream unsubscribe failed: ${err && err.message ? err.message : String(err)}`);
      }
    }
    rawStreamSubscription = null;
  };
  res.on('close', () => {
    closed = true;
    if (progressTimer) clearInterval(progressTimer);
    cleanupRawStream();
  });
  progressTimer = setInterval(() => {
    if (closed) return;
    sendSseEvent(res, 'progress', {
      phase: 'running',
      elapsedMs: Date.now() - progressStarted
    });
  }, 2000);

  const emitText = (nextText) => {
    if (closed || typeof nextText !== 'string') return;
    const delta = nextText.startsWith(fullText) ? nextText.slice(fullText.length) : nextText;
    fullText = nextText;
    if (delta) sendSseEvent(res, 'text_delta', { text: delta, fullText });
  };
  const emitInteraction = (interaction) => {
    if (!closed) sendSseEvent(res, 'interaction', { interaction });
  };
  const emitRawEvent = (event) => {
    if (!closed) sendSseEvent(res, 'raw_event', sanitizeRawStreamEvent(event));
  };
  const makeRawEventKey = (event) => {
    if (!event || typeof event !== 'object') return JSON.stringify(event);
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    return [
      event.ts,
      event.service,
      event.method,
      event.channelId,
      event.sessionId,
      event.agentMessageId,
      event.event,
      payload.message_id,
      payload.id,
      payload.task_id,
      payload.tool_call_info && payload.tool_call_info.id
    ].filter(Boolean).join('|');
  };
  const emitRawSnapshot = async () => {
    if (closed || !commands.rawStreamCommand) return;
    try {
      const events = await vscode.commands.executeCommand(commands.rawStreamCommand);
      if (!Array.isArray(events)) return;
      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        if (typeof event.ts === 'number' && event.ts < rawStreamStartedAt - 1000) continue;
        if (event.service && (event.service !== 'chat' || event.method !== 'chat')) continue;
        const key = makeRawEventKey(event);
        if (seenRawEvents.has(key)) continue;
        seenRawEvents.add(key);
        emitRawEvent(event);
      }
    } catch (err) {
      log(`raw stream poll failed: ${err && err.message ? err.message : String(err)}`);
    }
  };

  if (commands.rawStreamCommand) {
    try {
      rawStreamSubscription = await vscode.commands.executeCommand(commands.rawStreamCommand, emitRawEvent);
      rawPollTimer = setInterval(() => {
        emitRawSnapshot();
      }, 250);
      sendSseEvent(res, 'progress', {
        phase: 'raw_stream_subscribed',
        elapsedMs: Date.now() - progressStarted
      });
    } catch (err) {
      log(`raw stream subscribe failed: ${err && err.message ? err.message : String(err)}`);
      sendSseEvent(res, 'progress', {
        phase: 'raw_stream_unavailable',
        elapsedMs: Date.now() - progressStarted,
        message: err && err.message ? err.message : String(err)
      });
    }
  } else {
    sendSseEvent(res, 'progress', {
      phase: 'raw_stream_unavailable',
      elapsedMs: Date.now() - progressStarted,
      message: `${RAW_STREAM_COMMAND} is not registered`
    });
  }

  log(`execute ${command}, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
  let result = null;
  let lastError = null;
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      result = await vscode.commands.executeCommand(command, prompt, images, emitText, emitInteraction);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      log(`stream command failed: ${message}`);
      const isBusy = isBusyTraeError(message);
      if (!isBusy || attempt === BUSY_RETRY_ATTEMPTS - 1) break;
      sendSseEvent(res, 'progress', {
        phase: 'busy',
        attempt: attempt + 1,
        maxAttempts: BUSY_RETRY_ATTEMPTS,
        retryInMs: BUSY_RETRY_DELAY_MS,
        elapsedMs: Date.now() - progressStarted,
        message
      });
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }
  await emitRawSnapshot();
  if (lastError) {
    log(`fallback wait command, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
    result = await dispatchChat(payload, (progress) => {
      if (!closed) {
        sendSseEvent(res, 'progress', {
          ...progress,
          phase: progress.phase || 'busy',
          fallback: true,
          elapsedMs: Date.now() - progressStarted
        });
      }
    });
  }
  const normalized = normalizeResult(result);
  if (typeof normalized.text === 'string' && normalized.text && normalized.text !== fullText) {
    emitText(normalized.text);
  }
  await emitRawSnapshot();
  if (!closed) {
    sendSseEvent(res, 'done', { ok: true, command, text: fullText || normalized.text || '', files: normalized.files });
    res.end();
  }
  cleanupRawStream();
  if (progressTimer) clearInterval(progressTimer);
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    const commands = await listTraeBridgeCommands();
    sendJson(res, 200, {
      ok: Boolean(commands.waitCommand),
      command: commands.waitCommand,
      port: PORT,
      commands: WAIT_COMMAND_CANDIDATES,
      ...commands
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/debug/commands') {
    const commands = await listTraeBridgeCommands();
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      ...commands
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/debug/raw-stream') {
    try {
      const commands = await listTraeBridgeCommands();
      if (!commands.rawStreamCommand) {
        sendJson(res, 404, {
          ok: false,
          error: `${RAW_STREAM_COMMAND} is not registered`,
          ...commands
        });
        return;
      }
      const events = await vscode.commands.executeCommand(commands.rawStreamCommand);
      sendJson(res, 200, {
        ok: true,
        command: commands.rawStreamCommand,
        events: Array.isArray(events) ? events.map(sanitizeRawStreamEvent) : [],
        eventCount: Array.isArray(events) ? events.length : 0
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat') {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const result = await dispatchChat(payload);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/stream') {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      await dispatchChatStream(payload, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: err && err.message ? err.message : String(err)
        });
      } else {
        sendSseEvent(res, 'error', { ok: false, error: err && err.message ? err.message : String(err) });
        res.end();
      }
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: 'Not found' });
}

function activate(context) {
  output = vscode.window.createOutputChannel('HTTPS Proxy Manager Trae Bridge');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('httpsProxyManager.traeBridge.status', async () => {
    const command = await pickTraeCommand();
    const message = command
      ? `Trae bridge listening on http://${HOST}:${PORT}, command=${command}`
      : `Trae bridge listening on http://${HOST}:${PORT}, but no Trae bridge command was found`;
    vscode.window.showInformationMessage(message);
    return { ok: Boolean(command), command, port: PORT };
  }));

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
    });
  });
  server.on('error', (err) => {
    log(`server error: ${err.message}`);
  });
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}`);
  });
  context.subscriptions.push({ dispose: deactivate });
}

function deactivate() {
  if (server) {
    try {
      server.close();
    } catch (err) {}
    server = null;
  }
}

module.exports = {
  activate,
  deactivate
};
