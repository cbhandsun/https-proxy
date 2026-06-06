const http = require('http');
const vscode = require('vscode');

const HOST = '127.0.0.1';
const PORT = Number(process.env.TRAE_OPENAI_BRIDGE_PORT || process.env.TRAE_BRIDGE_PORT || 17861);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const COMMAND_CANDIDATES = [
  'wx.bridge.sendAndWaitResponse',
  'feishu.bridge.sendAndWaitResponse'
];

let server = null;
let output = null;

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

async function pickTraeCommand() {
  const commands = await vscode.commands.getCommands(true);
  for (const command of COMMAND_CANDIDATES) {
    if (commands.includes(command)) return command;
  }
  return null;
}

function normalizeResult(result) {
  if (result == null) return { text: '' };
  if (typeof result === 'string') return { text: result };
  if (typeof result.text === 'string') return { ...result, text: result.text };
  if (result.response && typeof result.response.text === 'string') return { ...result, text: result.response.text };
  return { text: JSON.stringify(result), raw: result };
}

async function dispatchChat(payload) {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) throw new Error('prompt is required');
  const images = Array.isArray(payload.images) ? payload.images : undefined;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const command = await pickTraeCommand();
    if (!command) {
      throw new Error(`Trae bridge command not found: ${COMMAND_CANDIDATES.join(', ')}`);
    }
    try {
      log(`execute ${command}, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
      const result = await vscode.commands.executeCommand(command, prompt, images);
      return { ok: true, command, ...normalizeResult(result) };
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      log(`command failed: ${message}`);
      if (!/not waiting input|busy|running/i.test(message) || attempt === 2) break;
      await delay(1000);
    }
  }

  throw lastError || new Error('Trae bridge command failed');
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    const command = await pickTraeCommand();
    sendJson(res, 200, {
      ok: Boolean(command),
      command,
      port: PORT,
      commands: COMMAND_CANDIDATES
    });
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
