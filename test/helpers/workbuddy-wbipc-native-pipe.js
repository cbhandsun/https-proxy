'use strict';

// A synthetic OS IPC peer, not an installed WorkBuddy process or model endpoint.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

function proof(ticket, role, endpoint, clientNonce, serverNonce) {
  const parts = [
    role === 'server' ? 'wbipc-s' : 'wbipc-c',
    '1',
    endpoint,
    clientNonce,
    serverNonce,
  ];
  const transcript = parts.flatMap((part) => {
    const bytes = Buffer.from(part);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return [size, bytes];
  });
  return crypto.createHmac('sha256', ticket).update(Buffer.concat(transcript)).digest('base64url');
}

async function createNativePipePeer(t, { onFetch, onPipe, badProof = false } = {}) {
  const id = crypto.randomUUID();
  const directory =
    process.platform === 'win32'
      ? null
      : await fs.mkdtemp(path.join(syncFs.realpathSync.native(os.tmpdir()), 'hpm-wbipc-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\hpm-test-${id}`
      : path.join(directory, `${id}.sock`);
  const ticket = crypto.randomBytes(32).toString('hex');
  const sockets = new Set();
  const errors = [];
  const requests = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (error) => errors.push(error));
    let buffer = Buffer.alloc(0);
    let state = 'hello';
    let clientNonce;
    const serverNonce = crypto.randomBytes(16).toString('base64url');
    const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
    function receive(frame, frameBytes) {
      assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame));
      if (state === 'hello') {
        assert.equal(frame.type, 'session_hello');
        assert.equal(frame.protocol_min, 1);
        assert.equal(frame.protocol_max, 1);
        assert.equal(
          frame.ticket_id,
          crypto.createHash('sha256').update(ticket).digest('hex').slice(0, 16)
        );
        assert.equal(typeof frame.client_nonce, 'string');
        clientNonce = frame.client_nonce;
        state = 'prove';
        send({
          type: 'session_challenge',
          server_nonce: serverNonce,
          server_proof: badProof
            ? 'invalid-proof'
            : proof(ticket, 'server', endpoint, clientNonce, serverNonce),
        });
        return;
      }
      if (state === 'prove') {
        assert.equal(frame.type, 'session_prove');
        assert.equal(
          frame.client_proof,
          proof(ticket, 'client', endpoint, clientNonce, serverNonce)
        );
        state = 'pipe';
        send({ type: 'session_hello_ack', protocol: 1 });
        return;
      }
      assert.equal(frame.jsonrpc, '2.0');
      assert.ok(Number.isSafeInteger(frame.id));
      if (state === 'pipe') {
        assert.equal(frame.method, 'broker/GetPipe');
        assert.deepEqual(frame.params, { pipe: 'wb.request' });
        state = 'fetch';
        onPipe?.();
        send({
          jsonrpc: '2.0',
          id: frame.id,
          result: { channel: 'synthetic', methods: ['http.fetch'] },
        });
        return;
      }
      assert.equal(state, 'fetch');
      assert.equal(frame.method, 'synthetic/http.fetch');
      assert.equal(frame.mode, 'call');
      state = 'done';
      requests.push({ params: frame.params, frameBytes });
      const controls = {
        close: () => socket.end(),
        malformed: () => socket.write('{invalid-json}\n'),
        fail: () =>
          send({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: 'synthetic_failure', message: 'PRIVATE_SYNTHETIC_ERROR' },
          }),
      };
      const response = onFetch?.(frame.params, controls);
      if (response === null) return;
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body_b64: Buffer.from(response ?? '{"ok":true}').toString('base64'),
        },
      });
    }
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        assert.ok(buffer.length <= 2 * 1024 * 1024, 'synthetic IPC input limit exceeded');
        for (;;) {
          const newline = buffer.indexOf(10);
          if (newline < 0) break;
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          receive(JSON.parse(line.toString('utf8')), line.length + 1);
        }
      } catch (error) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    assert.equal(errors.length, 0, 'Synthetic IPC peer failed; raw frame/error data withheld');
  });
  server.listen(endpoint);
  await once(server, 'listening');
  return {
    endpoint,
    ticket,
    requests,
    get connections() {
      return connections;
    },
    waitForDisconnect: () => Promise.all([...sockets].map((socket) => once(socket, 'close'))),
  };
}

function isolateNativePipeTestEnvironment(t) {
  const { createIsolatedTestEnv } = require('../../lib/test-runtime');
  const directory = syncFs.mkdtempSync(
    path.join(syncFs.realpathSync.native(os.tmpdir()), 'hpm-wbipc-env-')
  );
  const previous = { ...process.env };
  const isolated = createIsolatedTestEnv(previous, directory);
  for (const key of Object.keys(isolated)) {
    if (key.toUpperCase() === 'WORKBUDDY_CONFIG_DIR') delete isolated[key];
  }
  isolated.WORKBUDDY_CONFIG_DIR = path.join(directory, 'workbuddy');
  isolated.PROXY_DATA_DIR = path.join(directory, 'data');
  isolated.PROXY_CERT_DIR = path.join(directory, 'certs');
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated);
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    syncFs.rmSync(directory, { recursive: true, force: true });
  });
}

module.exports = { createNativePipePeer, isolateNativePipeTestEnvironment };
