'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { estimateTokensForValue } = require('./inline-media');
const { prepareRecoveryWbipcWindow } = require('./context-recovery-wbipc-window');
const { normalizeWorkBuddyToolHistory } = require('./workbuddy-tool-history');
const { validateHistory } = require('./context-recovery-conversion-guards');
const { createWorkBuddyWbipcClient } = require('./workbuddy-wbipc-client');
const {
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
} = require('./workbuddy-context-limits');

const failure = () => new Error('Recovery WBIPC dispatch failed');
const hasControl = (value) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function endpointSnapshot(readEndpoint) {
  const value = normalizeCompactionData(readEndpoint(), 16384);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'endpoint,ticket' ||
    ['endpoint', 'ticket'].some(
      (key) =>
        typeof value[key] !== 'string' ||
        !value[key].trim() ||
        value[key].trim() !== value[key] ||
        hasControl(value[key])
    )
  )
    throw failure();
  return value;
}

// Composition-only capability. No route handler, compactor, artifact loop or
// external tool executor is called here. Only owner-proven retained results may
// be projected; all other oversized windows are refused intact.
function createContextRecoveryWbipcDispatch({
  readEndpoint,
  authorized,
  path,
  model,
  connect,
  maxBodyBytes = DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
  maxInputTokens = DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  timeoutMs = 60000,
  historyFormat = 2,
  reference,
}) {
  if (
    typeof readEndpoint !== 'function' ||
    typeof authorized !== 'function' ||
    ![2, 3].includes(historyFormat) ||
    (reference !== undefined && typeof reference !== 'function') ||
    (connect !== undefined && typeof connect !== 'function') ||
    typeof model !== 'string' ||
    !model.trim() ||
    model.length > 256 ||
    hasControl(model) ||
    !['/chat/completions', '/v1/chat/completions', '/v2/chat/completions'].includes(path) ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > DEFAULT_WORKBUDDY_TARGET_BODY_BYTES ||
    !Number.isSafeInteger(maxInputTokens) ||
    maxInputTokens < 1 ||
    maxInputTokens > DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60000
  )
    throw failure();
  let pinned;
  try {
    if (authorized() !== true) throw failure();
    pinned = endpointSnapshot(readEndpoint);
  } catch {
    throw failure();
  }
  function permitted() {
    try {
      if (authorized() !== true) return false;
      const current = endpointSnapshot(readEndpoint);
      return current.endpoint === pinned.endpoint && current.ticket === pinned.ticket;
    } catch {
      return false;
    }
  }
  const client = createWorkBuddyWbipcClient({
    autoStart: false,
    readEndpoint: () => pinned,
    authorizeRequest: permitted,
    connect,
    timeoutMs,
  });
  return async (input, { signal } = {}) => {
    try {
      if (!(signal instanceof globalThis.AbortSignal) || signal.aborted || !permitted())
        throw failure();
      const body = prepareRecoveryWbipcWindow(input, {
        historyFormat,
        maxBodyBytes,
        maxInputTokens,
        reference,
      });
      if (
        !body ||
        Array.isArray(body) ||
        body.model !== model ||
        typeof body.stream !== 'boolean' ||
        !Array.isArray(body.messages) ||
        !body.messages.length ||
        estimateTokensForValue(body) > maxInputTokens
      )
        throw failure();
      validateHistory('chat', body);
      normalizeWorkBuddyToolHistory(body.messages, { repair: false });
      const result = await client.request(
        {
          method: 'POST',
          path,
          headers: {
            'content-type': 'application/json',
            accept: body.stream ? 'text/event-stream' : 'application/json',
          },
          body: Buffer.from(JSON.stringify(body)),
        },
        { signal }
      );
      if (signal.aborted || !permitted()) throw failure();
      const safe = normalizeCompactionData(result, MAX_WIRE_BYTES);
      if (
        safe?.ok !== true ||
        safe.status !== 200 ||
        typeof safe.body !== 'string' ||
        !safe.body.length ||
        ![undefined, 'identity'].includes(safe.headers?.['content-encoding'])
      )
        throw failure();
      const contentType = safe.headers?.['content-type'] ?? '';
      if (typeof contentType !== 'string') throw failure();
      return {
        statusCode: 200,
        wire: Buffer.from(safe.body),
        stream:
          contentType.includes('text/event-stream') ||
          (!contentType && /^(?:event:|data:)/.test(safe.body.trimStart())),
      };
    } catch {
      // Neither endpoint tickets, user content nor raw IPC exceptions escape.
      throw failure();
    }
  };
}

module.exports = { createContextRecoveryWbipcDispatch };
