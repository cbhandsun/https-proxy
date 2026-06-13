const {
  isClaudeMessagesPath,
  isOpenAIChatCompletionsPath,
  isOpenAIResponsesPath,
} = require('./routing');

function entryLabel(entry) {
  if (!entry) return 'claude';
  return entry.protocol || 'claude';
}

function modelsFormatForEntry(entry) {
  return entry && entry.protocol === 'claude' ? 'claude' : 'openai';
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

function isAllowedEntryPath(entry, method, clientPath) {
  if (!entry) return true;
  if (method !== 'POST') return false;
  if (forceClaudeEntry(entry)) {
    return (
      isClaudeMessagesPath(clientPath) || clientPath.indexOf('/v1/messages/count_tokens') === 0
    );
  }
  if (forceChatEntry(entry)) return isOpenAIChatCompletionsPath(clientPath);
  if (forceResponsesEntry(entry)) return isOpenAIResponsesPath(clientPath);
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
  entryLabel,
  modelsFormatForEntry,
  routesForEntry,
  forceClaudeEntry,
  forceChatEntry,
  forceResponsesEntry,
  sendEntryHealth,
  sendUnauthorizedClaudeDesktop,
  isPublicLocalManagementPath,
  isEntryHealthPath,
  isAllowedEntryPath,
  sendEntryPathError,
};
