'use strict';

const MAX_FALLBACK_TRIGGER_BODY_CHARS = 4096;
const OPENCLAW_INTERNAL_CONTEXT_START = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>';
const OPENCLAW_INTERNAL_CONTEXT_END = '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>';

function isOpenClawInternalContextText(value) {
  const text = String(value || '');
  return (
    text.includes(OPENCLAW_INTERNAL_CONTEXT_START) || text.includes(OPENCLAW_INTERNAL_CONTEXT_END)
  );
}

function stripChannelMessageEnvelope(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  if (!text.includes('[message_id:') && !text.includes('Conversation info:')) return text;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      line.startsWith('[') ||
      line.startsWith('{') ||
      line.startsWith('}') ||
      line.startsWith('```') ||
      line.includes('Conversation info:')
    ) {
      continue;
    }
    const match = line.match(/^[^:：]{1,160}[:：]\s*(.+)$/);
    if (match && match[1].trim()) return match[1].trim();
    return line;
  }
  return text;
}

function responseContentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(responseContentText).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.content != null) return responseContentText(value.content);
  return '';
}

function latestResponseContentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const text = latestResponseContentText(value[index]);
      if (text.trim()) return text;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  if (value.content != null) {
    const text = latestResponseContentText(value.content);
    if (text.trim()) return text;
  }
  if (typeof value.text === 'string') return value.text;
  if (value.input != null) {
    const text = latestResponseContentText(value.input);
    if (text.trim()) return text;
  }
  if (value.message != null) {
    const text = latestResponseContentText(value.message);
    if (text.trim()) return text;
  }
  return '';
}

function latestUserInput(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return input;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (typeof item === 'string') {
      if (item.trim()) return item;
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').toLowerCase();
    const role = String(item.role || '').toLowerCase();
    if (
      role === 'user' ||
      type === 'input_text' ||
      (type === 'message' && (!role || role === 'user'))
    ) {
      const source = item.content != null ? item.content : item;
      const text = latestResponseContentText(source) || responseContentText(source);
      if (!text.trim() || isOpenClawInternalContextText(text)) continue;
      return stripChannelMessageEnvelope(text);
    }
  }
  return input;
}

function createNativeRetryWebSearchFallbackBody(parsed) {
  return {
    ...parsed,
    __managedWebSearchFallbackMode: 'native_retry',
    __managedWebSearchNativeRetry: true,
  };
}

function createNoToolWebSearchFallbackBody(parsed) {
  const body = {
    ...parsed,
    input: latestUserInput(parsed && parsed.input),
    __disableManagedWebSearchPromotion: true,
    __managedWebSearchFallbackMode: 'current_input_no_tools',
  };
  delete body.tools;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  delete body.previous_response_id;
  return body;
}

function preparedFromBody(prepared, body, fallbackMode) {
  return {
    ...prepared,
    fallbackMode,
    buffer: Buffer.from(JSON.stringify(body)),
  };
}

function createManagedWebSearchFallbackPrepared(chatBody, parsed, prepared) {
  if (
    !Array.isArray(chatBody?.__managedWebSearchFallback) ||
    chatBody.__managedWebSearchFallback.length !== 1 ||
    parsed?.__disableManagedWebSearchPromotion === true
  ) {
    return null;
  }
  if (parsed?.__managedWebSearchNativeRetry === true) {
    return preparedFromBody(
      prepared,
      createNoToolWebSearchFallbackBody(parsed),
      'current_input_no_tools'
    );
  }
  return preparedFromBody(prepared, createNativeRetryWebSearchFallbackBody(parsed), 'native_retry');
}

function isManagedWebSearchFallbackStatus(statusCode) {
  const status = Number(statusCode);
  return (
    Number.isInteger(status) &&
    (status === 400 ||
      status === 404 ||
      status === 409 ||
      status === 422 ||
      status === 429 ||
      status >= 500)
  );
}

function scheduleManagedWebSearchFallback({
  proxyRes,
  fallbackPrepared,
  clientRes,
  retry,
  onFallback,
} = {}) {
  if (
    !fallbackPrepared ||
    !proxyRes ||
    !isManagedWebSearchFallbackStatus(proxyRes.statusCode) ||
    typeof retry !== 'function'
  ) {
    return false;
  }
  let responseBody = '';
  proxyRes.on('data', (chunk) => {
    if (responseBody.length >= MAX_FALLBACK_TRIGGER_BODY_CHARS) return;
    responseBody += String(chunk || '').slice(
      0,
      Math.max(0, MAX_FALLBACK_TRIGGER_BODY_CHARS - responseBody.length)
    );
  });
  proxyRes.resume();
  proxyRes.once('end', () => {
    if (clientRes?.headersSent || clientRes?.destroyed) return;
    if (typeof onFallback === 'function') {
      const trigger = {
        statusCode: proxyRes.statusCode,
        responseBody,
        headers: proxyRes.headers || {},
      };
      if (typeof fallbackPrepared.fallbackMode === 'string') {
        trigger.fallbackMode = fallbackPrepared.fallbackMode;
      }
      onFallback(trigger);
    }
    retry(fallbackPrepared);
  });
  return true;
}

function createManagedWebSearchFallbackContext(
  chatBody,
  parsed,
  prepared,
  retryHandler,
  handlerArguments,
  options = {}
) {
  const fallbackPrepared = createManagedWebSearchFallbackPrepared(chatBody, parsed, prepared);
  if (!fallbackPrepared || typeof retryHandler !== 'function') return null;
  const retryArguments = Array.from(handlerArguments || []);
  retryArguments[2] = fallbackPrepared;
  return {
    fallbackPrepared,
    onFallback: options.onFallback,
    retry() {
      retryHandler(...retryArguments);
    },
  };
}

function retryManagedWebSearch(proxyRes, context, clientRes) {
  return scheduleManagedWebSearchFallback({
    proxyRes,
    fallbackPrepared: context?.fallbackPrepared,
    clientRes,
    retry: context?.retry,
    onFallback: context?.onFallback,
  });
}

function createGeminiRequestHeaders(apiKey, contentLength, userAgent = '') {
  const headers = { 'content-type': 'application/json', 'content-length': contentLength };
  if (userAgent) headers['user-agent'] = userAgent;
  if (apiKey) {
    if (String(apiKey).startsWith('ya29.')) headers.authorization = `Bearer ${apiKey}`;
    else headers['x-goog-api-key'] = apiKey;
  }
  return headers;
}

module.exports = {
  createGeminiRequestHeaders,
  context: createManagedWebSearchFallbackContext,
  createManagedWebSearchFallbackPrepared,
  createNoToolWebSearchFallbackBody,
  latestUserInput,
  isManagedWebSearchFallbackStatus,
  headers: createGeminiRequestHeaders,
  retry: retryManagedWebSearch,
  scheduleManagedWebSearchFallback,
};
