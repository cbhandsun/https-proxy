const {
  isClaudeMessagesPath,
  isOpenAIChatCompletionsPath,
  isOpenAIImageJobsCollectionPath,
  isOpenAIImagesGenerationsPath,
  isOpenAIInputTokensPath,
  isOpenAIResponsesPath,
  parseOpenAIImageJobId,
} = require('./routing');
const { isAnthropicTokenCountPath } = require('./anthropic-context-management');
const { isResponsesCompactionPath } = require('./native-responses-compaction');

const PUBLIC_ENTRY_HEALTH_PATH = '/v1/.well-known/hpm-health';

// Codex qualifies its native backend by the configured URL shape. This exact
// POST alias lets a Responses gateway retain that shape without bypassing entry
// authentication, model routing, or upstream request/response contracts.
function normalizeNativeCodexEntryPath(entry, method, clientPath) {
  if (!forceResponsesEntry(entry) || method !== 'POST' || typeof clientPath !== 'string')
    return clientPath;
  const queryIndex = clientPath.indexOf('?');
  const pathname = queryIndex < 0 ? clientPath : clientPath.slice(0, queryIndex);
  if (pathname !== '/backend-api/codex/responses') return clientPath;
  return '/v1/responses' + (queryIndex < 0 ? '' : clientPath.slice(queryIndex));
}

function entryLabel(entry) {
  if (!entry) return 'claude';
  return entry.protocol || 'claude';
}

function modelsFormatForEntry(entry) {
  return forceClaudeEntry(entry) ? 'claude' : 'openai';
}

function routesForEntry(entry, desktopRequest, routes = {}) {
  return desktopRequest || (entry && entry.protocol === 'claude-desktop')
    ? routes.claudeDesktopRoutes || []
    : routes.modelRoutes || [];
}

function forceClaudeEntry(entry) {
  return entry && (entry.protocol === 'claude' || entry.protocol === 'claude-desktop');
}

function forceChatEntry(entry) {
  return entry && entry.protocol === 'openai-chat';
}

function forceResponsesEntry(entry) {
  return entry && entry.protocol === 'openai-responses';
}

function sendEntryHealth(clientRes, entry, method, clientPath) {
  const body = JSON.stringify({
    ok: true,
    object: 'local.entry',
    protocol: entryLabel(entry),
    path: clientPath,
  });
  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': method === 'HEAD' ? 0 : Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(method === 'HEAD' ? undefined : body);
}

function isPublicEntryHealthPath(method, clientPath) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return String(clientPath || '').split('?')[0] === PUBLIC_ENTRY_HEALTH_PATH;
}

function sendPublicEntryHealth(clientRes, entry, method) {
  const body = JSON.stringify({
    ok: true,
    appId: 'https-proxy-manager',
    ready: true,
    entryProtocol: entryLabel(entry),
  });
  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': method === 'HEAD' ? 0 : Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-HPM-Proxy': 'https-proxy-manager',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  });
  clientRes.end(method === 'HEAD' ? undefined : body);
}

function sendUnauthorizedClaudeDesktop(clientRes) {
  clientRes.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(
    JSON.stringify({
      error: {
        type: 'authentication_error',
        message: 'Claude Desktop gateway request is missing or using an invalid token.',
      },
    })
  );
}

function isPublicLocalManagementPath(pathname) {
  const normalized = String(pathname || '').split('?')[0];
  return normalized === '/v1/local/health' || normalized === '/local/health';
}

function isEntryHealthPath(entry, method, clientPath) {
  if (!entry || (method !== 'GET' && method !== 'HEAD')) return false;
  if (forceClaudeEntry(entry)) return isClaudeMessagesPath(clientPath);
  if (forceChatEntry(entry)) return isOpenAIChatCompletionsPath(clientPath);
  if (forceResponsesEntry(entry)) return isOpenAIResponsesPath(clientPath);
  return false;
}

function isEntryModelsPath(method, clientPath) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = String(clientPath || '').split('?')[0];
  return pathname === '/v1/models' || pathname.indexOf('/v1/models/') === 0;
}

function isAllowedEntryPath(entry, method, clientPath) {
  if (!entry) return true;
  if (isEntryModelsPath(method, clientPath)) return true;
  if (forceClaudeEntry(entry)) {
    if (method !== 'POST') return false;
    return isClaudeMessagesPath(clientPath) || isAnthropicTokenCountPath(clientPath);
  }
  if (forceChatEntry(entry)) {
    const imageJobId = parseOpenAIImageJobId(clientPath);
    return (
      (method === 'POST' &&
        (isOpenAIChatCompletionsPath(clientPath) ||
          isOpenAIImagesGenerationsPath(clientPath) ||
          isOpenAIImageJobsCollectionPath(clientPath))) ||
      ((method === 'GET' || method === 'DELETE') && Boolean(imageJobId))
    );
  }
  if (forceResponsesEntry(entry)) {
    return (
      method === 'POST' &&
      (isOpenAIResponsesPath(clientPath) ||
        isOpenAIInputTokensPath(clientPath) ||
        isResponsesCompactionPath(clientPath))
    );
  }
  return true;
}

function sendEntryPathError(clientRes, entry, method, clientPath) {
  clientRes.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(
    JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message:
          'Path ' +
          method +
          ' ' +
          clientPath +
          ' is not supported by ' +
          entryLabel(entry) +
          ' entry',
      },
    })
  );
}

module.exports = {
  normalizeNativeCodexEntryPath,
  entryLabel,
  modelsFormatForEntry,
  routesForEntry,
  forceClaudeEntry,
  forceChatEntry,
  forceResponsesEntry,
  sendEntryHealth,
  isPublicEntryHealthPath,
  sendPublicEntryHealth,
  sendUnauthorizedClaudeDesktop,
  isPublicLocalManagementPath,
  isEntryHealthPath,
  isEntryModelsPath,
  isAllowedEntryPath,
  sendEntryPathError,
};
