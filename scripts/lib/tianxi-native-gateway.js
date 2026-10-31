'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { AbortController } = globalThis;
const { writeResult } = require('./tianxi-native-responses-server');
const { MODELS, createTianxiNativeGatewaySessions } = require('./tianxi-native-gateway-sessions');

function createTianxiNativeGateway({ token, run, catalog }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new Error('tianxi_native_token_invalid');
  let admission;
  const sessions = createTianxiNativeGatewaySessions({
    run,
    onCatalog(value) {
      admission = value;
    },
  });
  const expected = Buffer.from('Bearer ' + token);
  let closing;
  const failures = [];
  let requests = 0;
  let shape;
  const server = http.createServer(async (req, res) => {
    const received = Buffer.from(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
    );
    if (
      req.headers.origin ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    res.setHeader('cache-control', 'no-store');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') {
      json(200, {
        ok: true,
        pid: process.pid,
        mode: 'tianxi-native-client-tools',
        models: MODELS,
        requests,
        failures,
        shape,
        admission,
      });
      return;
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === '/v1/models') {
      json(
        200,
        catalog || {
          object: 'list',
          data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'tianxi' })),
        }
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      json(404, { error: { code: 'tianxi_native_endpoint_unsupported' } });
      return;
    }
    if (req.headers['content-encoding']) {
      json(400, { error: { code: 'tianxi_native_encoding_unsupported' } });
      return;
    }
    const controller = new AbortController();
    const closed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', closed);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('tianxi_native_body_limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests++;
      const tools = [
        ...(Array.isArray(body?.tools) ? body.tools : []),
        ...(Array.isArray(body?.input)
          ? body.input
              .filter((item) => item?.type === 'additional_tools')
              .flatMap((item) => (Array.isArray(item.tools) ? item.tools : []))
          : []),
      ];
      const children = tools.flatMap((tool) =>
        tool?.type === 'namespace' && Array.isArray(tool.tools) ? tool.tools : [tool]
      );
      shape = {
        tools: children.length,
        functionTools: children.filter((tool) => tool?.type === 'function').length,
        customTools: children.filter((tool) => tool?.type === 'custom').length,
        otherTools: children.filter((tool) => !['function', 'custom'].includes(tool?.type)).length,
        largestDescription: children.reduce(
          (size, tool) =>
            Math.max(size, typeof tool?.description === 'string' ? tool.description.length : 0),
          0
        ),
        inputItems: Array.isArray(body?.input) ? body.input.length : 0,
        instructionsChars: typeof body?.instructions === 'string' ? body.instructions.length : 0,
        missingDescriptions: children.filter((tool) => typeof tool?.description !== 'string')
          .length,
        invalidCallers: children.filter(
          (tool) =>
            Array.isArray(tool?.allowed_callers) &&
            tool.allowed_callers.some((caller) => !['direct', 'programmatic'].includes(caller))
        ).length,
        missingSchemas: children.filter(
          (tool) => tool?.type === 'function' && tool.parameters?.type !== 'object'
        ).length,
        textCharsByRole: Object.fromEntries(
          ['system', 'developer', 'user', 'assistant'].map((role) => [
            role,
            (Array.isArray(body?.input) ? body.input : [])
              .filter((item) => item?.role === role)
              .reduce(
                (size, item) =>
                  size +
                  (typeof item.content === 'string'
                    ? item.content.length
                    : Array.isArray(item.content)
                      ? item.content.reduce(
                          (n, part) => n + (typeof part?.text === 'string' ? part.text.length : 0),
                          0
                        )
                      : 0),
                0
              ),
          ])
        ),
      };
      const sessionId = req.headers.session_id;
      if (
        sessionId !== undefined &&
        (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
      )
        throw new Error('tianxi_native_request_invalid');
      const owner = sessionId ? token + ':' + sessionId : token;
      const result = await sessions.request(body, owner, controller.signal);
      if (result.error && failures.length < 32) failures.push(result.error.code);
      if (res.destroyed) return;
      if (body.stream) res.writeHead(200, { 'content-type': 'text/event-stream' });
      writeResult(res, result, body.stream);
    } catch (error) {
      const allowed = [
        'tianxi_native_capacity',
        'tianxi_native_feature_unsupported',
        'tianxi_native_continuation_not_found',
        'tianxi_native_catalog_changed',
        'tianxi_native_body_limit',
        'tianxi_native_initial_history_unsupported',
        'tianxi_native_grammar_unsupported',
        'tianxi_native_catalog_invalid',
        'tianxi_native_docs_invalid',
        'tianxi_native_docs_contract_changed',
      ];
      const code = allowed.includes(error?.message)
        ? error.message
        : 'tianxi_native_request_invalid';
      if (failures.length < 32) failures.push(code);
      if (!res.destroyed && !res.headersSent)
        json(code === 'tianxi_native_capacity' ? 429 : 400, {
          error: { code, message: 'Tianxi native request rejected.' },
        });
      else if (!res.destroyed) res.destroy();
    } finally {
      res.removeListener('close', closed);
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  const timer = setInterval(() => sessions.sweep(), 30000);
  timer.unref();
  return {
    server,
    close() {
      closing ??= (async () => {
        clearInterval(timer);
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await sessions.close();
        await stopped;
      })();
      return closing;
    },
  };
}
module.exports = { createTianxiNativeGateway };
