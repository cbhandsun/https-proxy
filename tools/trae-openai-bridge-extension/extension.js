/**
 * Trae OpenAI Bridge Extension - 入口 / 生命周期
 *
 * 拆分自原 536 行实现,本文件只剩 3 件事:
 *   1. activate()      - 注册 vscode 命令 + 启动 HTTP server
 *   2. handleRequest() - 把 HTTP 路由分派到 bridge / sanitize / utils
 *   3. deactivate()    - 关闭 server + 清理资源
 *
 * 拆分:
 *   - extension-utils.js    (140 行)  常量 + HTTP 工具 + 命令发现
 *   - extension-sanitize.js (95 行)   原始事件脱敏
 *   - extension-bridge.js   (220 行)  dispatchChat / dispatchChatStream
 *   - extension.js          (160 行)  入口 + 路由 + 生命周期
 */

const http = require('http');
const vscode = require('vscode');
const url = require('url');

const {
  HOST,
  PORT,
  MAX_BODY_BYTES,
  createLogger,
  sendJson,
  sendSseEvent,
  readBody,
  listTraeBridgeCommands: listTraeBridgeCommandsPure,
} = require('./extension-utils');
const {
  sanitizeRawStreamEvent,
  makeRawEventKey,
} = require('./extension-sanitize');
const { createBridge } = require('./extension-bridge');

let outputChannel = null;
let log = createLogger(() => outputChannel);
let server = null;
let bridge = null;

function setOutputChannel(channel) {
  outputChannel = channel;
}

async function getAllCommands() {
  const all = await vscode.commands.getCommands(true);
  return all;
}

function createBridgeInstance() {
  return createBridge({
    executeCommand: async (command, ...args) => {
      return await vscode.commands.executeCommand(command, ...args);
    },
    getAllCommands,
    log,
  });
}

function getBridge() {
  if (!bridge) bridge = createBridgeInstance();
  return bridge;
}

function createServer() {
  const handleRequest = async (req, res) => {
    const parsed = url.parse(req.url || '/', true);
    const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
    try {
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/v1/health')) {
        sendJson(res, 200, { ok: true, host: HOST, port: PORT, ts: Date.now() });
        return;
      }
      if (req.method === 'GET' && (pathname === '/commands' || pathname === '/v1/commands')) {
        const info = await getBridge().listTraeBridgeCommands();
        sendJson(res, 200, info);
        return;
      }
      if (req.method === 'POST' && (pathname === '/v1/chat' || pathname === '/chat')) {
        const raw = await readBody(req, MAX_BODY_BYTES);
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch (err) {
          sendJson(res, 400, { ok: false, error: 'invalid json' });
          return;
        }
        const result = await getBridge().dispatchChat(payload);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && (pathname === '/v1/chat/stream' || pathname === '/chat/stream')) {
        const raw = await readBody(req, MAX_BODY_BYTES);
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch (err) {
          sendJson(res, 400, { ok: false, error: 'invalid json' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        });
        await getBridge().dispatchChatStream(payload, res, {
          sanitizeRawStreamEvent,
          makeRawEventKey,
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: `not found: ${req.method} ${pathname}` });
    } catch (err) {
      log(`handler error: ${err && err.message ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      } else {
        try { sendSseEvent(res, 'error', { ok: false, error: err && err.message ? err.message : String(err) }); res.end(); } catch (e) {}
      }
    }
  };
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`unhandled error: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'unhandled error' });
      }
    });
  });
}

function activate(context) {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Trae OpenAI Bridge');
    log = createLogger(() => outputChannel);
  }
  log(`activating (target http://${HOST}:${PORT})`);
  bridge = createBridgeInstance();
  if (!server) {
    server = createServer();
  }
  if (!server.listening) {
    server.listen(PORT, HOST, () => {
      log(`listening on http://${HOST}:${PORT}`);
    });
  }
  server.on('error', (err) => {
    log(`server error: ${err && err.message ? err.message : String(err)}`);
  });
  context.subscriptions.push({ dispose: deactivate });
}

function deactivate() {
  if (server) {
    try { server.close(); } catch (err) {}
    server = null;
  }
  bridge = null;
  log('deactivated');
}

module.exports = {
  activate,
  deactivate,
  // Exposed for unit tests
  _setOutputChannel: setOutputChannel,
  _createServer: createServer,
  _createBridgeInstance: createBridgeInstance,
};
