'use strict';

const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { AbortController, TextDecoder } = globalThis;
const { AgyError, MAX_BODY_BYTES, MODELS, parseChatRequest } = require('./agy-chat-request');

function authorized(value, token) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    const fail = () => finish(new AgyError('agy_incomplete_request', 400));
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(new AgyError('agy_request_too_large', 413));
        req.resume();
      } else parts.push(chunk);
    };
    const end = () => {
      try {
        const value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
        );
        finish(null, value);
      } catch {
        finish(new AgyError('agy_invalid_json', 400));
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

function createAgyBridgeServer({ runtime, token, onRequest = () => {} }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/.test(token)) {
    throw new AgyError('agy_bridge_token_invalid', 500);
  }
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    const id = randomUUID();
    res.setHeader('x-request-id', id);
    res.setHeader('cache-control', 'no-store');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return send(403, { error: { type: 'agy_loopback_only' } });
    }
    // No browser cross-origin access, even with a stolen bearer credential.
    if (req.headers.origin) return send(403, { error: { type: 'agy_origin_not_allowed' } });
    if (!authorized(req.headers.authorization, token))
      return send(401, { error: { type: 'authentication_error' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, {
        object: 'list',
        data: MODELS.map((model) => ({ id: model, object: 'model', owned_by: 'agy-cli' })),
      });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
      return send(404, { error: { type: 'not_found' } });
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
      return send(415, { error: { type: 'agy_json_required' } });
    }
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', cancel);
    // IncomingMessage emits aborted before its subsequent error on truncation.
    // Keep a listener through close, even after the body reader has rejected.
    req.on('error', cancel);
    req.once('close', () => req.off('error', cancel));
    req.on('aborted', cancel);
    let parsed,
      started = false;
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${id}`;
    const event = (body) => {
      if (res.destroyed) throw new AgyError('agy_canceled', 499);
      if (res.writableLength > 1024 * 1024) throw new AgyError('agy_slow_client', 503);
      if (!started) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'x-accel-buffering': 'no',
        });
        started = true;
      }
      res.write(`data: ${JSON.stringify(body)}\n\n`);
    };
    const chunk = (delta, finishReason = null) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: parsed.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    try {
      parsed = parseChatRequest(await readBody(req));
      let firstDelta = true;
      const result = await runtime.generate(parsed, {
        signal: controller.signal,
        onDelta: parsed.stream
          ? (text) => {
              if (!text) return;
              event(chunk({ ...(firstDelta ? { role: 'assistant' } : {}), content: text }));
              firstDelta = false;
            }
          : undefined,
      });
      if (controller.signal.aborted || res.destroyed) return;
      if (parsed.stream) {
        event(chunk({}, 'stop'));
        if (parsed.includeUsage) event({ ...chunk({}), choices: [], usage: result.usage });
        res.end('data: [DONE]\n\n');
      } else
        send(200, {
          id: completionId,
          object: 'chat.completion',
          created,
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: 'stop',
            },
          ],
          usage: result.usage,
        });
      onRequest({ requestId: id, status: 200, stream: parsed.stream });
    } catch (error) {
      const known = error instanceof AgyError ? error : new AgyError('agy_bridge_failed');
      const payload = {
        error: { type: known.code, code: known.code, message: known.code, upstream: 'agy-cli' },
      };
      if (!res.destroyed) {
        if (started) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          if (known.status === 413) res.setHeader('connection', 'close');
          send(known.status, payload);
        }
      }
      onRequest({ requestId: id, status: known.status, code: known.code });
    } finally {
      active.delete(controller);
      res.off('close', cancel);
      req.off('aborted', cancel);
    }
  });
  server.requestTimeout = 15000;
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

module.exports = { authorized, createAgyBridgeServer };
