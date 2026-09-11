'use strict';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isResponseStreamingForced(config) {
  return !!(config && config.appSettings && config.appSettings.forceResponseStreaming === true);
}

function responseStreamingRolloutPercent(config) {
  const value = Number(
    config && config.appSettings ? config.appSettings.responseStreamingRolloutPercent : 0
  );
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function stablePercentageBucket(value) {
  const input = String(value || '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10000;
}

function isResponseStreamingEnabled(config, selectionKey) {
  if (isResponseStreamingForced(config)) return true;
  const percent = responseStreamingRolloutPercent(config);
  if (percent <= 0 || !selectionKey) return false;
  if (percent >= 100) return true;
  return stablePercentageBucket(selectionKey) < Math.round(percent * 100);
}

function isChatStreamingForced(config) {
  return !!(config && config.appSettings && config.appSettings.forceChatStreaming === true);
}

function jsonRequestStreamingPreference(prepared, requestEncoding) {
  if (!prepared || requestEncoding || !Buffer.isBuffer(prepared.buffer)) return null;
  try {
    const body = JSON.parse(prepared.buffer.toString('utf8'));
    if (!isPlainObject(body)) return null;
    return body.stream === true;
  } catch (_error) {
    return null;
  }
}

function applyJsonStreamingPolicy(
  prepared,
  { enabled, requestMatches, requestEncoding, marker } = {}
) {
  if (!prepared || enabled !== true || requestMatches !== true || requestEncoding) {
    return prepared;
  }
  if (!Buffer.isBuffer(prepared.buffer)) return prepared;

  try {
    const body = JSON.parse(prepared.buffer.toString('utf8'));
    if (!isPlainObject(body) || body.stream === true) return prepared;
    body.stream = true;
    return {
      ...prepared,
      buffer: Buffer.from(JSON.stringify(body)),
      bodyChanged: true,
      [marker]: true,
    };
  } catch (_error) {
    return prepared;
  }
}

function applyResponseStreamingPolicy(
  prepared,
  { enabled, isResponsesRequest, requestEncoding } = {}
) {
  return applyJsonStreamingPolicy(prepared, {
    enabled,
    requestMatches: isResponsesRequest,
    requestEncoding,
    marker: 'forcedResponseStreaming',
  });
}

function applyChatStreamingPolicy(prepared, { enabled, isChatRequest, requestEncoding } = {}) {
  return applyJsonStreamingPolicy(prepared, {
    enabled,
    requestMatches: isChatRequest,
    requestEncoding,
    marker: 'forcedChatStreaming',
  });
}

module.exports = {
  applyChatStreamingPolicy,
  applyResponseStreamingPolicy,
  isChatStreamingForced,
  jsonRequestStreamingPreference,
  isResponseStreamingEnabled,
  isResponseStreamingForced,
  responseStreamingRolloutPercent,
  stablePercentageBucket,
};
