'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const WBIPC_PROTOCOL_VERSION = 1;
const { createFrameReader } = require('./workbuddy-wbipc-frame-reader');
const { defaultWorkBuddyHostRecovery } = require('./workbuddy-host-recovery');
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

function createWorkBuddyWbipcClient(options = {}) {
  const readEndpoint = options.readEndpoint || readWorkBuddyWbipcEndpoint;
  const connect = options.connect || net.createConnection;
  const timeoutMs = Math.max(100, Math.trunc(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const clientVersion = options.clientVersion || DEFAULT_CLIENT_VERSION;
  const hostRecovery = options.hostRecovery || defaultWorkBuddyHostRecovery;
  const authorizeRequest = options.authorizeRequest;
  if (authorizeRequest !== undefined && typeof authorizeRequest !== 'function')
    throw new TypeError('Invalid WorkBuddy request authorization capability');
  function permitted() {
    try {
      return authorizeRequest === undefined || authorizeRequest() === true;
    } catch {
      return false;
    }
  }

  async function request(params, { signal } = {}) {
    if (signal?.aborted) return { ok: false, status: 'cancelled' };
    if (!permitted()) return { ok: false, status: 'unauthorized' };
    let normalized;
    try {
      normalized = normalizeFetchParams(params);
    } catch (_error) {
      return { ok: false, status: 'request_failed', error: 'Invalid WorkBuddy WBIPC request' };
    }
    const first = await requestOnce(normalized, signal);
    const pendingRecovery =
      first.result.status === 'method_unavailable' && hostRecovery.isRecovering?.();
    if (
      options.autoStart === false ||
      first.dispatched ||
      (!pendingRecovery && !['not_available', 'connection_error'].includes(first.result.status))
    )
      return first.result;
    const state = await hostRecovery.ensureReady(probe, signal);
    if (state !== 'ready') return { ok: false, status: state };
    if (signal?.aborted) return { ok: false, status: 'cancelled' };
    // A probe never sends http.fetch. The original request is sent at most once after recovery.
    return (await requestOnce(normalized, signal)).result;
  }

  async function getPipe(session) {
    const pipe = await session.call('broker/GetPipe', { pipe: WB_REQUEST_PIPE });
    if (
      !pipe ||
      !Array.isArray(pipe.methods) ||
      !pipe.methods.includes(WB_REQUEST_FETCH_METHOD) ||
      typeof pipe.channel !== 'string' ||
      !pipe.channel
    )
      return null;
    return pipe.channel;
  }

  async function probe(signal) {
    const endpointInfo = readEndpoint();
    if (!endpointInfo) return 'not_available';
    const result = await withConnection(
      endpointInfo,
      async (session) => ({
        ok: true,
        status: (await getPipe(session)) ? 'ready' : 'method_unavailable',
      }),
      signal,
      Math.min(timeoutMs, 1000)
    );
    return result.status;
  }

  async function requestOnce(normalized, signal) {
    if (signal?.aborted) return { result: { ok: false, status: 'cancelled' }, dispatched: false };
    if (!permitted()) return { result: { ok: false, status: 'unauthorized' }, dispatched: false };
    const endpointInfo = readEndpoint();
    if (!endpointInfo) return { result: { ok: false, status: 'not_available' }, dispatched: false };
    let dispatched = false;
    const result = await withConnection(
      endpointInfo,
      async (session) => {
        const channel = await getPipe(session);
        if (!channel) return { ok: false, status: 'method_unavailable' };
        if (signal?.aborted) return { ok: false, status: 'cancelled' };
        // Pipe discovery and authentication are asynchronous. A private recovery
        // request must revalidate its pinned authorization at the actual fetch.
        if (!permitted()) return { ok: false, status: 'unauthorized' };
        dispatched = true;
        const response = await session.call(
          `${channel}/${WB_REQUEST_FETCH_METHOD}`,
          normalized,
          'call'
        );
        if (!permitted()) return { ok: false, status: 'unauthorized' };
        return {
          ok: true,
          status: Number(response && response.status),
          headers:
            response && response.headers && typeof response.headers === 'object'
              ? response.headers
              : {},
          body: decodeBody(response && response.body_b64),
        };
      },
      signal
    );
    return { result, dispatched };
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

  function withConnection(endpointInfo, fn, signal, connectionTimeoutMs = timeoutMs) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, status: 'cancelled' });
        return;
      }
      let socket;
      try {
        socket = connect(endpointInfo.endpoint);
      } catch (_error) {
        resolve({
          ok: false,
          status: 'connection_error',
          error: 'WorkBuddy WBIPC connection failed',
        });
        return;
      }
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
        signal?.removeEventListener('abort', onAbort);
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
      const onAbort = () => finish({ ok: false, status: 'cancelled' });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

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
        connectionTimeoutMs
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
