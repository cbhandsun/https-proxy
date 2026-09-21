'use strict';

/**
 * 回归：用真实 socket 验证"握手阶段被重置"这一判据。
 *
 * 纯函数测试只能证明逻辑本身；这里证明 Node 在真实连接上产生的状态确实能被
 * readPreTransmissionContext 正确识别，否则线上那类 ECONNRESET 仍然会漏判。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  readPreTransmissionContext,
  isPreTransmissionFailure,
} = require('../lib/proxy/upstream-retry');

const repoRoot = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function send(port, agent, body) {
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        rejectUnauthorized: false,
        servername: 'localhost',
        agent,
        headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        response.on('data', () => {});
        response.on('end', () =>
          resolve({
            phase: 'complete',
            status: response.statusCode,
            context: readPreTransmissionContext(request),
          })
        );
        response.on('error', (error) =>
          resolve({
            phase: 'response-error',
            code: error.code,
            context: readPreTransmissionContext(request),
          })
        );
      }
    );
    request.on('error', (error) =>
      resolve({
        phase: 'request-error',
        code: error.code,
        context: readPreTransmissionContext(request),
      })
    );
    request.end(body);
  });
}

function buildServerCertificate() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-retry-cert-'));
  const previous = process.env.PROXY_RUNTIME_DIR;
  process.env.PROXY_RUNTIME_DIR = runtimeDir;
  try {
    const cert = require(path.join(repoRoot, 'lib', 'proxy', 'cert'));
    cert.ensureCert();
    return {
      cert: fs.readFileSync(cert.CERT_FILE),
      key: fs.readFileSync(cert.KEY_FILE),
      cleanup: () => fs.rmSync(runtimeDir, { recursive: true, force: true }),
    };
  } finally {
    if (previous === undefined) delete process.env.PROXY_RUNTIME_DIR;
    else process.env.PROXY_RUNTIME_DIR = previous;
  }
}

async function main() {
  const credentials = buildServerCertificate();
  try {
    // 1) 握手阶段被重置：真实 TCP 服务器在 TLS 完成前断开。
    const resetServer = net.createServer((socket) => setTimeout(() => socket.destroy(), 40));
    const resetPort = await listen(resetServer);
    const resetResult = await send(resetPort, new https.Agent({ keepAlive: true }), 'x'.repeat(64));
    await close(resetServer);

    assert.strictEqual(resetResult.phase, 'request-error');
    assert.strictEqual(
      resetResult.context.tlsHandshakeIncomplete,
      true,
      '握手未完成必须被识别出来，否则投毒重置仍会 502'
    );
    assert.strictEqual(resetResult.context.reusedSocket, false);
    assert.strictEqual(isPreTransmissionFailure(resetResult.code, resetResult.context), true);

    // 2) 握手完成后的正常响应：绝不能被误判成可重放。
    const okServer = https.createServer(
      { cert: credentials.cert, key: credentials.key },
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }
    );
    const okPort = await listen(okServer);
    const okResult = await send(okPort, new https.Agent({ keepAlive: true }), 'x'.repeat(64));
    assert.strictEqual(okResult.phase, 'complete');
    assert.strictEqual(okResult.status, 200);
    assert.strictEqual(okResult.context.tlsHandshakeIncomplete, false);
    assert.strictEqual(isPreTransmissionFailure('ECONNRESET', okResult.context), false);

    // 3) 握手完成后连接中断：必须回到显式幂等契约，不能借握手豁免重放。
    const midServer = https.createServer(
      { cert: credentials.cert, key: credentials.key },
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 1000 });
        res.write('partial');
        setTimeout(() => res.socket && res.socket.destroy(), 40);
      }
    );
    const midPort = await listen(midServer);
    const midResult = await send(midPort, new https.Agent({ keepAlive: false }), 'x'.repeat(64));
    await close(midServer);
    await close(okServer);

    assert.strictEqual(midResult.context.tlsHandshakeIncomplete, false);
    assert.strictEqual(
      isPreTransmissionFailure(midResult.code || 'ECONNRESET', midResult.context),
      false
    );
  } finally {
    credentials.cleanup();
  }

  console.log('[upstream-retry-handshake.test] ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
