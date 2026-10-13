'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { collectLimitedRequestBody, inspectContentLength } = require('./request-utils');
const { EVIDENCE_TOKEN_HEADER } = require('./context-api-evidence-runtime');

const PREFIX = '/v1/context-evidence/';
const MAX_BODY_BYTES = 16384;
// Ordinary inference and rejected evidence requests must not load the MCP SDK.
function loadMcpSdk() {
  return {
    ...require('@modelcontextprotocol/sdk/server/index.js'),
    ...require('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ...require('@modelcontextprotocol/sdk/types.js'),
  };
}
function evidenceToken(headers) {
  const descriptor = headers && Object.getOwnPropertyDescriptor(headers, EVIDENCE_TOKEN_HEADER);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function send(response, status, body) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}
function error(response, status, code) {
  send(response, status, { ok: false, error: code });
}

async function serveEvidenceMcp(request, response, body, capability, factories) {
  const release = capability.acquireObservation();
  if (!release) {
    error(response, 429, 'evidence_connection_busy');
    return;
  }
  let server;
  let transport;
  try {
    const { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } = loadMcpSdk();
    server = factories.createServer();
    transport = factories.createTransport();
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: capability.definitions.map((tool) => ({
        ...tool,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (call) => {
      if (call.params.task !== undefined)
        throw new McpError(ErrorCode.InvalidParams, 'evidence_task_mode_unsupported');
      const result = capability.reply(call.params.name, call.params.arguments ?? {});
      if (!result) throw new McpError(ErrorCode.InvalidParams, 'unknown_evidence_tool');
      return {
        isError: !result.ok,
        content: [
          { type: 'text', text: result.text ?? JSON.stringify({ ok: false, error: result.code }) },
        ],
      };
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch {
    capability.observationFailed();
    error(response, 500, 'evidence_transport_unavailable');
  } finally {
    try {
      if (server) await server.close();
    } catch {
      capability.observationFailed();
    }
    try {
      if (transport) await transport.close();
    } catch {
      capability.observationFailed();
    } finally {
      release();
    }
  }
}

// Same entry authentication and CORS as inference. No capture endpoint, session
// enumeration, token-in-URL support, user history reader, or executor is exposed.
function createContextApiEvidenceHttp(
  runtime,
  {
    createServer = () =>
      new (loadMcpSdk().Server)(
        { name: 'hpm-api-retained-evidence', version: '1.0.0' },
        { capabilities: { tools: {} } }
      ),
    createTransport = () =>
      new (loadMcpSdk().StreamableHTTPServerTransport)({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      }),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}
) {
  if (
    [createServer, createTransport, setTimer, clearTimer].some(
      (value) => typeof value !== 'function'
    )
  )
    throw new TypeError('Invalid evidence HTTP dependencies');
  return {
    handle(request, response, path, auth, enabled) {
      if (typeof path !== 'string' || !path.startsWith(PREFIX)) return false;
      const endpoint = path.slice(PREFIX.length);
      if (!enabled || !auth?.enabled || auth.ok !== true) {
        error(response, 404, 'evidence_endpoint_unavailable');
        return true;
      }
      if (
        !['session', 'mcp'].includes(endpoint) ||
        !['POST', 'DELETE'].includes(request.method) ||
        (endpoint === 'mcp' && request.method !== 'POST')
      ) {
        error(response, 404, 'evidence_endpoint_unavailable');
        return true;
      }
      const token = evidenceToken(request.headers);
      const capability = endpoint === 'mcp' ? runtime.bind(auth, token) : null;
      if (endpoint === 'mcp' && !capability) {
        error(response, 403, 'evidence_session_unavailable');
        return true;
      }
      if (request.method === 'DELETE') {
        const removed = runtime.remove(auth, token);
        send(response, removed ? 200 : 403, {
          ok: removed,
          ...(removed ? {} : { error: 'evidence_session_unavailable' }),
        });
        return true;
      }
      const contentLength = inspectContentLength(request.headers, MAX_BODY_BYTES);
      if (!contentLength.valid || contentLength.exceeds || request.headers['content-encoding']) {
        error(response, contentLength.exceeds ? 413 : 400, 'invalid_evidence_request');
        return true;
      }
      let abandoned = false;
      const timer = setTimer(() => {
        abandoned = true;
        error(response, 408, 'evidence_request_timeout');
        request.destroy();
      }, 10000);
      timer.unref();
      const clear = () => clearTimer(timer);
      const abort = () => {
        abandoned = true;
        clear();
      };
      request.once('error', abort);
      request.once('aborted', abort);
      response.once('close', abort);
      collectLimitedRequestBody(request, {
        limit: MAX_BODY_BYTES,
        onTooLarge() {
          abandoned = true;
          clear();
          error(response, 413, 'invalid_evidence_request');
        },
        onComplete({ tooLarge, buffer }) {
          clear();
          if (tooLarge || abandoned || response.destroyed || response.headersSent) return;
          let body;
          try {
            const text = buffer.toString('utf8');
            if (!Buffer.from(text).equals(buffer)) throw new TypeError('utf8');
            body = normalizeCompactionData(JSON.parse(text), MAX_BODY_BYTES);
            if (!body || Array.isArray(body) || typeof body !== 'object')
              throw new TypeError('body');
          } catch {
            error(response, 400, 'invalid_evidence_request');
            return;
          }
          if (endpoint === 'session') {
            if (Object.keys(body).length || token !== undefined) {
              error(response, 400, 'invalid_evidence_request');
              return;
            }
            const result = runtime.create(auth);
            send(response, result.ok ? 201 : 409, result);
          } else
            void serveEvidenceMcp(request, response, body, capability, {
              createServer,
              createTransport,
            }).catch(() => {
              capability.observationFailed();
              error(response, 500, 'evidence_transport_unavailable');
            });
        },
      });
      return true;
    },
  };
}

module.exports = { evidenceToken, createContextApiEvidenceHttp };
