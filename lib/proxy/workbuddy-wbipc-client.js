'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const WBIPC_PROTOCOL_VERSION = 1;
const WBIPC_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_CLIENT_VERSION = 'https-proxy';
const WB_REQUEST_PIPE = 'wb.request';
const WB_REQUEST_FETCH_METHOD = 'http.fetch';

function getWorkBuddyWbipcDiscoveryPath(configDir) {
  const baseDir =
    configDir || process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy');
  return path.join(baseDir, 'wbipc', 'endpoint.json');
}

function readWorkBuddyWbipcEndpoint(discoveryPath = getWorkBuddyWbipcDiscoveryPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.endpoint !== 'string' || !parsed.endpoint.trim()) return null;
    if (typeof parsed.ticket !== 'string' || !parsed.ticket.trim()) return null;
    return { endpoint: parsed.endpoint, ticket: parsed.ticket };
  } catch (_err) {
    return null;
  }
}

function ticketId(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16);
}

function generateNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

function encodeTranscript(role, transcript) {
  const parts = [
    role === 'server' ? 'wbipc-s' : 'wbipc-c',
    String(transcript.protocol),
    transcript.endpoint,
    transcript.clientNonce,
    transcript.serverNonce,
  ];
  const chunks = [];
  for (const part of parts) {
    const value = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length, 0);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function computeProof(ticket, role, transcript) {
  return crypto
    .createHmac('sha256', Buffer.from(ticket, 'utf8'))
    .update(encodeTranscript(role, transcript))
    .digest('base64url');
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeWbipcHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('WorkBuddy WBIPC headers must be an object');
  }
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name || '')
      .trim()
      .toLowerCase();
    if (key !== 'content-type' && key !== 'accept') {
      throw new Error('WorkBuddy WBIPC only accepts content-type and accept request headers');
    }
    if (typeof value !== 'string') {
      throw new Error(`WorkBuddy WBIPC header ${name} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

function normalizeWbipcPath(value) {
  const clean = String(value || '').trim();
  if (!clean.startsWith('/') || clean.startsWith('//')) {
    throw new Error('WorkBuddy WBIPC path must be a relative path starting with /');
  }
  if (clean.includes('?') || clean.includes('#') || hasUnsafePathCharacter(clean)) {
    throw new Error('WorkBuddy WBIPC path contains unsupported characters');
  }
  if (clean.split('/').some((segment) => segment === '..')) {
    throw new Error('WorkBuddy WBIPC path must not contain .. segments');
  }
  return clean;
}

function hasUnsafePathCharacter(value) {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || /\s/.test(ch) || code < 32 || code === 127) return true;
  }
  return false;
}

function createFrameReader(onFrame, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  return function pushFrameChunk(chunk) {
    if (failed) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const nl = buffer.indexOf(10);
      if (nl < 0) {
        if (buffer.length > WBIPC_MAX_FRAME_BYTES) {
          failed = true;
          onError(new Error('WorkBuddy WBIPC frame exceeded maximum size'));
        }
        return;
      }
      const line = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (line.length === 0) continue;
      try {
        onFrame(JSON.parse(line.toString('utf8')));
      } catch (err) {
        failed = true;
        onError(err);
      }
    }
  };
}

function createWorkBuddyWbipcClient(options = {}) {
  const readEndpoint = options.readEndpoint || readWorkBuddyWbipcEndpoint;
  const connect = options.connect || net.createConnection;
  const timeoutMs = Math.max(100, Math.trunc(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const clientVersion = options.clientVersion || DEFAULT_CLIENT_VERSION;

  async function request(params) {
    const endpointInfo = readEndpoint();
    if (!endpointInfo) {
      return { ok: false, status: 'not_available' };
    }
    return withConnection(endpointInfo, async (session) => {
      const pipe = await session.call('broker/GetPipe', { pipe: WB_REQUEST_PIPE });
      if (
        !pipe ||
        !Array.isArray(pipe.methods) ||
        !pipe.methods.includes(WB_REQUEST_FETCH_METHOD)
      ) {
        return { ok: false, status: 'method_unavailable' };
      }
      const channel = typeof pipe.channel === 'string' ? pipe.channel : '';
      if (!channel) return { ok: false, status: 'method_unavailable' };
      const response = await session.call(
        `${channel}/${WB_REQUEST_FETCH_METHOD}`,
        normalizeFetchParams(params),
        'call'
      );
      return {
        ok: true,
        status: Number(response && response.status),
        headers:
          response && response.headers && typeof response.headers === 'object'
            ? response.headers
            : {},
        body: decodeBody(response && response.body_b64),
      };
    });
  }

  function normalizeFetchParams(params) {
    const method = String(params && params.method ? params.method : 'POST').toUpperCase();
    const normalized = {
      method,
      path: normalizeWbipcPath(params && params.path),
      headers: normalizeWbipcHeaders(params && params.headers),
    };
    if (params && params.body !== undefined && params.body !== null) {
      normalized.body_b64 = Buffer.isBuffer(params.body)
        ? params.body.toString('base64')
        : Buffer.from(String(params.body)).toString('base64');
    }
    return normalized;
  }

  function decodeBody(value) {
    if (typeof value !== 'string') return '';
    return Buffer.from(value, 'base64').toString('utf8');
  }

  function withConnection(endpointInfo, fn) {
    return new Promise((resolve) => {
      const socket = connect(endpointInfo.endpoint);
      const pending = new Map();
      let nextId = 1;
      let settled = false;
      let handshakeState = 'connect';
      let clientNonce = '';
      let timeout = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        for (const item of pending.values()) item.reject(new Error('WorkBuddy WBIPC closed'));
        pending.clear();
        socket.destroy();
        resolve(value);
      };

      const fail = (status, err) => {
        finish({
          ok: false,
          status,
          error: err && err.message ? err.message : String(err || status),
        });
      };

      const pushFrame = createFrameReader(
        (frame) => {
          if (handshakeState === 'challenge') {
            handleChallenge(frame);
            return;
          }
          if (handshakeState === 'ack') {
            handleAck(frame);
            return;
          }
          if (frame && Object.prototype.hasOwnProperty.call(frame, 'id')) {
            const item = pending.get(frame.id);
            if (!item) return;
            pending.delete(frame.id);
            if (frame.error) {
              const err = new Error(
                frame.error.message || frame.error.code || 'WorkBuddy WBIPC error'
              );
              err.code = frame.error.code;
              item.reject(err);
            } else {
              item.resolve(frame.result);
            }
          }
        },
        (err) => fail('protocol_error', err)
      );

      const send = (frame) => {
        socket.write(`${JSON.stringify(frame)}\n`);
      };

      const call = (method, params, mode) =>
        new Promise((resolveCall, rejectCall) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCall, reject: rejectCall });
          send({
            jsonrpc: '2.0',
            id,
            method,
            ...(mode ? { mode } : {}),
            ...(params === undefined ? {} : { params }),
          });
        });

      function handleChallenge(frame) {
        if (!frame || frame.type !== 'session_challenge') {
          fail('handshake_failed', new Error('WorkBuddy WBIPC challenge was not received'));
          return;
        }
        const transcript = {
          protocol: WBIPC_PROTOCOL_VERSION,
          endpoint: endpointInfo.endpoint,
          clientNonce,
          serverNonce: frame.server_nonce,
        };
        if (
          !safeEqualString(
            computeProof(endpointInfo.ticket, 'server', transcript),
            frame.server_proof
          )
        ) {
          fail('endpoint_untrusted', new Error('WorkBuddy WBIPC server proof failed'));
          return;
        }
        handshakeState = 'ack';
        send({
          type: 'session_prove',
          client_proof: computeProof(endpointInfo.ticket, 'client', transcript),
        });
      }

      function handleAck(frame) {
        if (!frame || frame.type !== 'session_hello_ack') {
          fail('handshake_failed', new Error('WorkBuddy WBIPC acknowledgement was not received'));
          return;
        }
        handshakeState = 'ready';
        Promise.resolve()
          .then(() => fn({ call }))
          .then(finish)
          .catch((err) => fail(err && err.code ? err.code : 'request_failed', err));
      }

      timeout = setTimeout(
        () => fail('timeout', new Error('WorkBuddy WBIPC request timed out')),
        timeoutMs
      );
      socket.on('connect', () => {
        handshakeState = 'challenge';
        clientNonce = generateNonce();
        send({
          type: 'session_hello',
          protocol_min: WBIPC_PROTOCOL_VERSION,
          protocol_max: WBIPC_PROTOCOL_VERSION,
          client_nonce: clientNonce,
          ticket_id: ticketId(endpointInfo.ticket),
          client: {
            kind: 'https-proxy',
            id: 'workbuddy-official',
            version: clientVersion,
          },
        });
      });
      socket.on('data', pushFrame);
      socket.on('error', (err) => fail('connection_error', err));
      socket.on('close', () => {
        if (!settled) fail('connection_closed', new Error('WorkBuddy WBIPC connection closed'));
      });
    });
  }

  return { request };
}

module.exports = {
  createWorkBuddyWbipcClient,
  getWorkBuddyWbipcDiscoveryPath,
  readWorkBuddyWbipcEndpoint,
};
