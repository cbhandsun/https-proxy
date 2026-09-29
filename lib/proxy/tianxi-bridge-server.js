'use strict';

const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { AbortController, TextDecoder } = globalThis;
const {
  createFileTianxiNativeRuntime,
  createFixtureTianxiNativeRuntime,
  TianxiNativeRuntimeError,
} = require('./tianxi-native-runtime');
const { parseTianxiBridgeFramesPayload } = require('./tianxi-responses');
const { unsupportedTianxiResponsesFeature } = require('./tianxi-request-contract');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODELS = ['tianxi/super'];

class TianxiBridgeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'TianxiBridgeError';
    this.code = code;
    this.status = status;
  }
}

function tokenIsConfigured(token) {
  return typeof token === 'string' && token.length > 0;
}

function authorized(value, token) {
  if (!tokenIsConfigured(token)) return true;
  if (typeof value !== 'string' || value.length > 4096) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function boundedJsonSize(value) {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (_err) {
    throw new TianxiBridgeError('tianxi_bridge_invalid_payload');
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    const fail = () => finish(new TianxiBridgeError('tianxi_bridge_incomplete_request'));
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(new TianxiBridgeError('tianxi_bridge_request_too_large', 413));
        req.resume();
      } else {
        parts.push(chunk);
      }
    };
    const end = () => {
      try {
        const value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) || '{}'
        );
        finish(null, value);
      } catch (_err) {
        finish(new TianxiBridgeError('tianxi_bridge_invalid_json'));
      }
    };
    const finish = (error, value) => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', fail);
      req.off('aborted', fail);
      if (error) reject(error);
      else resolve(value);
    };
    req.on('data', data);
    req.on('end', end);
    req.on('error', fail);
    req.on('aborted', fail);
  });
}

function validateResponsesBridgePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TianxiBridgeError('tianxi_bridge_payload_object_required');
  }
  const unsupportedFeature = unsupportedTianxiResponsesFeature(value);
  if (unsupportedFeature) {
    throw new TianxiBridgeError(
      unsupportedFeature === 'input'
        ? 'tianxi_input_media_unsupported'
        : 'tianxi_tool_bridge_unsupported',
      422
    );
  }
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model || model.length > 128 || /[\0\r\n]/.test(model)) {
    throw new TianxiBridgeError('tianxi_bridge_model_invalid');
  }
  if (value.stream != null && typeof value.stream !== 'boolean') {
    throw new TianxiBridgeError('tianxi_bridge_stream_invalid');
  }
  if (value.instructions != null && typeof value.instructions !== 'string') {
    throw new TianxiBridgeError('tianxi_bridge_instructions_invalid');
  }
  if (typeof value.instructions === 'string' && value.instructions.length > 32768) {
    throw new TianxiBridgeError('tianxi_bridge_instructions_too_large', 413);
  }
  for (const [field, maxBytes] of [
    ['input', 1024 * 1024],
    ['chat', 2 * 1024 * 1024],
    ['metadata', 128 * 1024],
  ]) {
    if (boundedJsonSize(value[field], maxBytes) > maxBytes) {
      throw new TianxiBridgeError(`tianxi_bridge_${field}_too_large`, 413);
    }
  }
  return {
    model,
    input: value.input,
    instructions: value.instructions,
    stream: Boolean(value.stream),
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {},
    chat: value.chat && typeof value.chat === 'object' ? value.chat : null,
  };
}

function frameResultFromRuntime(result) {
  return parseTianxiBridgeFramesPayload(result);
}

function createTianxiBridgeServer({ runtime, token, onRequest = () => {} } = {}) {
  const bridgeRuntime = runtime || createFixtureTianxiNativeRuntime();
  if (!bridgeRuntime || typeof bridgeRuntime.sendResponses !== 'function') {
    throw new TianxiBridgeError('tianxi_bridge_runtime_invalid', 500);
  }
  const active = new Set();
  const models = Array.isArray(bridgeRuntime.models) ? bridgeRuntime.models : DEFAULT_MODELS;
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('cache-control', 'no-store');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return send(403, { error: { type: 'tianxi_bridge_loopback_only' } });
    }
    if (req.headers.origin) return send(403, { error: { type: 'tianxi_bridge_origin_denied' } });
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
      return send(200, { ok: true, upstream: 'tianxi', runtime: bridgeRuntime.name || 'custom' });
    }
    if (!authorized(req.headers.authorization, token)) {
      return send(401, { error: { type: 'authentication_error' } });
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, {
        object: 'list',
        data: models.map((model) => ({ id: model, object: 'model', owned_by: 'tianxi-bridge' })),
      });
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      return send(404, { error: { type: 'not_found' } });
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
      return send(415, { error: { type: 'tianxi_bridge_json_required' } });
    }
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', cancel);
    req.on('aborted', cancel);
    try {
      const payload = validateResponsesBridgePayload(await readJsonBody(req));
      const result = await bridgeRuntime.sendResponses(payload, { signal: controller.signal });
      if (controller.signal.aborted || res.destroyed) return;
      const frames = frameResultFromRuntime(result);
      send(200, { frames });
      onRequest({ requestId, status: 200, runtime: bridgeRuntime.name || 'custom' });
    } catch (error) {
      const known =
        error instanceof TianxiBridgeError || error instanceof TianxiNativeRuntimeError
          ? error
          : new TianxiBridgeError('tianxi_bridge_runtime_failed', 502);
      if (!res.destroyed) {
        if (known.status === 413) res.setHeader('connection', 'close');
        send(known.status, {
          error: {
            type: known.code,
            code: known.code,
            message: known.code,
            upstream: 'tianxi-bridge',
          },
        });
      }
      onRequest({ requestId, status: known.status, code: known.code });
    } finally {
      active.delete(controller);
      res.off('close', cancel);
      req.off('aborted', cancel);
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = {
  TianxiBridgeError,
  authorized,
  createFileTianxiBridgeRuntime: createFileTianxiNativeRuntime,
  createFixtureTianxiBridgeRuntime: createFixtureTianxiNativeRuntime,
  createTianxiBridgeServer,
  validateResponsesBridgePayload,
};
