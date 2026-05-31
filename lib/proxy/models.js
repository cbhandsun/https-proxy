function localModelIds(modelRoutes) {
  return Array.from(new Set((Array.isArray(modelRoutes) ? modelRoutes : []).map((route) => route && route.from).filter(Boolean))).sort();
}

function localModelRoutes(modelRoutes) {
  const byId = new Map();
  for (const route of Array.isArray(modelRoutes) ? modelRoutes : []) {
    if (!route || !route.from || byId.has(route.from)) continue;
    byId.set(route.from, route);
  }
  return Array.from(byId.values()).sort((left, right) => String(left.from).localeCompare(String(right.from)));
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

function buildLocalModelsResponse(modelRoutes, format) {
  const routes = localModelRoutes(modelRoutes);
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
  return Boolean(headers && (headers['anthropic-version'] || headers['anthropic-beta'] || headers['x-api-key']));
}

function parseModelsRequestPath(urlPath) {
  const pathname = String(urlPath || '').split('?')[0].replace(/\/+$/, '');
  const normalized = pathname.indexOf('/v1') === 0 ? pathname : '/v1' + (pathname || '/');
  if (normalized === '/v1/models') return { kind: 'list' };
  if (normalized.indexOf('/v1/models/') === 0) {
    const id = decodeURIComponent(normalized.slice('/v1/models/'.length));
    if (id) return { kind: 'retrieve', id };
  }
  return null;
}

function handleModelsRequest(clientReq, clientRes, requestInfo, modelRoutes, forcedFormat) {
  const ids = localModelIds(modelRoutes);
  const format = forcedFormat || (wantsClaudeModelsResponse(clientReq.headers) ? 'claude' : 'openai');
  let status = 200;
  let body;
  if (requestInfo.kind === 'retrieve') {
    const route = (Array.isArray(modelRoutes) ? modelRoutes : []).find((item) => item && item.from === requestInfo.id);
    if (route) {
      body = format === 'claude' ? buildLocalClaudeModelObject(requestInfo.id, route) : buildLocalOpenAIModelObject(requestInfo.id);
    } else {
      status = 404;
      body = { error: { message: `Model '${requestInfo.id}' not found`, type: 'invalid_request_error', code: 'model_not_found' } };
    }
  } else {
    body = buildLocalModelsResponse(modelRoutes, format);
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
  console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> ' + status + ' (local ' + format + ' models, ' + ids.length + ' models)');
}

module.exports = {
  localModelIds,
  localModelRoutes,
  buildLocalOpenAIModelObject,
  buildLocalClaudeModelObject,
  buildLocalModelsResponse,
  wantsClaudeModelsResponse,
  parseModelsRequestPath,
  handleModelsRequest,
};
