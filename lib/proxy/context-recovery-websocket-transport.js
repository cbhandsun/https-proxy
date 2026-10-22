'use strict';

const { WebSocket, WebSocketServer } = require('ws');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { createRecoveryWebSocketConnection } = require('./context-recovery-websocket-connection');
const {
  MAX_HANDSHAKE_BODY_BYTES,
  recoveryHandshakeHeaders,
  recoveryHandshakeRejection,
} = require('./context-recovery-websocket-handshake');

// RFC framing, masks, fragmentation, UTF-8 and negotiated compression belong to
// ws. Recovery receives bounded complete messages, never raw socket fragments.
function startRecoveryWebSocketTransport({
  clientReq,
  clientSocket,
  lifecycle,
  url,
  headers,
  agent,
  runtime,
  auth,
  prepared,
  authorized,
}) {
  let upstream, client, connection, server, rejection, rejectionTimer;
  let handshakeHeaders = [];
  let replying = false;
  let stopped = false;
  const queued = new WeakMap();
  const tails = new WeakMap();
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(rejectionTimer);
    rejection?.destroy();
    connection?.close();
    client?.terminate();
    upstream?.terminate();
    server?.close();
    lifecycle.close();
  }
  function permitted() {
    try {
      return !stopped && lifecycle.available() && authorized() === true;
    } catch {
      return false;
    }
  }
  function rejectHandshake(status, headers, body) {
    if (replying) return;
    if (!permitted()) {
      stop();
      return;
    }
    let bytes;
    try {
      bytes = recoveryHandshakeRejection(status, headers, body);
    } catch {
      bytes = recoveryHandshakeRejection(502, {}, Buffer.from('Bad Gateway'));
    }
    replying = true;
    try {
      clientSocket.end(bytes, stop);
    } catch {
      stop();
    }
  }
  function send(peer, event) {
    const bytes = Buffer.from(JSON.stringify(event));
    const amount = (queued.get(peer) ?? 0) + bytes.length;
    const maximum = peer === upstream ? recoveryHistoryRequestLimit(3) : MAX_WIRE_BYTES;
    if (bytes.length > maximum || amount > maximum)
      return Promise.reject(new Error('Recovery WebSocket send unavailable'));
    queued.set(peer, amount);
    const next = (tails.get(peer) ?? Promise.resolve())
      .then(
        () =>
          new Promise((resolve, reject) => {
            if (stopped || peer.readyState !== WebSocket.OPEN) {
              reject(new Error('Recovery WebSocket send unavailable'));
              return;
            }
            peer.send(bytes, { binary: false }, (error) =>
              error ? reject(new Error('Recovery WebSocket send unavailable')) : resolve()
            );
          })
      )
      .finally(() => queued.set(peer, (queued.get(peer) ?? 0) - bytes.length));
    tails.set(peer, next.catch(stop));
    return next;
  }
  try {
    if (!permitted()) throw new Error('Recovery WebSocket handshake unavailable');
    const protocols =
      typeof clientReq.headers['sec-websocket-protocol'] === 'string'
        ? clientReq.headers['sec-websocket-protocol'].split(',').map((value) => value.trim())
        : [];
    if (protocols.length > 16 || protocols.some((value) => !value || value.length > 256))
      throw new Error('Recovery WebSocket handshake unavailable');
    const forwarded = { ...headers };
    for (const key of Object.keys(forwarded))
      if (
        /^(?:sec-websocket-|host$|connection$|upgrade$|content-length$|transfer-encoding$)/i.test(
          key
        )
      )
        delete forwarded[key];
    const compression = {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 1,
    };
    upstream = new WebSocket(url, protocols, {
      headers: forwarded,
      agent,
      handshakeTimeout: 10000,
      maxPayload: MAX_WIRE_BYTES,
      perMessageDeflate: compression,
      followRedirects: false,
    });
    upstream.on('error', stop);
    upstream.on('close', stop);
    upstream.on('upgrade', (response) => {
      try {
        if (!permitted()) throw new Error('Recovery WebSocket handshake unavailable');
        handshakeHeaders = recoveryHandshakeHeaders(response.headers);
        if (!lifecycle.attachSocket(response.socket)) stop();
      } catch {
        stop();
      }
    });
    upstream.once('unexpected-response', (_request, response) => {
      rejection = response;
      if (!permitted()) {
        stop();
        return;
      }
      rejectionTimer = setTimeout(stop, 10000);
      const chunks = [];
      let bytes = 0;
      response.on('error', stop);
      response.once('aborted', stop);
      response.on('data', (chunk) => {
        if (replying || stopped) return;
        if (!permitted()) {
          chunks.length = 0;
          stop();
          return;
        }
        if (!Buffer.isBuffer(chunk) || chunk.length > MAX_HANDSHAKE_BODY_BYTES - bytes) {
          chunks.length = 0;
          response.pause();
          rejectHandshake(502, {}, Buffer.from('Bad Gateway'));
          return;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      });
      response.once('end', () => {
        rejectHandshake(response.statusCode, response.headers, Buffer.concat(chunks, bytes));
      });
    });
    upstream.once('open', () => {
      if (!permitted()) {
        stop();
        return;
      }
      server = new WebSocketServer({
        noServer: true,
        maxPayload: recoveryHistoryRequestLimit(3),
        perMessageDeflate: compression,
        handleProtocols: () => upstream.protocol || false,
      });
      server.on('error', stop);
      server.on('headers', (headers) => headers.push(...handshakeHeaders));
      server.handleUpgrade(clientReq, clientSocket, Buffer.alloc(0), (socket) => {
        client = socket;
        client.on('error', stop);
        client.on('close', stop);
        connection = createRecoveryWebSocketConnection({
          runtime,
          auth,
          prepared,
          authorized,
          sendClient: (event) => send(client, event),
          sendUpstream: (event) => send(upstream, event),
          close: stop,
        });
        client.on('message', (data, binary) => connection.client(data, binary));
        upstream.on('message', (data, binary) => connection.upstream(data, binary));
        client.resume();
      });
    });
    if (!lifecycle.attachRequest({ destroy: () => upstream.terminate() })) stop();
  } catch {
    stop();
  }
  return { close: stop };
}

module.exports = { startRecoveryWebSocketTransport };
