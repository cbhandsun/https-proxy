'use strict';

const { Response, Headers, fetch: nativeFetch } = globalThis;
const { createRecoveryHistory } = require('./context-recovery-history');
const { CONTEXT_TARGET_HEADER, contextTargetToken } = require('../proxy/client-context-target');
const {
  MAX_HISTORY_BYTES,
  recoveryError,
  safeData,
  identity,
  isRecoveryFailure,
} = require('./context-recovery-data');

const MAX_ERROR_BYTES = 16 * 1024;

function localEndpoint(value) {
  if (typeof value !== 'string') throw recoveryError();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw recoveryError();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/v1/responses' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw recoveryError('invalid_client_recovery_target');
  return url.href;
}

function clientHeaders(value) {
  const data = safeData(value, 8192);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw recoveryError();
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });
  for (const [name, content] of Object.entries(data)) {
    if (
      !['authorization', 'x-api-key'].includes(name.toLowerCase()) ||
      typeof content !== 'string' ||
      [...content].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126
      )
    )
      throw recoveryError();
    headers.set(name, content);
  }
  return headers;
}

async function readError(response) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), payload: null };
  const chunks = [];
  let bytes = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(recoveryError('client_recovery_error_timeout')), 5000);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) throw recoveryError('client_recovery_error_too_large');
      chunks.push(Buffer.from(result.value));
    }
    const buffer = Buffer.concat(chunks);
    let payload = null;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch {
      /* Not a recovery contract. */
    }
    return { bytes: buffer, payload };
  } finally {
    clearTimeout(timer);
    // Cancellation is cleanup, not a retry trigger; never report private stream errors.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function createContextRecoveryClient({
  enabled = false,
  endpoint,
  model,
  owner,
  threadId,
  targetBinding,
  headers = {},
  fetchImpl = nativeFetch,
  maxHistoryBytes = MAX_HISTORY_BYTES,
} = {}) {
  if (
    typeof enabled !== 'boolean' ||
    !identity(model) ||
    !identity(owner) ||
    !identity(threadId) ||
    typeof fetchImpl !== 'function' ||
    !Number.isSafeInteger(maxHistoryBytes) ||
    maxHistoryBytes < 1 ||
    maxHistoryBytes > MAX_HISTORY_BYTES
  )
    throw recoveryError();
  const target = localEndpoint(endpoint);
  const requestHeaders = clientHeaders(headers);
  let targetToken;
  if (enabled) {
    const binding = safeData(targetBinding, 4096);
    if (binding?.owner !== owner || binding?.provider !== 'workbuddy-wbipc')
      throw recoveryError('client_recovery_target_mismatch');
    try {
      targetToken = contextTargetToken(binding);
    } catch {
      throw recoveryError('client_recovery_target_mismatch');
    }
    requestHeaders.set(CONTEXT_TARGET_HEADER, targetToken);
  }
  const history = createRecoveryHistory({ maxBytes: maxHistoryBytes });
  let closed = false;

  function requestData(request) {
    if (closed) throw recoveryError('client_recovery_closed');
    const data = safeData(request, maxHistoryBytes);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.model !== model)
      throw recoveryError('client_recovery_target_mismatch');
    return data;
  }

  async function dispatch(body, signal) {
    if (closed) throw recoveryError('client_recovery_closed');
    if (signal?.aborted) throw recoveryError('client_recovery_cancelled');
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: new Headers(requestHeaders),
        body: JSON.stringify(body),
        signal,
        redirect: 'manual',
        credentials: 'omit',
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw recoveryError('client_recovery_redirect_refused');
      }
      return response;
    } catch (error) {
      if (error?.code === 'client_recovery_redirect_refused') throw error;
      throw recoveryError(
        signal?.aborted ? 'client_recovery_cancelled' : 'client_recovery_transport_failed'
      );
    }
  }

  return {
    capture(value = {}) {
      if (!enabled) throw recoveryError('client_recovery_disabled');
      const data = safeData(value, maxHistoryBytes * 2 + 4096);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw recoveryError();
      const { request, originalInput, complete } = data;
      return history.capture(requestData(request), originalInput, complete);
    },
    async send(request, { history: handle, signal } = {}) {
      const body = requestData(request);
      if (handle !== undefined && !enabled) throw recoveryError('client_recovery_disabled');
      const original = handle === undefined ? null : history.acquire(handle, body);
      try {
        const first = await dispatch(body, signal);
        // A successful SSE/body is returned untouched. Never retry after output or tools.
        if (
          !enabled ||
          !original ||
          ![400, 502].includes(first.status) ||
          !/^application\/json(?:\s*;|$)/i.test(first.headers.get('content-type') || '')
        )
          return first;
        let errorBody;
        try {
          errorBody = await readError(first);
        } catch (error) {
          if (signal?.aborted) throw recoveryError('client_recovery_cancelled');
          if (
            ['client_recovery_error_timeout', 'client_recovery_error_too_large'].includes(
              error?.code
            )
          )
            throw error;
          throw recoveryError('client_recovery_transport_failed');
        }
        if (
          !isRecoveryFailure(first.status, errorBody.payload) ||
          first.headers.get(CONTEXT_TARGET_HEADER) !== targetToken
        )
          return new Response(errorBody.bytes, { status: first.status, headers: first.headers });
        const rebuilt = { ...body, input: original() };
        delete rebuilt.previous_response_id;
        safeData(rebuilt, maxHistoryBytes);
        // No external-tool executor exists; no policy/model/target change and no loop.
        return await dispatch(rebuilt, signal);
      } finally {
        if (handle !== undefined) history.release(handle);
      }
    },
    discard(handle) {
      history.discard(handle);
    },
    close() {
      closed = true;
      history.close();
    },
  };
}

module.exports = { createContextRecoveryClient };
