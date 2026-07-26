const { createLogger } = require('./logger');

const safeLog = createLogger('models');

function localModelIds(modelRoutes) {
  return Array.from(
    new Set(
      (Array.isArray(modelRoutes) ? modelRoutes : [])
        .map((route) => route && route.from)
        .filter(Boolean)
    )
  ).sort();
}

function localModelRoutes(modelRoutes) {
  const byId = new Map();
  for (const route of Array.isArray(modelRoutes) ? modelRoutes : []) {
    if (!route || !route.from || byId.has(route.from)) continue;
    byId.set(route.from, route);
  }
  return Array.from(byId.values()).sort((left, right) =>
    String(left.from).localeCompare(String(right.from))
  );
}

const CLIENT_PROTOCOLS = ['claude', 'openai-chat', 'openai-responses'];

function normalizeClientProtocol(value) {
  const protocol = String(value || '')
    .trim()
    .toLowerCase();
  if (protocol === 'openai' || protocol === 'chat' || protocol === 'chat-completions')
    return 'openai-chat';
  if (protocol === 'responses' || protocol === 'response' || protocol === 'openai-response')
    return 'openai-responses';
  if (CLIENT_PROTOCOLS.includes(protocol)) return protocol;
  return '';
}

function normalizeClientProtocols(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(new Set(values.map(normalizeClientProtocol).filter(Boolean)));
}

function inferredClientProtocolsForModel(modelId) {
  const id = String(modelId || '').trim();
  const lower = id.toLowerCase();
  if (!id) return [];
  if (lower.startsWith('claude-')) return ['claude'];
  if (
    lower.startsWith('gpt-') ||
    lower.startsWith('o') ||
    lower.startsWith('codex/') ||
    lower.startsWith('deepseek') ||
    lower.startsWith('kimi') ||
    lower.startsWith('minimax') ||
    lower.startsWith('gemini-') ||
    lower.startsWith('trae/') ||
    lower === 'default'
  ) {
    return ['openai-chat', 'openai-responses'];
  }
  return ['openai-chat', 'openai-responses'];
}

function clientProtocolsForRoute(route) {
  const explicit = normalizeClientProtocols(route && route.clientProtocols);
  return explicit.length ? explicit : inferredClientProtocolsForModel(route && route.from);
}

function routeSupportsClientProtocol(route, clientProtocol) {
  const protocol = normalizeClientProtocol(clientProtocol);
  if (!protocol) return true;
  return clientProtocolsForRoute(route).includes(protocol);
}

function localModelRoutesForClientProtocol(modelRoutes, clientProtocol) {
  return localModelRoutes(modelRoutes).filter((route) =>
    routeSupportsClientProtocol(route, clientProtocol)
  );
}

function buildLocalOpenAIModelObject(id) {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'local-proxy',
    root: id,
    parent: null,
    permission: [],
  };
}

function buildLocalClaudeModelObject(id, route) {
  const item = {
    id,
    type: 'model',
    display_name: route && route.labelOverride ? route.labelOverride : id,
    created_at: '1970-01-01T00:00:00.000Z',
  };
  if (route && route.supports1m) item.supports1m = true;
  return item;
}

function buildLocalModelsResponse(modelRoutes, format, clientProtocol) {
  const routes = localModelRoutesForClientProtocol(modelRoutes, clientProtocol);
  const ids = routes.map((route) => route.from);
  if (format === 'claude') {
    return {
      data: routes.map((route) => buildLocalClaudeModelObject(route.from, route)),
      has_more: false,
      first_id: ids[0] || null,
      last_id: ids[ids.length - 1] || null,
    };
  }
  return {
    object: 'list',
    data: ids.map(buildLocalOpenAIModelObject),
  };
}

function wantsClaudeModelsResponse(headers) {
  return Boolean(
    headers && (headers['anthropic-version'] || headers['anthropic-beta'] || headers['x-api-key'])
  );
}

function parseModelsRequestPath(urlPath) {
  const pathname = String(urlPath || '')
    .split('?')[0]
    .replace(/\/+$/, '');
  const normalized = pathname.indexOf('/v1') === 0 ? pathname : '/v1' + (pathname || '/');
  if (normalized === '/v1/models') return { kind: 'list' };
  if (normalized.indexOf('/v1/models/') === 0) {
    const id = decodeURIComponent(normalized.slice('/v1/models/'.length));
    if (id) return { kind: 'retrieve', id };
  }
  return null;
}

function handleModelsRequest(
  clientReq,
  clientRes,
  requestInfo,
  modelRoutes,
  forcedFormat,
  clientProtocol
) {
  const routes = localModelRoutesForClientProtocol(modelRoutes, clientProtocol);
  const ids = routes.map((route) => route.from);
  const format =
    forcedFormat || (wantsClaudeModelsResponse(clientReq.headers) ? 'claude' : 'openai');
  let status = 200;
  let body;
  if (requestInfo.kind === 'retrieve') {
    const route = routes.find((item) => item && item.from === requestInfo.id);
    if (route) {
      body =
        format === 'claude'
          ? buildLocalClaudeModelObject(requestInfo.id, route)
          : buildLocalOpenAIModelObject(requestInfo.id);
    } else {
      status = 404;
      body = {
        error: {
          message: `Model '${requestInfo.id}' not found`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      };
    }
  } else {
    body = buildLocalModelsResponse(modelRoutes, format, clientProtocol);
  }
  const text = JSON.stringify(body);
  clientRes.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  if (clientReq.method === 'HEAD') clientRes.end();
  else clientRes.end(text);
  safeLog.info(
    'ok ' +
      clientReq.method +
      ' ' +
      clientReq.url +
      '  -> ' +
      status +
      ' (local ' +
      format +
      ' models, ' +
      ids.length +
      ' models)'
  );
  return { status, format, modelCount: ids.length };
}

module.exports = {
  localModelIds,
  localModelRoutes,
  CLIENT_PROTOCOLS,
  normalizeClientProtocol,
  normalizeClientProtocols,
  inferredClientProtocolsForModel,
  clientProtocolsForRoute,
  routeSupportsClientProtocol,
  localModelRoutesForClientProtocol,
  buildLocalOpenAIModelObject,
  buildLocalClaudeModelObject,
  buildLocalModelsResponse,
  wantsClaudeModelsResponse,
  parseModelsRequestPath,
  handleModelsRequest,
};
